import type { TenantDb, TenantQueryable } from '@wp/db';
import { deliveryEventId, writeDeliveryEvent } from '../../engine/queue/delivery-event.js';
import type { QueueMetricsHandles } from '../../engine/queue/metrics.js';
import type { UnresolvedEvidenceRow } from './reconciler-decision.js';

/**
 * reconciler-resolve.ts (P12 Unit U3, step 6; C1 CRITICAL finding 3 fix) -
 * the resolve branch's DB-driving writer, split out of `reconciler.ts` at
 * the `max-lines` cap (the established sibling-module idiom - see
 * `engine/session/session-worker-discovery-wiring.ts`).
 *
 * `applyResolve` runs THREE checks, in order, all inside the SAME
 * `withTenant` transaction that eventually performs the assignment UPDATE -
 * the ordering matters and is deliberate:
 *
 * STEP 1 (finding 3(b)) - read the evidence row's CURRENT owner
 * (`message_id`) first, before deciding anything else:
 *   - equals THIS job's id -> our own earlier run already won this exact
 *     assignment (idempotent replay - two concurrent sweeps, or a retried
 *     tick). The remaining writes (`send_attempts`/`message_jobs`/delivery
 *     event) are themselves naturally idempotent (unconditional value-set,
 *     or `WHERE status = 'needs_reconcile'`/`ON CONFLICT DO NOTHING`), so
 *     this run proceeds through them rather than stopping mid-way with the
 *     job stranded in `needs_reconcile`. Checking ownership FIRST (rather
 *     than only after a failed assignment UPDATE) is what makes this branch
 *     correct: an already-resolved row necessarily fails the tolerance-
 *     window re-check below (it no longer has `message_id IS NULL`), so
 *     checking owner-first is the only way to distinguish "already ours"
 *     from "genuinely ambiguous".
 *   - belongs to a DIFFERENT job -> genuine ambiguity (two jobs raced for
 *     the same evidence row) - takes the ambiguous path from inside this
 *     transaction, never leaves the job untouched.
 *   - still unresolved (`message_id IS NULL`) -> falls through to step 2.
 *
 * STEP 2 (finding 3(a)) - the transactional AUTHORITY re-check:
 * `runOneReconcilerSweep`'s cross-tenant scan and its per-candidate
 * evidence lookup (`findToleranceEvidence`, also exported here and reused
 * by `reconciler.ts`) both run OUTSIDE any transaction, as a CHEAP
 * PRE-FILTER only (skip the transaction entirely for an obviously
 * `wait`/`expired` candidate) - never the authority. A real, expected event
 * (an echo replay racing the sweep) can insert a SECOND colliding evidence
 * row in the gap between that read and this write. `applyResolve` re-runs
 * `findToleranceEvidence` a SECOND time here, inside the transaction,
 * immediately before the assignment UPDATE - any mismatch (not exactly one
 * row, or a different row than the one the caller decided to resolve)
 * aborts to the ambiguous path from inside this same transaction, so the
 * abort and the "did we resolve" answer can never diverge.
 *
 * STEP 3 - the assignment UPDATE itself. A zero-row result here (raced
 * between step 1/2's reads and this UPDATE, within the same transaction's
 * snapshot window) re-resolves ownership with the SAME two-way check as
 * step 1, never left unresolved.
 */

export interface ApplyResolveDeps {
  tenantDb: TenantDb;
  metrics: Pick<QueueMetricsHandles, 'reconcileAmbiguousTotal'>;
  sink: { onRepairedSent(attemptId: string, clientId: string): Promise<void> };
  echoToleranceMs: number;
}

export interface ResolveCandidateRow {
  clientId: string;
  instanceId: string;
  messageJobId: string;
  messageJobCreatedAt: Date;
  sendAttemptId: string;
  sendAttemptNo: number;
  contentHash: Buffer;
  dispatchedAt: Date;
}

interface EvidenceRow extends Record<string, unknown> {
  wa_msg_id: string;
  observed_at: Date;
}

/** Unresolved (`message_id IS NULL`) evidence within tolerance, for `(clientId, instanceId, contentHash)` around `dispatchedAt`. Reused by `reconciler.ts`'s own pre-filter lookup and this module's in-transaction re-check. */
export async function findToleranceEvidence(
  tx: TenantQueryable,
  input: {
    clientId: string;
    instanceId: string;
    contentHash: Buffer;
    dispatchedAt: Date;
    toleranceMs: number;
  },
): Promise<UnresolvedEvidenceRow[]> {
  const result = await tx.query<EvidenceRow>(
    `SELECT wa_msg_id, observed_at
       FROM message_wa_ids
      WHERE client_id = $1 AND instance_id = $2 AND content_hash = $3 AND message_id IS NULL
        AND observed_at BETWEEN $4::timestamptz - ($5 * interval '1 ms')
                             AND $4::timestamptz + ($5 * interval '1 ms')
      -- client_id = $1`,
    [input.clientId, input.instanceId, input.contentHash, input.dispatchedAt, input.toleranceMs],
  );
  return result.rows.map((row) => ({ waMsgId: row.wa_msg_id, observedAt: row.observed_at }));
}

async function readPublicId(
  tx: TenantQueryable,
  clientId: string,
  jobId: string,
): Promise<string | undefined> {
  const result = await tx.query<{ public_id: string }>(
    `SELECT public_id FROM message_job_refs WHERE client_id = $1 AND message_job_id = $2`,
    [clientId, jobId],
  );
  return result.rows[0]?.public_id;
}

/** Writes `blocked_needs_review` + the ambiguous metric, from INSIDE an already-open tenant transaction (finding 3's abort path - never a separate `withTenant` call, so the abort and the resolve decision share one atomic outcome). */
async function writeAmbiguousInTx(
  tx: TenantQueryable,
  deps: Pick<ApplyResolveDeps, 'metrics'>,
  row: Pick<ResolveCandidateRow, 'messageJobId' | 'clientId'>,
): Promise<void> {
  await tx.query(
    `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
            unresolved_reason = 'ambiguous_echo_match', unresolved_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'needs_reconcile'`,
    [row.messageJobId, row.clientId],
  );
  deps.metrics.reconcileAmbiguousTotal.inc();
}

async function writeResolvedFields(
  tx: TenantQueryable,
  row: ResolveCandidateRow,
  evidence: { waMsgId: string; observedAt: Date },
): Promise<void> {
  await tx.query(
    `UPDATE send_attempts SET state = 'reconciled_sent', resolved_at = now()
      WHERE client_id = $1 AND id = $2`,
    [row.clientId, row.sendAttemptId],
  );
  await tx.query(
    `UPDATE message_jobs SET status = 'sent', sent_at = $1
      WHERE id = $2 AND client_id = $3 AND status = 'needs_reconcile'`,
    [evidence.observedAt, row.messageJobId, row.clientId],
  );

  const publicId = await readPublicId(tx, row.clientId, row.messageJobId);
  if (publicId) {
    await writeDeliveryEvent(tx, {
      clientId: row.clientId,
      instanceId: row.instanceId,
      messageJobId: row.messageJobId,
      messageJobCreatedAt: row.messageJobCreatedAt,
      eventType: 'reconciled',
      providerEventId: deliveryEventId(row.instanceId, publicId, 'reconciled', row.sendAttemptNo),
    });
  }
}

/**
 * Resolve branch, finding-3 hardened. `evidence` is the pre-filter's
 * candidate match - re-verified, never trusted, inside this function's own
 * transaction. See this module's own header for the full three-way
 * zero-row-race outcome.
 */
export async function applyResolve(
  deps: ApplyResolveDeps,
  row: ResolveCandidateRow,
  evidence: { waMsgId: string; observedAt: Date },
): Promise<void> {
  const resolved = await deps.tenantDb.withTenant(row.clientId, async (tx) => {
    // Finding 3(b) FIRST: check the specific evidence row's CURRENT owner
    // before deciding anything else - this is the only way to distinguish
    // "already resolved by our own earlier run" (proceed) from "resolved by
    // a different job" (ambiguous) from "still open" (fall through to the
    // finding-3(a) re-check below). Looking this up first, rather than
    // after a failed assignment UPDATE, means the own-replay case never
    // takes the ambiguous path just because its evidence row no longer
    // matches the general tolerance-window re-check (it is already
    // resolved, by definition, so it never would).
    const owner = await tx.query<{ message_id: string | null }>(
      `SELECT message_id FROM message_wa_ids
        WHERE client_id = $1 AND instance_id = $2 AND direction = 'out' AND wa_msg_id = $3
        -- client_id = $1`,
      [row.clientId, row.instanceId, evidence.waMsgId],
    );
    const ownerJobId = owner.rows[0]?.message_id ?? null;

    if (ownerJobId === row.messageJobId) {
      // Our OWN earlier run already won this exact assignment - an
      // idempotent replay (two concurrent sweeps, or a retried tick), not
      // an error. The remaining writes are themselves safe to repeat.
      await writeResolvedFields(tx, row, evidence);
      return true;
    }
    if (ownerJobId !== null) {
      // A DIFFERENT job already claimed this evidence row - genuine
      // ambiguity, fail safe, never leave this job stranded.
      await writeAmbiguousInTx(tx, deps, row);
      return false;
    }

    // Still unresolved: finding 3(a), the transactional AUTHORITY re-check,
    // immediately before the assignment UPDATE - never trust the pre-filter
    // snapshot `reconciler.ts`'s sweep loop took outside this transaction.
    const recheck = await findToleranceEvidence(tx, {
      clientId: row.clientId,
      instanceId: row.instanceId,
      contentHash: row.contentHash,
      dispatchedAt: row.dispatchedAt,
      toleranceMs: deps.echoToleranceMs,
    });
    const stillUnambiguous = recheck.length === 1 && recheck[0]?.waMsgId === evidence.waMsgId;
    if (!stillUnambiguous) {
      await writeAmbiguousInTx(tx, deps, row);
      return false;
    }

    const assign = await tx.query(
      `UPDATE message_wa_ids SET message_id = $1, message_created_at = $2
        WHERE client_id = $3 AND instance_id = $4 AND direction = 'out' AND wa_msg_id = $5 AND message_id IS NULL
        -- client_id = $3`,
      [row.messageJobId, row.messageJobCreatedAt, row.clientId, row.instanceId, evidence.waMsgId],
    );
    if (assign.rowCount === 0) {
      // Raced between the owner check above and this UPDATE, within the
      // SAME transaction's snapshot window - re-resolve who won, same
      // three-way logic, never left unresolved.
      const raced = await tx.query<{ message_id: string | null }>(
        `SELECT message_id FROM message_wa_ids
          WHERE client_id = $1 AND instance_id = $2 AND direction = 'out' AND wa_msg_id = $3
          -- client_id = $1`,
        [row.clientId, row.instanceId, evidence.waMsgId],
      );
      if (raced.rows[0]?.message_id !== row.messageJobId) {
        await writeAmbiguousInTx(tx, deps, row);
        return false;
      }
    }

    await writeResolvedFields(tx, row, evidence);
    return true;
  });

  if (resolved) {
    await deps.sink.onRepairedSent(row.sendAttemptId, row.clientId);
  }
}
