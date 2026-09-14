import { TIMING } from '@wp/domain';
import { bindQueryParams, loadQuery } from '@wp/db';

/**
 * queue.repo.ts (P03 Unit B, step 6) - the canonical claim call, thin over
 * `db/queries/claim-jobs.sql` (see that file's own header comment for the
 * invariants it enforces). No ORM re-implementation, no second claim
 * variant - this module executes the loaded statement and maps its
 * RETURNING row, nothing else.
 *
 * SAFETY BOUNDARY (core-invariants + safety-compliance): no parameter,
 * column, flag, or "admin override" here may skip the fence/health/epoch/
 * client-status/wallet/campaign predicates - every one of those lives
 * inside claim-jobs.sql itself. This module adds no alternative ordering
 * and no created_at window "optimization" (that would strand far-future
 * scheduled jobs).
 */

/**
 * Minimal query surface `claimOne` needs - structurally compatible with
 * `pg.Pool` / `pg.Client` / `pg.PoolClient` (and any test stub), the same
 * pattern already used by `platform/db/assert-schema-version.ts`'s
 * `Queryable`. Callers pass whatever connection/transaction handle they
 * already hold; this module owns no connection lifecycle of its own.
 */
export interface QueueQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Minimal claim context - `client_id` plus a query executor. No single
 * established "ctx" type combining a tenant id with a query surface exists
 * yet in this repo: `@wp/server-kit`'s `TenantContext` carries `clientId`
 * but no query surface, and `@wp/db`'s `TenantDb.withTenant` carries a
 * `TenantQueryable` but only inside a callback (a transaction wrapper, not a
 * plain value ctx a repo function can accept directly). This is the minimal
 * `{clientId, sql-executor}` shape the task anticipated for that gap -
 * revisit once a real request-scoped ctx type lands.
 *
 * PRODUCTION HANDLE (P03 close, finding 5): real callers should build `sql`
 * from `TenantDb.withTenant` (`@wp/db`, `db/src/tenant-db.ts`) - it runs
 * `set_config('app.client_id', clientId, true)` before `fn` runs, every
 * time, which is what keeps a tenant-scoped role (e.g. `wp_scheduler`) from
 * silently seeing zero rows under RLS. A caller that instead hands in a raw
 * pool/connection without that GUC set gets an honest but silent
 * zero-claims-forever outcome under `wp_scheduler` - see
 * `claim_succeeds_under_wp_scheduler_role_with_tenant_guc` and
 * `claim_under_wp_scheduler_without_tenant_guc_returns_no_rows` in
 * `claim.integration.test.ts`. P06 is the phase that wires real workers to
 * `TenantDb.withTenant`, making that silent-empty mode structurally
 * impossible for production callers.
 */
export interface ClaimOneCtx {
  clientId: string;
  sql: QueueQueryable;
}

export interface ClaimOneInput {
  instanceId: string;
  /** Externally-chosen priority band (`message_jobs.priority_rank`) - never an absolute-priority scan across bands. */
  band: number;
  /** Must equal `instance_lease_state.current_fence` - proves the caller currently owns the session. */
  fence: number | bigint;
  workerId: string;
  claimExpiryMs: number;
}

export interface ClaimedJob {
  id: string;
  createdAt: Date;
  leaseId: string;
  instanceId: string;
  sessionEpoch: number;
  recipientJid: string;
  payload: unknown;
  payloadKind: string;
  attempts: number;
  campaignId: string | null;
  isNewConversation: boolean;
  /** `message_jobs.recipient_hash` (P14 Unit U4) - null for a pre-P14 row. */
  recipientHash: Buffer | null;
  /** `message_jobs.send_origin` (P14 Unit U4) - null for a pre-P14 row (callers default to `'api_send'`, see `send-loop-pacing-claim.ts`). */
  sendOrigin: string | null;
  /** `message_jobs.content_fingerprint` (P14 Unit U4) - null when content-guard fingerprinting has not run for this job. */
  contentFingerprint: Buffer | null;
  /**
   * The ORIGINAL pacing reserve's own bind values (P14 Unit U4) - set ONLY
   * by `send-loop-pacing-claim.ts#claimAndReserve` after a real GRANT
   * (never by `claimOne` itself, which has no pacing awareness). A later
   * post-commit refund (`engine/pacing/index.ts#release`) MUST use these
   * exact values, never re-derive them - see `release-pacing.sql`'s own
   * header. `undefined` for a caller that never went through
   * `claimAndReserve` (e.g. a claim-only test).
   */
  pacingReserve?: {
    ledgerDate: string;
    gapMs: number;
    isNewConversation: boolean;
    isGroup: boolean;
    /** The ORIGINAL reserve's own `isExempt` bind value (`isExemptOrigin(sendOrigin)`, Finding 9, P14 review-fix F2) - a later refund MUST use this exact value, never re-derive it. */
    isExempt: boolean;
  };
}

interface ClaimJobsRow extends Record<string, unknown> {
  id: string;
  created_at: Date;
  lease_id: string;
  instance_id: string;
  session_epoch: number;
  recipient_jid: string;
  payload: unknown;
  payload_kind: string;
  attempts: number;
  campaign_id: string | null;
  is_new_conversation: boolean;
  recipient_hash: Buffer | null;
  send_origin: string | null;
  content_fingerprint: Buffer | null;
}

/**
 * `claimExpiryMs` ceiling - 2x `TIMING.claimExpiryMs` (packages/domain/src/timing.ts)
 * headroom, not an independent constant. `TIMING.claimExpiryMs` (90s) is
 * load-bearing against `TIMING.sendTimeoutMs` (45s) via the ordering
 * `sendTimeoutMs < claimExpiryMs - reaperGraceMs` asserted in
 * `packages/domain/src/timing.test.ts` - a caller-supplied `claimExpiryMs`
 * this far past the canonical value would already be well outside the
 * window that ordering protects, so 2x is generous headroom for callers
 * that legitimately need a longer lease (e.g. slow provider batches), not
 * an invitation to approach it.
 */
const MAX_CLAIM_EXPIRY_MS = TIMING.claimExpiryMs * 2;

/**
 * Boundary validation (C1 WARNING, duplicate-send window): a `claimExpiryMs`
 * that is zero, negative, non-integer, or absurdly large would either lease
 * a job for effectively no time (a worker barely starts before the lease
 * looks stale, inviting a duplicate claim) or for far too long (a genuinely
 * dead worker's job sits unclaimable for that whole window) - both widen the
 * duplicate-send window this claim exists to close. Checked here, before
 * the query ever reaches the database - not something callers can be
 * trusted to validate themselves.
 *
 * FINDING-1 FIX (P13 C1 review): this used to also validate a caller-
 * supplied `ledgerDate` bound into `pacing_ledger_date` - removed along
 * with the field itself. `claim-jobs.sql` no longer sets that column at
 * all (see its own header, point 9); `pacing_ledger_date` is now written
 * back from `reserve-pacing.sql`'s own authoritative RETURNING `ledger_date`
 * by `send-loop-pacing-claim.ts#claimAndReserve`, in the same transaction,
 * immediately after a GRANT - never guessed in Node.
 */
function assertValidClaimBounds(input: ClaimOneInput): void {
  if (
    !Number.isInteger(input.claimExpiryMs) ||
    input.claimExpiryMs <= 0 ||
    input.claimExpiryMs > MAX_CLAIM_EXPIRY_MS
  ) {
    throw new Error(
      `claimOne: claimExpiryMs must be a positive integer no greater than ${String(MAX_CLAIM_EXPIRY_MS)} (2x TIMING.claimExpiryMs), got ${String(input.claimExpiryMs)}`,
    );
  }
}

function mapRow(row: ClaimJobsRow): ClaimedJob {
  return {
    id: row.id,
    createdAt: row.created_at,
    leaseId: row.lease_id,
    instanceId: row.instance_id,
    sessionEpoch: row.session_epoch,
    recipientJid: row.recipient_jid,
    payload: row.payload,
    payloadKind: row.payload_kind,
    attempts: row.attempts,
    campaignId: row.campaign_id,
    isNewConversation: row.is_new_conversation,
    recipientHash: row.recipient_hash,
    sendOrigin: row.send_origin,
    contentFingerprint: row.content_fingerprint,
  };
}

/**
 * Claims exactly one eligible job for `(ctx.clientId, input.instanceId)`
 * within `input.band`, via the single canonical claim statement
 * (`db/queries/claim-jobs.sql`). Zero eligible rows is a NORMAL outcome
 * (stale fence, non-connected health, epoch mismatch, suspended client,
 * missing/empty wallet, non-running campaign, or simply nothing queued) and
 * resolves to `undefined` - it never throws for "nothing to claim".
 */
export async function claimOne(
  ctx: ClaimOneCtx,
  input: ClaimOneInput,
): Promise<ClaimedJob | undefined> {
  assertValidClaimBounds(input);

  const query = await loadQuery('claim-jobs');
  const params = bindQueryParams(query, {
    client_id: ctx.clientId,
    instance_id: input.instanceId,
    band: input.band,
    fence: input.fence,
    worker: input.workerId,
    claim_expiry_ms: input.claimExpiryMs,
  });

  const result = await ctx.sql.query<ClaimJobsRow>(query.text, params);
  const row = result.rows[0];
  return row ? mapRow(row) : undefined;
}
