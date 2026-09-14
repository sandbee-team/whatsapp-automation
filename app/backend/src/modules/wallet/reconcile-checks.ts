import { bindQueryParams, loadNamedQuery, type TenantDb } from '@wp/db';
import { describeError } from '@wp/server-kit';
import { resolveAttemptPrice, chargeRepairedSend } from './charge.js';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';

/**
 * reconcile-checks.ts (P18 Unit U8b) - checks A/C/D/E of the reconciler
 * sweep, split out of `reconcile.ts` purely for that file's own max-lines
 * cap (same split idiom as `session-worker-discovery-wiring.ts`). Check B
 * (missing debits, the only check that WRITES money) stays in `reconcile.ts`
 * itself, next to the sweep's own orchestration.
 */

export interface ReconcileLogger {
  warn(meta: object, msg: string): void;
}

export interface FindingInsert {
  clientId: string;
  kind: string;
  detail: Record<string, unknown>;
  amountMinor: number | null;
  correctedAt: Date | null;
}

/** Inserts one finding row via `wallet-finding-insert`, per tenant (`withTenant`). */
export async function insertFinding(tenantDb: TenantDb, finding: FindingInsert): Promise<void> {
  const query = await loadNamedQuery('wallet-reconcile', 'wallet-finding-insert');
  await tenantDb.withTenant(finding.clientId, (tx) =>
    tx.query(
      query.text,
      bindQueryParams(query, {
        client_id: finding.clientId,
        kind: finding.kind,
        detail: JSON.stringify(finding.detail),
        amount_minor: finding.amountMinor,
        corrected_at: finding.correctedAt,
      }),
    ),
  );
}

interface ContinuityRow extends Record<string, unknown> {
  client_id: string;
  kind: string;
  detail: Record<string, unknown>;
  amount_minor: string | number | null;
}

export interface CheckAResult {
  findings: number;
  driftMinor: number;
}

/** Check A: continuity + balance-mismatch scan. Returns the finding count and the summed |amount_minor| drift over balance_mismatch rows only. */
export async function runCheckA(deps: {
  pool: WalletReconcilePool;
  tenantDb: TenantDb;
  limit: number;
  logger?: ReconcileLogger;
}): Promise<CheckAResult> {
  const query = await loadNamedQuery('wallet-reconcile', 'wallet-reconcile-continuity');
  const scan = await deps.pool.query<ContinuityRow>(
    query.text,
    bindQueryParams(query, { limit: deps.limit }),
  );

  let driftMinor = 0;
  let findings = 0;
  for (const row of scan.rows) {
    const amount = row.amount_minor === null ? null : Number(row.amount_minor);
    if (row.kind === 'balance_mismatch' && amount !== null) {
      driftMinor += Math.abs(amount);
    }
    try {
      await insertFinding(deps.tenantDb, {
        clientId: row.client_id,
        kind: row.kind,
        detail: row.detail,
        amountMinor: amount,
        correctedAt: null,
      });
      findings += 1;
    } catch (err) {
      deps.logger?.warn(
        { client_id: row.client_id, check: 'A' },
        `wallet reconcile check A failed: ${describeError(err)}`,
      );
    }
  }
  return { findings, driftMinor };
}

interface OrphanDebitRow extends Record<string, unknown> {
  client_id: string;
  send_attempt_id: string;
  ledger_seq: string;
  attempt_state: string;
}

export interface WalletReconcilePool {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Check C: orphan debit_send guards with no matching settled attempt. */
export async function runCheckC(deps: {
  pool: WalletReconcilePool;
  tenantDb: TenantDb;
  from: Date;
  to: Date;
  limit: number;
  logger?: ReconcileLogger;
}): Promise<number> {
  const query = await loadNamedQuery('wallet-reconcile', 'wallet-reconcile-orphan-debits');
  const scan = await deps.pool.query<OrphanDebitRow>(
    query.text,
    bindQueryParams(query, { from: deps.from, to: deps.to, limit: deps.limit }),
  );

  let findings = 0;
  for (const row of scan.rows) {
    try {
      await insertFinding(deps.tenantDb, {
        clientId: row.client_id,
        kind: 'orphan_debit',
        detail: {
          send_attempt_id: row.send_attempt_id,
          ledger_seq: row.ledger_seq,
          attempt_state: row.attempt_state,
        },
        amountMinor: null,
        correctedAt: null,
      });
      findings += 1;
    } catch (err) {
      deps.logger?.warn(
        { client_id: row.client_id, check: 'C' },
        `wallet reconcile check C failed: ${describeError(err)}`,
      );
    }
  }
  return findings;
}

interface RollupParityRow extends Record<string, unknown> {
  client_id: string;
  instance_id: string;
  field: string;
  expected: string | number | null;
  actual: string | number | null;
}

/** Check D: rollup-vs-ledger parity for one UTC day. */
export async function runCheckDForDay(deps: {
  pool: WalletReconcilePool;
  tenantDb: TenantDb;
  day: string;
  limit: number;
  logger?: ReconcileLogger;
}): Promise<number> {
  const query = await loadNamedQuery('wallet-reconcile', 'wallet-reconcile-rollup-parity');
  const scan = await deps.pool.query<RollupParityRow>(
    query.text,
    bindQueryParams(query, { day: deps.day, limit: deps.limit }),
  );

  let findings = 0;
  for (const row of scan.rows) {
    const expected = row.expected === null ? null : Number(row.expected);
    const actual = row.actual === null ? null : Number(row.actual);
    const amount = expected !== null && actual !== null ? actual - expected : null;
    try {
      await insertFinding(deps.tenantDb, {
        clientId: row.client_id,
        kind: 'rollup_parity',
        detail: { day: deps.day, instance_id: row.instance_id, field: row.field, expected, actual },
        amountMinor: amount,
        correctedAt: null,
      });
      findings += 1;
    } catch (err) {
      deps.logger?.warn(
        { client_id: row.client_id, check: 'D' },
        `wallet reconcile check D failed: ${describeError(err)}`,
      );
    }
  }
  return findings;
}

interface OrphanGuardRow extends Record<string, unknown> {
  client_id: string;
  send_attempt_id: string;
  kind: string;
  created_at: Date;
}

/** Check E: unstamped guards older than 10 minutes - the one-transaction debit's own canary. */
export async function runCheckE(deps: {
  pool: WalletReconcilePool;
  tenantDb: TenantDb;
  limit: number;
  logger?: ReconcileLogger;
}): Promise<number> {
  const query = await loadNamedQuery('wallet-reconcile', 'wallet-reconcile-orphan-guards');
  const scan = await deps.pool.query<OrphanGuardRow>(
    query.text,
    bindQueryParams(query, { limit: deps.limit }),
  );

  let findings = 0;
  for (const row of scan.rows) {
    try {
      await insertFinding(deps.tenantDb, {
        clientId: row.client_id,
        kind: 'orphan_guard',
        detail: {
          send_attempt_id: row.send_attempt_id,
          kind: row.kind,
          created_at: row.created_at,
        },
        amountMinor: null,
        correctedAt: null,
      });
      findings += 1;
    } catch (err) {
      deps.logger?.warn(
        { client_id: row.client_id, check: 'E' },
        `wallet reconcile check E failed: ${describeError(err)}`,
      );
    }
  }
  return findings;
}

/** Re-exported so `reconcile.ts` (check B) can charge a repaired send without a second import path. */
export { resolveAttemptPrice, chargeRepairedSend };
export type { WalletMetricsHandles };
