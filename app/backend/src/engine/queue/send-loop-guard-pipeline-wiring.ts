import { bindQueryParams, loadQuery, type TenantQueryable } from '@wp/db';
import type { GuardPipelineState } from '../../modules/pacing/guards/pipeline.js';

/**
 * send-loop-guard-pipeline-wiring.ts (P14 Unit U6, phase step 7) - the
 * guard-pipeline-specific reads/writes `claimAndReserve`
 * (`send-loop-pacing-claim.ts`) needs for the content-guard pipeline, split
 * out purely for that file's own max-lines cap (same established split
 * idiom as `session-worker-discovery-wiring.ts`).
 *
 * `readGuardPipelineState` widens `send-loop-pacing-claim.ts`'s original
 * `readPacingState` SELECT with the `pacing_profiles` join
 * `warmup-evaluator.ts#readSystemProfileLayer` already uses (same join, same
 * table, this unit's OWN read) to also surface `warmup_tier` and the four
 * content-guard thresholds (`dup_fanout_warn/ack`, `per_recipient_24h/7d`).
 * `localDate` is derived the SAME way `pacing-deny-reason.sql` derives its
 * own `ledger_date` - `(now() AT TIME ZONE pacing_timezone)::date` - so the
 * duplicate-fan-out guard's per-day bucket agrees with the instance's own
 * pacing calendar, never a Node-computed UTC date (the exact class of bug
 * `send-loop-pacing-claim.ts`'s own `writeLedgerDateToJob` doc comment
 * documents for `pacing_ledger_date`).
 */

interface GuardPipelineStateRow extends Record<string, unknown> {
  warmup_tier: number;
  local_date: string;
  dup_fanout_warn: number;
  dup_fanout_ack: number;
  per_recipient_24h: number;
  per_recipient_7d: number;
}

/**
 * Thrown by `readGuardPipelineState` when any of the four content-guard
 * thresholds (or `warmup_tier`) is non-finite or <= 0 (Finding 5, P14
 * review-fix F2). Migration 0040 now backs `per_recipient_24h/7d` and
 * `dup_fanout_warn/ack` with NOT NULL + CHECK(> 0) at the DB layer, but this
 * module fails closed independently rather than relying on the constraint
 * alone (defence in depth) - the claim pass ERRORS rather than evaluating a
 * job against an unusable/absent limit and silently sending it unguarded.
 */
export class GuardPipelineStateInvalidError extends Error {
  constructor(instanceId: string, field: string, value: unknown) {
    super(
      `readGuardPipelineState: instance ${instanceId} has an invalid ${field} (${JSON.stringify(value)}) - must be a finite number > 0`,
    );
    this.name = 'GuardPipelineStateInvalidError';
  }
}

/** `true` only for a finite number > 0 - the shared validity check every threshold/limit field below must pass. */
function isValidThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

const THRESHOLD_FIELDS = [
  'warmup_tier',
  'dup_fanout_warn',
  'dup_fanout_ack',
  'per_recipient_24h',
  'per_recipient_7d',
] as const;

/** Validates every threshold/limit field on a fetched row - throws `GuardPipelineStateInvalidError` naming the first invalid field, fail-closed (Finding 5). `warmup_tier` also must be > 0 (tier 0 does not exist - see `warmup-evaluator.ts`). */
function assertValidGuardPipelineRow(row: GuardPipelineStateRow, instanceId: string): void {
  for (const field of THRESHOLD_FIELDS) {
    if (!isValidThreshold(row[field])) {
      throw new GuardPipelineStateInvalidError(instanceId, field, row[field]);
    }
  }
}

export async function readGuardPipelineState(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<GuardPipelineState | undefined> {
  const result = await tx.query<GuardPipelineStateRow>(
    `SELECT s.warmup_tier,
            (now() AT TIME ZONE s.pacing_timezone)::date::text AS local_date,
            p.dup_fanout_warn, p.dup_fanout_ack, p.per_recipient_24h, p.per_recipient_7d
       FROM instance_pacing_state s
       JOIN pacing_profiles p ON p.key = s.profile_key
      WHERE s.instance_id = $1 AND s.client_id = $2`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  assertValidGuardPipelineRow(row, instanceId);
  return {
    warmupTier: row.warmup_tier,
    localDate: row.local_date,
    dupFanoutWarn: row.dup_fanout_warn,
    dupFanoutAck: row.dup_fanout_ack,
    perRecipient24h: row.per_recipient_24h,
    perRecipient7d: row.per_recipient_7d,
  };
}

export interface DisposeJobInput {
  id: string;
  clientId: string;
  leaseId: string;
  outcome: 'cancelled' | 'failed';
  reason: string;
}

/** Runs `dispose-job.sql`. Returns `true` only when the guarded UPDATE actually matched a row (claim not lost) - see that file's own claim-lost note. */
export async function disposeJob(tx: TenantQueryable, input: DisposeJobInput): Promise<boolean> {
  const query = await loadQuery('dispose-job');
  const params = bindQueryParams(query, {
    id: input.id,
    client_id: input.clientId,
    lease_id: input.leaseId,
    outcome: input.outcome,
    reason: input.reason,
  });
  const result = await tx.query(query.text, params);
  return result.rowCount === 1;
}

export interface DeferJobInput {
  id: string;
  clientId: string;
  reason: string;
  retryAt: Date;
  /** `defer-job.sql`'s `$lease_id` (C2 note, P14 review-fix F2) - the lease this job was claimed under; the WHERE clause now also matches `status = 'processing' AND lease_id = $lease_id`, symmetric with `dispose-job.sql`'s own lease guard. */
  leaseId: string;
}

/** Runs `defer-job.sql` - the single deferral write shared by the pacing-denial path AND the guard pipeline's own non-terminal path (see that file's own doc). Zero rows (the claim was already lost to another worker) is a normal outcome, never an error - same discipline as `disposeJob`. */
export async function deferJob(tx: TenantQueryable, input: DeferJobInput): Promise<void> {
  const query = await loadQuery('defer-job');
  const params = bindQueryParams(query, {
    id: input.id,
    client_id: input.clientId,
    retry_at: input.retryAt,
    reason: input.reason,
    lease_id: input.leaseId,
  });
  await tx.query(query.text, params);
}
