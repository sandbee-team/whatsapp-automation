import { bindQueryParams, loadNamedQuery, type TenantQueryable } from '@wp/db';

/**
 * queue-status.repo.ts (P19 Unit U5, step 9) - SQL-only repo for
 * `GET /v1/queue-status`, wired over `db/queries/queue-status.sql` (see
 * that file's own header for the bounded-probe/no-`OFFSET` contract; this
 * module owns none of that logic itself, only the two-statement call
 * sequence). Both statements run inside the SAME `tenantDb.withTenant`
 * transaction the caller (`queue-status.routes.ts`) opens - `client_id`
 * scoping is enforced by the SQL's own `$client_id` bind on every branch,
 * never by this file re-deriving it.
 */

export interface QueueStatusInstanceRow {
  instanceId: string;
  waiting: number;
  sentToday: number;
  failedToday: number;
  /** PAISE, bigint - a `SUM()` over `wallet_daily_summary.debit_minor`; never round-tripped through `Number()`. */
  spentTodayMinor: bigint;
}

export interface QueueStatusWorkspaceTotals {
  waiting: number;
  sentToday: number;
  failedToday: number;
  spentTodayMinor: bigint;
}

export interface QueueStatusResult {
  instances: QueueStatusInstanceRow[];
  workspace: QueueStatusWorkspaceTotals;
}

interface RawInstanceRow extends Record<string, unknown> {
  instance_id: string;
  waiting: string;
  sent_today: string;
  failed_today: string;
  spent_today_minor: string;
}

interface RawTotalsRow extends Record<string, unknown> {
  waiting: string;
  sent_today: string;
  failed_today: string;
  spent_today_minor: string;
}

function mapInstanceRow(row: RawInstanceRow): QueueStatusInstanceRow {
  return {
    instanceId: row.instance_id,
    waiting: Number(row.waiting),
    sentToday: Number(row.sent_today),
    failedToday: Number(row.failed_today),
    spentTodayMinor: BigInt(row.spent_today_minor),
  };
}

/** Reads per-instance queue-status rows plus the workspace total for `clientId` - tenant-scoped throughout (core invariant 4). */
export async function readQueueStatus(
  tx: TenantQueryable,
  clientId: string,
): Promise<QueueStatusResult> {
  const perInstanceQuery = await loadNamedQuery('queue-status', 'queue-status-per-instance');
  const perInstanceResult = await tx.query<RawInstanceRow>(
    perInstanceQuery.text,
    bindQueryParams(perInstanceQuery, { client_id: clientId }),
  );

  const totalsQuery = await loadNamedQuery('queue-status', 'queue-status-workspace-totals');
  const totalsResult = await tx.query<RawTotalsRow>(
    totalsQuery.text,
    bindQueryParams(totalsQuery, { client_id: clientId }),
  );
  const totalsRow = totalsResult.rows[0];

  return {
    instances: perInstanceResult.rows.map(mapInstanceRow),
    workspace: totalsRow
      ? {
          waiting: Number(totalsRow.waiting),
          sentToday: Number(totalsRow.sent_today),
          failedToday: Number(totalsRow.failed_today),
          spentTodayMinor: BigInt(totalsRow.spent_today_minor),
        }
      : { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: 0n },
  };
}
