import { randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import { DEFAULT_BAND_WEIGHTS, type Band, type JobPriority, type SendOrigin } from '@wp/domain';
import { provisioningRepo } from '../tenancy/index.js';

/**
 * messages.repo.ts (P11 Unit U3) - the ONE enqueue transaction (blueprint
 * Flow 1, [R-22]/[R-22w]): INSERT `message_jobs` (status='queued') + INSERT
 * `message_job_refs` (idempotency/dedupe authority) + INSERT
 * `delivery_event_ids` THEN `delivery_events` ('created', 'queued') +
 * one `audit_logs` row, all inside the ONE `withTenant` transaction the
 * caller (`messages.service.ts`) already opened. No ORM, no second write
 * path - every column this transaction touches is listed here, once.
 *
 * THE GOTCHA (phase file, verbatim; verified against the live DB):
 * `ON CONFLICT DO NOTHING` on `mjr_idem_uq` is a 5xx generator - the LOSER
 * of a concurrent duplicate gets no returned row and the caller would 500 on
 * a null `public_id`. This uses the no-op `DO UPDATE ... RETURNING` form
 * instead, so every caller (winner or loser) gets back the SAME existing
 * row.
 *
 * `mjr_idem_uq` is a PARTIAL UNIQUE INDEX (migration 0008), not a named
 * table constraint - `ON CONFLICT ON CONSTRAINT mjr_idem_uq` (the phase
 * file's literal wording) fails at the database with "constraint ... does
 * not exist" (verified live: Postgres only accepts `ON CONSTRAINT` for a
 * real constraint, never a partial unique index). The INDEX-INFERENCE form
 * below - `ON CONFLICT (client_id, idempotency_key) WHERE idempotency_key
 * IS NOT NULL` - is the one that actually matches the index and is what
 * this file uses.
 *
 * `priority_rank` is derived from `@wp/domain`'s `DEFAULT_BAND_WEIGHTS`
 * (the DWRR fairness module's own HIGH:NORMAL:LOW = 6:3:1 weight table) -
 * the single existing numeric weight-per-priority authority in this repo.
 * No second mapping is invented here.
 */

const PRIORITY_TO_BAND: Readonly<Record<JobPriority, Band>> = Object.freeze({
  high: 'HIGH',
  normal: 'NORMAL',
  low: 'LOW',
});

/** `message_jobs.priority_rank` - denormalized numeric weight, app-derived from `priority` via the DWRR band-weight table (see module doc comment). */
export function priorityRankFor(priority: JobPriority): number {
  return DEFAULT_BAND_WEIGHTS[PRIORITY_TO_BAND[priority]];
}

export interface EnqueueRecipient {
  jid: string;
  e164: string | null;
}

export interface EnqueueInput {
  clientId: string;
  instanceId: string;
  idempotencyKey: string;
  requestHash: Buffer;
  recipient: EnqueueRecipient;
  /** `message_jobs.recipient_hash` (migration 0007) - computed by the caller (`messages.service.ts`) via `hashRecipient`, never re-derived here. */
  recipientHash: Buffer;
  /**
   * `message_jobs.send_origin` (migration 0007) - a typed parameter threaded
   * from the caller, NEVER read from the request (`scripts/check-send-
   * origin.ts` clause (b) bans an `origin` client-input field; this column
   * is populated from a server-side literal only - the route binds
   * `'api_send'`).
   */
  sendOrigin: SendOrigin;
  payload: Record<string, unknown>;
  payloadKind: string;
  priority: JobPriority;
  scheduledAt: Date | null;
  actorUserId?: string | null;
}

export interface EnqueueResult {
  publicId: string;
  status: 'queued';
  /** `true` only when THIS call inserted the job (the ON CONFLICT branch never fired) - callers use this to decide whether to run the offline/unlinked-instance warning path again for a replay, and it is what the injected-failure test asserts zero rows for. */
  created: boolean;
  requestHash: Buffer | null;
}

interface JobIdRow extends Record<string, unknown> {
  id: string;
  created_at: Date;
}

interface RefRow extends Record<string, unknown> {
  public_id: string;
  request_hash: Buffer | null;
}

/**
 * Runs the full enqueue transaction against an already-tenant-scoped `tx`
 * (the caller's `withTenant` callback - see `messages.service.ts`). Returns
 * the durable job's `public_id` either way: freshly created, or the
 * pre-existing row a duplicate idempotency key resolved to (`created:
 * false`).
 */
export async function enqueueMessageJob(
  tx: TenantQueryable,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const priorityRank = priorityRankFor(input.priority);
  const publicId = randomUUID();

  // ONE statement for the job + ref INSERT pair (a CTE, not two round
  // trips): `message_jobs.created_at` never leaves Postgres and comes back
  // as a JS `Date` before being re-bound into `message_job_refs.message_
  // job_created_at` - the pg driver truncates a `timestamptz`'s microsecond
  // precision to JS `Date`'s millisecond precision, so re-binding a
  // round-tripped value into ANY later predicate or FK-shaped column
  // silently produces a value that no longer equality-matches the
  // original row (verified live: a join on `message_job_created_at =
  // created_at` using a round-tripped value matched zero rows against the
  // very row that produced it). `job` is a CTE here specifically so
  // `message_job_created_at` is bound from `job.created_at` INSIDE the
  // same statement, at full precision.
  const refResult = await tx.query<RefRow & JobIdRow>(
    `WITH job AS (
       INSERT INTO message_jobs
         (client_id, instance_id, recipient_jid, recipient_e164, recipient_hash, send_origin,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $11)
       RETURNING id, created_at
     ), ref AS (
       INSERT INTO message_job_refs
         (public_id, client_id, instance_id, message_job_id, message_job_created_at,
          idempotency_key, request_hash)
       SELECT $12, $1, $2, job.id, job.created_at, $13, $14 FROM job
       ON CONFLICT (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET public_id = message_job_refs.public_id
       RETURNING public_id, request_hash
     )
     SELECT job.id, job.created_at, ref.public_id, ref.request_hash FROM job, ref
     -- client_id = $1 (both message_jobs and message_job_refs inserts)`,
    [
      input.clientId,
      input.instanceId,
      input.recipient.jid,
      input.recipient.e164,
      input.recipientHash,
      input.sendOrigin,
      JSON.stringify(input.payload),
      input.payloadKind,
      input.priority,
      priorityRank,
      input.scheduledAt ?? new Date(),
      publicId,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  const row = refResult.rows[0];
  if (!row) {
    throw new Error('enqueueMessageJob: job/ref CTE returned no row');
  }
  const job = { id: row.id, created_at: row.created_at };

  const created = row.public_id === publicId;
  if (!created) {
    // The conflict branch fired: this call did NOT create a new job. Each
    // concurrent HTTP request runs its OWN `withTenant` transaction (there
    // is no shared, still-open transaction a plain "let it roll back on
    // throw" comment could rely on) - every one of them still COMMITS
    // normally unless something inside it throws, so the orphaned
    // message_jobs row this call just inserted would otherwise become a
    // second, real, unreferenced 'queued' job (exactly what mandatory test
    // 1's 50-parallel-POST race exists to catch). Delete it explicitly, in
    // the SAME transaction, before returning the pre-existing ref's id.
    // Matches on `id` (never `created_at` - see this function's own header
    // comment on why that can never safely round-trip back into a
    // predicate; `id` is `GENERATED ALWAYS AS IDENTITY`, globally unique
    // across every monthly partition on its own, so `id` alone still hits
    // exactly one row) plus `client_id` as defence in depth alongside RLS.
    await tx.query('DELETE FROM message_jobs WHERE id = $1 AND client_id = $2', [
      job.id,
      input.clientId,
    ]);
    return {
      publicId: row.public_id,
      status: 'queued',
      created: false,
      requestHash: row.request_hash,
    };
  }

  // Write order is normative (migration 0009 header): delivery_event_ids
  // FIRST, then delivery_events, same transaction - the first insert's PK
  // violation is what makes a duplicate a no-op. `detail` is omitted
  // (de_detail_size caps it at 250 bytes) - these two lifecycle events carry
  // no extra detail worth the bytes. `job.created_at` here is the value
  // `RETURNING` handed back on THIS same call (never re-bound into a WHERE
  // predicate) - safe for a plain INSERT column value, unlike the DELETE
  // match above.
  await tx.query(
    `INSERT INTO delivery_event_ids (provider_event_id, client_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4)
     -- client_id = $2`,
    [`enqueue:${publicId}:created`, input.clientId, job.id, job.created_at],
  );
  await tx.query(
    `INSERT INTO delivery_events
       (client_id, instance_id, message_job_id, message_job_created_at, event_type, provider_event_id)
     VALUES ($1, $2, $3, $4, 'created', $5)
     -- client_id = $1`,
    [input.clientId, input.instanceId, job.id, job.created_at, `enqueue:${publicId}:created`],
  );

  await tx.query(
    `INSERT INTO delivery_event_ids (provider_event_id, client_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4)
     -- client_id = $2`,
    [`enqueue:${publicId}:queued`, input.clientId, job.id, job.created_at],
  );
  await tx.query(
    `INSERT INTO delivery_events
       (client_id, instance_id, message_job_id, message_job_created_at, event_type, provider_event_id)
     VALUES ($1, $2, $3, $4, 'queued', $5)
     -- client_id = $1`,
    [input.clientId, input.instanceId, job.id, job.created_at, `enqueue:${publicId}:queued`],
  );

  await provisioningRepo.insertAuditLog(tx, {
    clientId: input.clientId,
    actorType: input.actorUserId ? 'user' : 'system',
    actorUserId: input.actorUserId ?? null,
    action: 'message.enqueued',
    targetType: 'message_job',
    targetId: publicId,
  });

  return { publicId, status: 'queued', created: true, requestHash: row.request_hash };
}

interface ExistingRefRow extends Record<string, unknown> {
  public_id: string;
  request_hash: Buffer | null;
}

/**
 * The idempotency-replay pre-check (P24 C2 fix round, Fix 2): reads the
 * existing `message_job_refs` row for `(client_id, idempotency_key)`, if
 * any, WITHOUT writing anything. `messages.service.ts` calls this BEFORE any
 * eligibility lookup (group send-enabled, opt-out) so a replay of an
 * already-enqueued key returns the ORIGINAL resource even if the recipient
 * has since become ineligible (api.md rule 2: duplicates return the
 * original resource) - `enqueueMessageJob`'s own `ON CONFLICT DO UPDATE`
 * branch already handles this for a genuinely concurrent race, but only
 * AFTER re-running every gate first; this lets a KNOWN replay skip them
 * entirely.
 */
export async function findExistingJobRef(
  tx: TenantQueryable,
  input: { clientId: string; idempotencyKey: string },
): Promise<{ publicId: string; requestHash: Buffer | null } | undefined> {
  const result = await tx.query<ExistingRefRow>(
    `SELECT public_id, request_hash FROM message_job_refs
      WHERE client_id = $1 AND idempotency_key = $2`,
    [input.clientId, input.idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { publicId: row.public_id, requestHash: row.request_hash } : undefined;
}

interface QueuedCountRow extends Record<string, unknown> {
  count: string;
}

/** Counts this instance's currently-`queued` jobs - the per-instance queue-depth cap check (`messages.service.ts`'s `MAX_QUEUED_JOBS_PER_INSTANCE`). */
export async function countQueuedJobsForInstance(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number> {
  const result = await tx.query<QueuedCountRow>(
    `SELECT count(*)::text AS count FROM message_jobs
      WHERE client_id = $1 AND instance_id = $2 AND status = 'queued'`,
    [clientId, instanceId],
  );
  return Number(result.rows[0]?.count ?? '0');
}
