import type { createPool } from '@wp/db';
import type {
  CapViolation,
  ClientUsageRow,
  LedgerRow,
  PacingStateRow,
} from '../../../../../scripts/measure/pacing-run.js';
import { findCapViolations } from '../../../../../scripts/measure/pacing-run.js';
import type { PacingRunJobs } from '../../../../../scripts/measure/pacing-run-artifact.js';

/**
 * run-pacing-collect.ts (P26 U5, step 5) - max-lines split off
 * `run-pacing.ts` (same idiom as `session-worker-discovery-wiring.ts`):
 * every ROW-BASED collection query (ledger/state/client-usage/job-status/
 * duplicate-acked-attempt counts - invariant 7, never a harness tally). The
 * two REAL-OPERATION latency samplers live in the sibling `run-pacing-
 * samplers.ts` (own max-lines split).
 */

/** Reads every `pacing_ledger` row for the given instance ids, mapped to `LedgerRow`. */
export async function collectLedgerRows(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<LedgerRow[]> {
  if (instanceIds.length === 0) return [];
  const result = await pool.query<{
    instance_id: string;
    client_id: string;
    ledger_date: string;
    consumed_count: number;
    sent_this_hour: number;
    hour_key: number;
    new_conv_count: number;
    group_sent_count: number;
  }>(
    `SELECT instance_id, client_id, ledger_date::text, consumed_count, sent_this_hour, hour_key,
            new_conv_count, group_sent_count
       FROM pacing_ledger WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds],
  );
  return result.rows.map((r) => ({
    instanceId: r.instance_id,
    clientId: r.client_id,
    ledgerDate: r.ledger_date,
    consumedCount: r.consumed_count,
    sentThisHour: r.sent_this_hour,
    hourKey: r.hour_key,
    newConvCount: r.new_conv_count,
    groupSentCount: r.group_sent_count,
  }));
}

/** Reads every `instance_pacing_state` row for the given instance ids, mapped to `PacingStateRow`. */
export async function collectPacingStateRows(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<PacingStateRow[]> {
  if (instanceIds.length === 0) return [];
  const result = await pool.query<{
    instance_id: string;
    client_id: string;
    eff_daily_cap: number;
    eff_hourly_cap: number;
    eff_new_conv_cap: number;
    eff_group_daily_cap: number;
  }>(
    `SELECT instance_id, client_id, eff_daily_cap, eff_hourly_cap, eff_new_conv_cap, eff_group_daily_cap
       FROM instance_pacing_state WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds],
  );
  return result.rows.map((r) => ({
    instanceId: r.instance_id,
    clientId: r.client_id,
    effDailyCap: r.eff_daily_cap,
    effHourlyCap: r.eff_hourly_cap,
    effNewConvCap: r.eff_new_conv_cap,
    effGroupDailyCap: r.eff_group_daily_cap,
  }));
}

/** Reads `client_daily_usage` for the given client ids, joined against `effective_client_limits`'s `max_daily_sends` (NULL cap = uncapped). */
export async function collectClientUsageRows(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<ClientUsageRow[]> {
  if (clientIds.length === 0) return [];
  const result = await pool.query<{ client_id: string; sent_count: number; cap: number | null }>(
    `SELECT cdu.client_id, cdu.sent_count,
            (SELECT limit_value FROM effective_client_limits
              WHERE client_id = cdu.client_id AND limit_key = 'max_daily_sends') AS cap
       FROM client_daily_usage cdu WHERE cdu.client_id = ANY($1)`,
    [clientIds],
  );
  return result.rows.map((r) => ({ clientId: r.client_id, sentCount: r.sent_count, cap: r.cap }));
}

/** Row-count-only tally of `message_jobs.status` for the given client ids (invariant 7 - never a harness tally). */
export async function collectJobCounts(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<
  Omit<
    PacingRunJobs,
    'enqueued' | 'duplicateAckedAttempts' | 'driverEnqueued' | 'ledgerRowCount'
  > & {
    enqueued: number;
  }
> {
  const counts = {
    enqueued: 0,
    sent: 0,
    stillQueued: 0,
    terminalFailed: 0,
    blockedNeedsReview: 0,
    cancelled: 0,
  };
  if (clientIds.length === 0) return counts;
  const result = await pool.query<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM message_jobs WHERE client_id = ANY($1) GROUP BY status',
    [clientIds],
  );
  for (const row of result.rows) {
    const n = Number(row.count);
    counts.enqueued += n;
    switch (row.status) {
      case 'sent':
        counts.sent += n;
        break;
      case 'failed':
        counts.terminalFailed += n;
        break;
      case 'blocked_needs_review':
        counts.blockedNeedsReview += n;
        break;
      case 'cancelled':
        counts.cancelled += n;
        break;
      case 'queued':
      case 'processing':
      case 'created':
      case 'needs_reconcile':
      default:
        counts.stillQueued += n;
        break;
    }
  }
  return counts;
}

/**
 * FIX-P26-H MAJOR B (2026-09-07): counts `send_attempts` rows in the
 * provider-acknowledged state (`state = 'acked'`) that share the same
 * `message_job_id` more than once, within the given client ids - the
 * duplicate-send proof (invariant 7), tenant-scoped by `client_id = ANY($1)`.
 *
 * THIS REPLACES `collectDuplicateWaIdCount` (grouped on `message_wa_ids.
 * message_id`), which was structurally near-zero: `message_wa_ids_
 * message_id_uq UNIQUE (client_id, instance_id, message_id)` (migration
 * 0026) forbids a second row for the same message_id outright, and the only
 * writer (`engine/queue/result.ts#resolveAck`) inserts with NO `ON CONFLICT`
 * clause - a collision raises `23505` and rolls back the whole transaction
 * rather than landing a duplicate row. So a real double-send (the same job
 * double-claimed and double-dispatched on its own instance) could never
 * produce a second `message_wa_ids` row to count.
 *
 * `send_attempts`'s own unique key is `(message_job_id, attempt_no)`
 * (migration 0008) - that does NOT forbid two DIFFERENT attempt numbers for
 * the same job both reaching `state = 'acked'`, which is exactly the
 * signal a genuine duplicate provider-acknowledged send leaves behind.
 *
 * HONEST SCOPE: `message_wa_ids_message_id_uq` already PREVENTS a duplicate
 * provider id per job at the storage layer (invariant 3); this measures a
 * DIFFERENT thing - how many jobs accumulated more than one acked attempt -
 * which is the real signal of a double-dispatch even though the unique
 * index stops it from ever producing two `message_wa_ids` rows.
 */
export async function collectDuplicateAckedAttemptCount(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<number> {
  if (clientIds.length === 0) return 0;
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT message_job_id FROM send_attempts
       WHERE client_id = ANY($1) AND state = 'acked'
       GROUP BY message_job_id HAVING count(*) > 1
     ) dupes`,
    [clientIds],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * `findCapViolations` wired directly against real collected rows -
 * re-exported here so `run-pacing.ts` need not import the scripts/ pure
 * module twice. Also returns `ledgerRowCount`: a cap scan over ZERO ledger
 * rows is never itself "zero violations" (CRITICAL 2(b)/MAJOR 3) - the
 * caller must be able to tell the two apart, so the row count travels with
 * the violations rather than being silently dropped.
 */
export async function collectCapViolations(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<{ violations: CapViolation[]; ledgerRowCount: number }> {
  const [ledger, state, clientUsage] = await Promise.all([
    collectLedgerRows(pool, instanceIds, clientIds),
    collectPacingStateRows(pool, instanceIds, clientIds),
    collectClientUsageRows(pool, clientIds),
  ]);
  return {
    violations: findCapViolations(ledger, state, clientUsage),
    ledgerRowCount: ledger.length,
  };
}
