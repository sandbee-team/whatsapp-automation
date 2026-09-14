import { bindQueryParams, loadNamedQuery, type TenantDb } from '@wp/db';

/**
 * rollup.ts (P18 Unit U8b) - the daily wallet rollup sweep's TypeScript
 * half, wired over `db/queries/wallet-reconcile.sql`'s `wallet-rollup-compute`
 * (cross-tenant, bounded, `deps.pool`) and `wallet-rollup-upsert` (per
 * tenant, `deps.tenantDb.withTenant`, as `wp_app` under the normal RLS
 * path). Idempotent and re-runnable: a re-run with unchanged figures
 * touches zero rows (`wallet-rollup-upsert`'s own `IS DISTINCT FROM`
 * guard), so calling this sweep twice for the same day is always safe.
 *
 * Per-client/per-instance figures come ONLY from this rollup's own
 * `wallet_daily_summary` output, never from metrics (ADR 0019 S10) - the
 * workspace total any dashboard shows is a SUM over these per-instance rows,
 * computed by the caller, never aggregated here.
 */

export interface WalletRollupDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  now?: () => Date;
  /** How many UTC days to process, starting with today - defaults 2 (today, yesterday). */
  days?: number;
  /** Bounded batch size for the cross-tenant compute scan - never unbounded. */
  limit?: number;
}

export interface WalletRollupSweepResult {
  daysProcessed: number;
  rowsUpserted: number;
  rowsUnchanged: number;
}

interface ComputeRow extends Record<string, unknown> {
  client_id: string;
  instance_id: string;
  sent_count: number;
  debit_minor: string | number;
  credit_minor: string | number;
  refund_minor: string | number;
}

function toUtcDayString(date: Date, offsetDays: number): string {
  const shifted = new Date(date.getTime() - offsetDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Runs one wallet rollup sweep: for each of `deps.days` UTC days (today,
 * then yesterday, ...), computes the day's per-(client, instance) totals
 * cross-tenant via `wallet-rollup-compute`, groups the rows by client, and
 * upserts each client's rows in its OWN `withTenant` transaction (never a
 * cross-tenant write). Zero rows for a day is a normal outcome.
 */
export async function runOneWalletRollupSweep(
  deps: WalletRollupDeps,
): Promise<WalletRollupSweepResult> {
  const now = deps.now?.() ?? new Date();
  const days = deps.days ?? 2;
  const limit = deps.limit ?? 5000;

  const computeQuery = await loadNamedQuery('wallet-reconcile', 'wallet-rollup-compute');
  const upsertQuery = await loadNamedQuery('wallet-reconcile', 'wallet-rollup-upsert');

  let rowsUpserted = 0;
  let rowsUnchanged = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const day = toUtcDayString(now, offset);
    const computed = await deps.pool.query<ComputeRow>(
      computeQuery.text,
      bindQueryParams(computeQuery, { day, limit }),
    );

    const rowsByClient = new Map<string, ComputeRow[]>();
    for (const row of computed.rows) {
      const rows = rowsByClient.get(row.client_id) ?? [];
      rows.push(row);
      rowsByClient.set(row.client_id, rows);
    }

    for (const [clientId, rows] of rowsByClient) {
      await deps.tenantDb.withTenant(clientId, async (tx) => {
        for (const row of rows) {
          const result = await tx.query(
            upsertQuery.text,
            bindQueryParams(upsertQuery, {
              client_id: row.client_id,
              day,
              instance_id: row.instance_id,
              sent_count: row.sent_count,
              debit_minor: row.debit_minor,
              credit_minor: row.credit_minor,
              refund_minor: row.refund_minor,
            }),
          );
          if ((result.rowCount ?? 0) > 0) {
            rowsUpserted += 1;
          } else {
            rowsUnchanged += 1;
          }
        }
      });
    }
  }

  return { daysProcessed: days, rowsUpserted, rowsUnchanged };
}
