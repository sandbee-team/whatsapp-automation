import type { AdminReadQueryable } from '../../platform/platform-read.js';
import { decodeCursor, encodeCursor, type KeysetPage } from '../../platform/keyset.js';

/**
 * modules/topups/topups.read.ts (P28 Unit U4, step 7) - the cross-tenant
 * top-up review queue. Cross-tenant BY DEFINITION: a staff member reviewing
 * pending UPI/bank top-up submissions has no single workspace to scope to
 * (and a tenant can never approve its own top-up - migration 0058 grants
 * `wp_app` SELECT+INSERT with no UPDATE at all).
 *
 * `external_ref` (the UTR/bank reference the tenant typed) is deliberately
 * NOT projected on this LIST. That value identifies a real bank transaction
 * against a named person; it belongs to the moment a reviewer decides one
 * specific request - which happens through `/internal/v1`, inside
 * app-backend's own audited staff-mutation transaction - not to a queue
 * browse that anyone with `topups.read` can leave open on a second monitor.
 * The admin panel therefore shows amount/method/status/age here, and the
 * decision endpoint (a mutation proxy, step 8) is what carries the
 * reference through.
 */

export interface TopupListItem {
  id: string;
  clientId: string;
  /** PAISE, decimal string - never through `Number()` (real money, `bigint` in Postgres). */
  amountMinor: string;
  method: string;
  status: string;
  createdAt: string;
}

interface RawTopupRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  amount_minor: string;
  method: string;
  status: string;
  created_at: Date;
}

export interface ListTopupsFilter {
  status?: string;
  limit: number;
  cursor?: string;
}

/** Keyset-paginated cross-tenant top-up queue, optionally narrowed to one status. */
export async function listTopups(
  db: AdminReadQueryable,
  filter: ListTopupsFilter,
): Promise<KeysetPage<TopupListItem>> {
  // Statement lives INSIDE the exported function so
  // `scripts/check-tenant-scope.ts` attributes it to
  // `...topups.read.ts:listTopups` - the key the CROSS_TENANT_QUERIES
  // registry names. At module scope it would be keyed "(module scope)",
  // which no registry entry can match.
  const LIST_TOPUPS_SQL = `SELECT id,
           client_id,
           amount_minor::text AS amount_minor,
           method,
           status::text AS status,
           created_at
      FROM topup_requests
     WHERE ($1::text IS NULL OR status::text = $1)
       AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $4`;

  const cursor = decodeCursor(filter.cursor);
  const result = await db.query<RawTopupRow>(LIST_TOPUPS_SQL, [
    filter.status ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    filter.limit,
  ]);
  const last = result.rows[result.rows.length - 1];
  return {
    items: result.rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      amountMinor: row.amount_minor,
      method: row.method,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor:
      result.rows.length === filter.limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
  };
}
