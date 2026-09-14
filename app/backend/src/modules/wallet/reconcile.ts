import { bindQueryParams, loadNamedQuery, type TenantDb } from '@wp/db';
import { describeError } from '@wp/server-kit';
import {
  chargeRepairedSend,
  insertFinding,
  resolveAttemptPrice,
  runCheckA,
  runCheckC,
  runCheckDForDay,
  runCheckE,
  type ReconcileLogger,
  type WalletReconcilePool,
} from './reconcile-checks.js';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';

/**
 * reconcile.ts (P18 Unit U8b) - the wallet reconciler sweep's TypeScript
 * orchestration, wired over `db/queries/wallet-reconcile.sql`'s five
 * cross-tenant checks (A-E). Checks A/C/D/E (read-only findings) live in
 * `reconcile-checks.ts`; check B (the only check that may WRITE money) stays
 * here, next to the sweep's own ordering.
 *
 * Every cross-tenant READ goes through `deps.pool.query` (the SECURITY
 * DEFINER functions bypass RLS); every WRITE (finding insert, correction) is
 * per tenant via `deps.tenantDb.withTenant`, as `wp_app`, under the normal
 * RLS path - never cross-tenant. A per-client failure inside any check is
 * caught, logged at warn, and never aborts the other clients (fail-safe: one
 * tenant's bad row never blocks the sweep).
 *
 * This module (and `reconcile-checks.ts`) must NEVER issue an `UPDATE`/
 * `DELETE` against `wallet_ledger` - the ledger is append-only; the ONLY
 * money write here is `wallet-adjustment-debit` (via check B's capped
 * correction path), which INSERTs a new ledger row, never mutates one.
 */

export interface WalletReconcileDeps {
  pool: WalletReconcilePool;
  tenantDb: TenantDb;
  metrics: Pick<WalletMetricsHandles, 'setDrift' | 'setClientsEmpty' | 'incDebit'>;
  now?: () => Date;
  /** Bounded batch size per cross-tenant check - never unbounded. Defaults 500. */
  limit?: number;
  /** Per-client cap on check-B non-repaired corrections per UTC day. Defaults 50. */
  dailyCorrectionCap?: number;
  /** Check B's evidence window width. Defaults 25 hours. */
  windowMs?: number;
  /** Check B's grace period before `now` (avoids racing an in-flight ack). Defaults 10 minutes. */
  graceMs?: number;
  logger?: ReconcileLogger;
}

export interface WalletReconcileOutcome {
  findings: Record<string, number>;
  corrected: number;
  capped: number;
  driftMinor: number;
  clientsEmpty: number;
}

interface MissingDebitRow extends Record<string, unknown> {
  client_id: string;
  send_attempt_id: string;
  message_job_id: string;
  message_job_created_at: Date;
  instance_id: string;
  job_status: string;
  resolved_at: Date;
}

function toUtcDayString(date: Date, offsetDays: number): string {
  return new Date(date.getTime() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function runCheckB(
  deps: Required<
    Pick<WalletReconcileDeps, 'pool' | 'tenantDb' | 'metrics' | 'dailyCorrectionCap' | 'logger'>
  > & { from: Date; to: Date; limit: number; now: Date },
): Promise<{ findings: number; corrected: number; capped: number }> {
  const query = await loadNamedQuery('wallet-reconcile', 'wallet-reconcile-missing-debits');
  const scan = await deps.pool.query<MissingDebitRow>(
    query.text,
    bindQueryParams(query, { from: deps.from, to: deps.to, limit: deps.limit }),
  );

  let findings = 0;
  let corrected = 0;
  let capped = 0;

  for (const row of scan.rows) {
    try {
      if (row.job_status === 'sent') {
        const result = await chargeRepairedSend(
          deps.tenantDb,
          { clientId: row.client_id, attemptId: row.send_attempt_id },
          { metrics: deps.metrics },
        );
        if (result.seq !== null) {
          await insertFinding(deps.tenantDb, {
            clientId: row.client_id,
            kind: 'missing_debit_repaired',
            detail: { send_attempt_id: row.send_attempt_id, job_status: row.job_status },
            amountMinor: null,
            correctedAt: deps.now,
          });
          findings += 1;
          corrected += 1;
        }
        continue;
      }

      await deps.tenantDb.withTenant(row.client_id, async (tx) => {
        const countQuery = await loadNamedQuery(
          'wallet-reconcile',
          'wallet-reconcile-daily-correction-count',
        );
        const countResult = await tx.query<{ n: number }>(
          countQuery.text,
          bindQueryParams(countQuery, { client_id: row.client_id }),
        );
        const n = countResult.rows[0]?.n ?? 0;

        const resolved = await resolveAttemptPrice(tx, row.client_id, row.send_attempt_id);
        const rateMinor = resolved?.rateMinor ?? null;

        if (n < deps.dailyCorrectionCap && resolved) {
          const debitQuery = await loadNamedQuery('wallet-reconcile', 'wallet-adjustment-debit');
          const debitResult = await tx.query<{
            job_rows: number;
            guard_rows: number;
            seq: string | null;
          }>(
            debitQuery.text,
            bindQueryParams(debitQuery, {
              attempt: row.send_attempt_id,
              client: row.client_id,
              rate: resolved.rateMinor,
              price_key: resolved.priceKey,
            }),
          );
          const seq = debitResult.rows[0]?.seq ?? null;

          if (seq !== null) {
            const stampQuery = await loadNamedQuery('debit-send', 'wallet-stamp-guard');
            await tx.query(
              stampQuery.text,
              bindQueryParams(stampQuery, {
                seq,
                attempt: row.send_attempt_id,
                kind: 'adjustment_debit',
                client: row.client_id,
              }),
            );
            deps.metrics.incDebit(resolved.priceKey);

            const findingQuery = await loadNamedQuery('wallet-reconcile', 'wallet-finding-insert');
            await tx.query(
              findingQuery.text,
              bindQueryParams(findingQuery, {
                client_id: row.client_id,
                kind: 'missing_debit',
                detail: JSON.stringify({ send_attempt_id: row.send_attempt_id }),
                amount_minor: resolved.rateMinor,
                corrected_at: deps.now,
              }),
            );
            findings += 1;
            corrected += 1;
            return;
          }
        }

        const findingQuery = await loadNamedQuery('wallet-reconcile', 'wallet-finding-insert');
        await tx.query(
          findingQuery.text,
          bindQueryParams(findingQuery, {
            client_id: row.client_id,
            kind: 'missing_debit_capped',
            detail: JSON.stringify({ send_attempt_id: row.send_attempt_id }),
            amount_minor: rateMinor,
            corrected_at: null,
          }),
        );
        findings += 1;
        capped += 1;
      });
    } catch (err) {
      deps.logger.warn(
        { client_id: row.client_id, check: 'B' },
        `wallet reconcile check B failed: ${describeError(err)}`,
      );
    }
  }

  return { findings, corrected, capped };
}

const NOOP_LOGGER: ReconcileLogger = { warn: () => undefined };

/**
 * Runs one wallet reconciler sweep: checks A (continuity), B (missing
 * debits - the only check that writes money), C (orphan debits), D (rollup
 * parity, today + yesterday), E (orphan guards), then the empty-clients
 * gauge. Every step is bounded by `deps.limit`.
 */
export async function runOneWalletReconcileSweep(
  deps: WalletReconcileDeps,
): Promise<WalletReconcileOutcome> {
  const now = deps.now?.() ?? new Date();
  const limit = deps.limit ?? 500;
  const dailyCorrectionCap = deps.dailyCorrectionCap ?? 50;
  const windowMs = deps.windowMs ?? 25 * 60 * 60 * 1000;
  const graceMs = deps.graceMs ?? 10 * 60 * 1000;
  const logger = deps.logger ?? NOOP_LOGGER;

  const to = new Date(now.getTime() - graceMs);
  const from = new Date(to.getTime() - windowMs);

  const findings: Record<string, number> = {};

  const checkA = await runCheckA({ pool: deps.pool, tenantDb: deps.tenantDb, limit, logger });
  findings.continuity = checkA.findings;
  deps.metrics.setDrift(checkA.driftMinor);

  const checkB = await runCheckB({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    metrics: deps.metrics,
    dailyCorrectionCap,
    logger,
    from,
    to,
    limit,
    now,
  });
  findings.missing_debits = checkB.findings;

  findings.orphan_debits = await runCheckC({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    from,
    to,
    limit,
    logger,
  });

  const today = toUtcDayString(now, 0);
  const yesterday = toUtcDayString(now, 1);
  const parityToday = await runCheckDForDay({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    day: today,
    limit,
    logger,
  });
  const parityYesterday = await runCheckDForDay({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    day: yesterday,
    limit,
    logger,
  });
  findings.rollup_parity = parityToday + parityYesterday;

  findings.orphan_guards = await runCheckE({
    pool: deps.pool,
    tenantDb: deps.tenantDb,
    limit,
    logger,
  });

  const emptyQuery = await loadNamedQuery('wallet-reconcile', 'wallet-count-empty-clients');
  const emptyResult = await deps.pool.query<{ clients_empty: number }>(emptyQuery.text, []);
  const clientsEmpty = emptyResult.rows[0]?.clients_empty ?? 0;
  deps.metrics.setClientsEmpty(clientsEmpty);

  return {
    findings,
    corrected: checkB.corrected,
    capped: checkB.capped,
    driftMinor: checkA.driftMinor,
    clientsEmpty,
  };
}
