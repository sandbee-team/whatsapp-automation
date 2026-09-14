import type { TenantDb } from '@wp/db';
import { loadQuery, bindQueryParams } from '@wp/db';
import { logger } from '@wp/server-kit';
import type { QueueMetricsHandles } from '../../engine/queue/metrics.js';
import { notify } from '../notifications/index.js';
import { decideReconciliation, type ReconcileCandidate } from './reconciler-decision.js';
import { applyResolve, findToleranceEvidence } from './reconciler-resolve.js';

/**
 * reconciler.ts (P12 Unit U3, step 6; ADR 0035) - the echo reconciler's
 * DB-driving wrapper around the PURE decision core
 * (`reconciler-decision.ts#decideReconciliation`). For each `needs_reconcile`
 * job inside `TIMING.reconcileWindowMs`, matches unresolved evidence on
 * `(client_id, instance_id, content_hash)` within `TIMING.echoToleranceMs`,
 * 1:1 enforced by `message_wa_ids.message_id`'s partial unique index
 * (migration 0026) - the DB is the arbiter of a concurrent race, this module
 * never assumes it "won".
 *
 * The cross-tenant SCAN (`reconcile-unresolved.sql`, delegating to the
 * SECURITY DEFINER `wp_reconcile_scan_unresolved`, migration 0027 - C12
 * correction: `wp_scheduler` is not BYPASSRLS) is READ-ONLY. Every WRITE
 * this module makes stays on the normal per-tenant RLS path
 * (`tenantDb.withTenant`) - never through the definer function.
 *
 * **No automatic requeue exists in any branch** (core invariant 2, phase
 * file verbatim): `expired` writes `abandoned`/`blocked_needs_review`, never
 * `queued`. `status` is always a string LITERAL in every write below, never
 * a bind (`scripts/check-single-claim.ts`'s `PARAMETERIZED_STATUS_PATTERN`
 * flags any `SET status = $n` on `message_jobs`).
 *
 * C1 CRITICAL finding 3 correction: the `findToleranceEvidence` lookup in
 * the sweep loop below runs BEFORE any transaction and is a CHEAP
 * PRE-FILTER only - it decides whether to skip the transaction entirely for
 * an obviously `wait`/`expired` candidate. It is never the authority for
 * "is this match unambiguous". The resolve branch
 * (`reconciler-resolve.ts#applyResolve`) re-runs the SAME lookup a SECOND
 * time, INSIDE the transaction that performs the assignment UPDATE, and
 * that in-transaction read is what the decision actually trusts - see that
 * module's own header for the full fix (including the zero-row assignment
 * race's three-way outcome).
 */

export interface ReconcilerDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  metrics: Pick<QueueMetricsHandles, 'reconcileAmbiguousTotal'>;
  sink: { onRepairedSent(attemptId: string, clientId: string): Promise<void> };
  reconcileWindowMs: number;
  echoToleranceMs: number;
  /** Bounded batch size for the cross-tenant scan - never unbounded. */
  maxRows: number;
  now: () => number;
}

interface ScanRow extends Record<string, unknown> {
  client_id: string;
  instance_id: string;
  message_job_id: string;
  message_job_created_at: Date;
  unresolved_at: Date | null;
  send_attempt_id: string;
  send_attempt_no: number;
  content_hash: Buffer;
  dispatched_at: Date;
  sibling_inflight_count: number;
}

/**
 * Mandatory `unresolved_send` notify (P17 fix round F2, corrected) - called
 * INSIDE the SAME `withTenant` transaction as the blocked_needs_review
 * write, on the transition branch only (never on a zero-row no-op). This is
 * NOT the same as calling it after commit: `notify()` outside the
 * transaction is a lost-or-duplicated alert by the phase's own invariant - a
 * crash between the blocked_needs_review COMMIT and a separate post-commit
 * notify call would lose the mandatory alert PERMANENTLY (the conditional
 * `WHERE status = 'needs_reconcile'` never matches again once the row has
 * already transitioned). `transitionId` is the `message_job_id` - stable,
 * non-wall-clock, unique per job.
 *
 * FAIL-SAFE LAYERING (F5, same discipline as
 * `send-history-30d.ts#fetchSendHistory30dSafe`/`hard-signal-pause.ts`): a
 * notify failure (e.g. an oversized payload, or a real SQL error such as an
 * FK violation) must NEVER abort the transition write, which is itself the
 * fail-safe stop (core invariant 2). A tx rollback for any OTHER reason
 * still correctly rolls the notification back too, since it shares the one
 * transaction - there is no window where the two can diverge.
 *
 * SAVEPOINT, NOT A BARE TRY/CATCH (coordinator correction): catching the JS
 * exception alone is NOT enough - once one SQL statement inside a Postgres
 * transaction errors, the ENTIRE transaction is left ABORTED ("current
 * transaction is aborted, commands ignored until end of transaction block")
 * until a ROLLBACK or ROLLBACK TO SAVEPOINT runs; a plain try/catch around
 * `notify()` would let the JS call site continue, but the later `COMMIT`
 * from `withTenant` would silently no-op into a rollback, losing the
 * transition write too. `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` scopes the
 * failure to just the notify statement (same idiom as
 * `signup.service.ts`'s own slug-collision retry).
 */
async function notifyUnresolvedSendSafe(
  tx: Parameters<typeof notify>[0],
  row: Pick<ScanRow, 'client_id' | 'instance_id' | 'message_job_id'>,
): Promise<void> {
  await tx.query('SAVEPOINT unresolved_send_notify');
  try {
    await notify(tx, {
      clientId: row.client_id,
      instanceId: row.instance_id,
      kind: 'unresolved_send',
      transitionId: row.message_job_id,
      payload: { messageJobId: row.message_job_id },
      requiresUserAction: true,
    });
    await tx.query('RELEASE SAVEPOINT unresolved_send_notify');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT unresolved_send_notify');
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { client_id: row.client_id, instance_id: row.instance_id },
      `reconciler: unresolved_send notify failed for job ${row.message_job_id}, transition still committing: ${message}`,
    );
  }
}

/** Ambiguous branch: resolves NOTHING (core invariant 2) - both left/sent to blocked_needs_review. */
async function applyAmbiguous(deps: ReconcilerDeps, row: ScanRow): Promise<void> {
  await deps.tenantDb.withTenant(row.client_id, async (tx) => {
    const result = await tx.query(
      `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
              unresolved_reason = 'ambiguous_echo_match', unresolved_at = now()
        WHERE id = $1 AND client_id = $2 AND status = 'needs_reconcile'`,
      [row.message_job_id, row.client_id],
    );
    if ((result.rowCount ?? 0) > 0) {
      await notifyUnresolvedSendSafe(tx, row);
    }
  });
  deps.metrics.reconcileAmbiguousTotal.inc();
}

/** Expired branch: window exhausted with no evidence - abandoned/blocked_needs_review, NEVER queued (no automatic requeue, any branch). */
async function applyExpired(deps: ReconcilerDeps, row: ScanRow): Promise<void> {
  await deps.tenantDb.withTenant(row.client_id, async (tx) => {
    await tx.query(
      `UPDATE send_attempts SET state = 'abandoned', resolved_at = now()
        WHERE client_id = $1 AND id = $2`,
      [row.client_id, row.send_attempt_id],
    );
    const result = await tx.query(
      `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
              unresolved_reason = 'no_echo_evidence', unresolved_at = now()
        WHERE id = $1 AND client_id = $2 AND status = 'needs_reconcile'`,
      [row.message_job_id, row.client_id],
    );
    if ((result.rowCount ?? 0) > 0) {
      await notifyUnresolvedSendSafe(tx, row);
    }
  });
}

/**
 * `wp_reconcile_scan_unresolved`'s `p_window_seconds` EXCLUDES any attempt
 * whose `dispatched_at` is already older than the window (migration 0027's
 * own header: rows past that boundary are "the caller's concern reading
 * `unresolved_at`, not this scan"). If the SQL scan window equalled
 * `deps.reconcileWindowMs` exactly, a candidate would silently drop OUT of
 * every future scan the instant it expired - never resolved, never marked
 * `abandoned`, invisible forever. So the SQL scan window is deliberately
 * WIDER (2x) than the true decision window - `decideReconciliation`'s own
 * `reconcileWindowMs` comparison remains the single source of truth for
 * "expired", this multiplier only keeps an expired row visible long enough
 * to be swept into that decision at least once.
 */
const SCAN_WINDOW_MULTIPLIER = 2;

/** Runs one reconciler sweep: scans (cross-tenant, read-only), then decides+writes each candidate (per-tenant, RLS-scoped). Bounded by `deps.maxRows`; zero candidates is a normal outcome. */
export async function runOneReconcilerSweep(deps: ReconcilerDeps): Promise<void> {
  const query = await loadQuery('reconcile-unresolved');
  const params = bindQueryParams(query, {
    window_seconds: Math.floor((deps.reconcileWindowMs * SCAN_WINDOW_MULTIPLIER) / 1000),
    tolerance_seconds: Math.floor(deps.echoToleranceMs / 1000),
    max_rows: deps.maxRows,
  });
  const scan = await deps.pool.query<ScanRow>(query.text, params);

  for (const row of scan.rows) {
    const evidenceRows = await deps.tenantDb.withTenant(row.client_id, (tx) =>
      findToleranceEvidence(tx, {
        clientId: row.client_id,
        instanceId: row.instance_id,
        contentHash: row.content_hash,
        dispatchedAt: row.dispatched_at,
        toleranceMs: deps.echoToleranceMs,
      }),
    );

    const candidate: ReconcileCandidate = {
      clientId: row.client_id,
      instanceId: row.instance_id,
      contentHash: row.content_hash,
      dispatchedAt: row.dispatched_at,
      siblingInflightCount: row.sibling_inflight_count,
    };

    const outcome = decideReconciliation({
      candidate,
      evidenceRows,
      nowMs: deps.now(),
      reconcileWindowMs: deps.reconcileWindowMs,
    });

    if (outcome.kind === 'resolve') {
      await applyResolve(
        deps,
        {
          clientId: row.client_id,
          instanceId: row.instance_id,
          messageJobId: row.message_job_id,
          messageJobCreatedAt: row.message_job_created_at,
          sendAttemptId: row.send_attempt_id,
          sendAttemptNo: row.send_attempt_no,
          contentHash: row.content_hash,
          dispatchedAt: row.dispatched_at,
        },
        { waMsgId: outcome.evidenceWaMsgId, observedAt: outcome.evidenceObservedAt },
      );
    } else if (outcome.kind === 'ambiguous') {
      await applyAmbiguous(deps, row);
    } else if (outcome.kind === 'expired') {
      await applyExpired(deps, row);
    }
    // 'wait': no-op this cycle, a later sweep may find the echo.
  }
}
