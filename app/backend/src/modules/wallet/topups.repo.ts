import type { TenantQueryable } from '@wp/db';

/**
 * topups.repo.ts (P19 Unit U4, step 7) - SQL-only repo for `topup_requests`:
 * insert one (tenant submission) and list a tenant's own requests, keyset-
 * paginated newest-first (`(created_at, id) < (cursor)` composite predicate,
 * NEVER `OFFSET` - same idiom as `modules/notifications/notifications.repo.ts`'s
 * `encodeCursor`/`decodeCursor`, re-used here rather than forked). `wp_app`
 * has SELECT+INSERT only on this table (migration 0058) - there is no
 * UPDATE call anywhere in this file, by construction (staff review is P28's
 * own internal-API concern, a DIFFERENT DB role, `wp_admin_app`).
 *
 * DUPLICATE UTR (core invariant 3, storage-layer idempotency): this repo
 * never SELECTs `external_ref` before the INSERT - the unique constraint
 * `topup_requests_client_external_ref_key` (client_id, external_ref) is the
 * SOLE authority; a duplicate submission throws a raw Postgres error with
 * `code: '23505'` and `constraint: 'topup_requests_client_external_ref_key'`,
 * which `topups.routes.ts` maps to `409 CONFLICT` - never caught or
 * pre-checked here.
 */

export interface CreateTopupRequestRepoInput {
  clientId: string;
  /** PAISE, bigint end-to-end (core invariant: never a JS number round-trip) - node-postgres binds a bigint parameter to a `bigint` column natively. */
  amountMinor: bigint;
  method: 'upi' | 'bank_transfer';
  externalRef: string;
  submittedByUserId: string;
}

export interface TopupRequestRow {
  id: string;
  /** PAISE, bigint - read back `amount_minor::text` and parsed with `BigInt()`, never `Number()` (loses precision above `Number.MAX_SAFE_INTEGER`). */
  amountMinor: bigint;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface RawTopupRow extends Record<string, unknown> {
  id: string;
  amount_minor: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
}

function mapRow(row: RawTopupRow): TopupRequestRow {
  return {
    id: row.id,
    amountMinor: BigInt(row.amount_minor),
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Inserts one `topup_requests` row. `method` is fixed to `'upi'` in v1's
 * caller (`topups.routes.ts` - the contract's `createTopupRequestInputSchema`
 * carries no `method` field yet, ADR 0019 §9 v1 scope) but this repo takes
 * it as an explicit param so a later phase widening the contract needs no
 * repo change. Throws the raw Postgres error (never mapped here) on a
 * duplicate `(client_id, external_ref)` - see module header.
 */
export async function createTopupRequest(
  tx: TenantQueryable,
  input: CreateTopupRequestRepoInput,
): Promise<TopupRequestRow> {
  const result = await tx.query<RawTopupRow>(
    `INSERT INTO topup_requests
       (client_id, amount_minor, method, external_ref, submitted_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, amount_minor::text AS amount_minor, status, created_at
     -- client_id = $1`,
    [input.clientId, input.amountMinor, input.method, input.externalRef, input.submittedByUserId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('createTopupRequest: no row returned from INSERT');
  }
  return mapRow(row);
}

export interface ListTopupRequestsRepoInput {
  clientId: string;
  limit: number;
  /** Opaque cursor previously returned as `nextCursor` - decoded by the caller (`topups.routes.ts`), never here (mirrors notifications.repo.ts's own split). */
  cursor?: { createdAt: string; id: string };
}

export interface ListTopupRequestsRepoResult {
  items: TopupRequestRow[];
  hasMore: boolean;
}

/** Newest-first, keyset-paginated - scoped to `clientId` only (tenant isolation); fetches one extra row to compute `hasMore` without a second COUNT query. */
export async function listTopupRequests(
  tx: TenantQueryable,
  input: ListTopupRequestsRepoInput,
): Promise<ListTopupRequestsRepoResult> {
  const params: unknown[] = [input.clientId];
  let extraCondition = '';
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    extraCondition = ` AND (created_at, id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::uuid)`;
  }
  params.push(input.limit + 1);

  const result = await tx.query<RawTopupRow>(
    `SELECT id, amount_minor::text AS amount_minor, status, created_at
       FROM topup_requests
      WHERE client_id = $1${extraCondition}
      ORDER BY created_at DESC, id DESC
      LIMIT $${String(params.length)}`,
    params,
  );

  const hasMore = result.rows.length > input.limit;
  const page = hasMore ? result.rows.slice(0, input.limit) : result.rows;
  return { items: page.map(mapRow), hasMore };
}

/** Reads one `topup_requests` row scoped to `clientId` - `undefined` when it does not exist OR belongs to another tenant (never distinguishes the two, so a cross-tenant probe cannot tell "not found" from "not yours"). */
export async function readTopupRequest(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<TopupRequestRow | undefined> {
  const result = await tx.query<RawTopupRow>(
    `SELECT id, amount_minor::text AS amount_minor, status, created_at
       FROM topup_requests
      WHERE client_id = $1 AND id = $2`,
    [clientId, id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : undefined;
}
