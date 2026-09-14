import type { TenantQueryable } from '@wp/db';
import type { ApiKeyLookupRow } from './verify.js';

/**
 * repo.ts (go-live U4) - `api_keys` SQL, split into two access shapes:
 *   - every tenant-scoped statement (`insertApiKey`, `listApiKeys`,
 *     `revokeApiKey`, `touchLastUsedAt`) runs through the caller's own
 *     `tenantDb.withTenant` transaction, exactly as `modules/webhooks/
 *     repo.ts`/`service.ts` already do for `webhook_endpoints` - RLS
 *     (`app.client_id`) PLUS an explicit `client_id` predicate on every
 *     statement (belt-and-suspenders, same discipline `listWebhookEndpoints`'s
 *     own doc comment documents).
 *   - `lookupByKeyPrefix` is the ONE exception: it runs OUTSIDE `withTenant`,
 *     as a plain (non-tenant-scoped) query, because a request presenting a
 *     bearer key has NO tenant context yet - that is exactly the gap U1's
 *     `wp_api_key_lookup` SECURITY DEFINER function exists to bridge (see
 *     migration 0076's own header comment: a plain `wp_app` SELECT under
 *     FORCE RLS with no `app.client_id` GUC set returns zero rows for every
 *     prefix). `listApiKeys` never selects `secret_hash` - only the lookup
 *     path touches that column, and never returns it past `verify.ts`.
 */

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeySqlRow extends Record<string, unknown> {
  id: string;
  name: string;
  key_prefix: string;
  last4: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function mapRow(row: ApiKeySqlRow): ApiKeyRow {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    last4: row.last4,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

export interface InsertApiKeyInput {
  clientId: string;
  id: string;
  name: string;
  keyPrefix: string;
  secretHash: Buffer;
  last4: string;
  createdByUserId: string;
}

/** Inserts one `api_keys` row. `id` is caller-minted (`randomUUID()` in `service.ts`) rather than server-defaulted, so the service can return it in the same response without a second round trip. */
export async function insertApiKey(
  tx: TenantQueryable,
  input: InsertApiKeyInput,
): Promise<ApiKeyRow> {
  const result = await tx.query<ApiKeySqlRow>(
    `INSERT INTO api_keys (client_id, id, name, key_prefix, secret_hash, last4, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     -- client_id = $1
     RETURNING id, name, key_prefix, last4, created_at, last_used_at, revoked_at`,
    [
      input.clientId,
      input.id,
      input.name,
      input.keyPrefix,
      input.secretHash,
      input.last4,
      input.createdByUserId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertApiKey: insert returned no row');
  return mapRow(row);
}

/** Tenant-scoped list, ordered oldest-first (same order `listWebhookEndpoints` uses) - NEVER selects `secret_hash`. */
export async function listApiKeys(tx: TenantQueryable, clientId: string): Promise<ApiKeyRow[]> {
  const result = await tx.query<ApiKeySqlRow>(
    `SELECT id, name, key_prefix, last4, created_at, last_used_at, revoked_at
       FROM api_keys
      WHERE client_id = $1
      ORDER BY created_at`,
    [clientId],
  );
  return result.rows.map(mapRow);
}

/** Maps a conditional UPDATE's `rowCount` to "a row was actually revoked just now" - `null`/`0` both mean no matching, not-yet-revoked row (same "conditional UPDATE -> rowCount -> boolean" shape `deleteWebhookEndpoint` uses). */
export function wasRevoked(rowCount: number | null): boolean {
  return rowCount === 1;
}

/**
 * Conditional UPDATE: only a row that is BOTH this tenant's own AND not
 * already revoked is touched (`WHERE ... AND revoked_at IS NULL`) - a
 * foreign id, an absent id, and an already-revoked id all return `false`
 * from `wasRevoked`, so `service.ts` maps every one of those to the SAME
 * 404-shaped result (never 403 - tenant isolation, core invariant 4).
 */
export async function revokeApiKey(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<{ revoked: boolean; revokedAt: string | null }> {
  const result = await tx.query<{ revoked_at: string } & Record<string, unknown>>(
    `UPDATE api_keys SET revoked_at = now()
      WHERE client_id = $1 AND id = $2 AND revoked_at IS NULL
      RETURNING revoked_at`,
    [clientId, id],
  );
  const revoked = wasRevoked(result.rowCount);
  const row = result.rows[0];
  return { revoked, revokedAt: row ? new Date(row.revoked_at).toISOString() : null };
}

/** The 60-second throttle window `touchLastUsedAt`'s own SQL enforces - exposed as a pure predicate so the boundary is unit-testable without a live connection. `null` (never used before) always touches. */
export function shouldTouchLastUsedAt(lastUsedAt: Date | null, now: Date): boolean {
  if (lastUsedAt === null) return true;
  return now.getTime() - lastUsedAt.getTime() > 60_000;
}

/**
 * Throttled last-used stamp: the SQL itself re-checks the same 60-second
 * window (`shouldTouchLastUsedAt`'s own predicate, mirrored here rather than
 * called from SQL, since Postgres has no access to that JS function) so a
 * burst of calls across many connections still only ever writes once per
 * window - never an in-memory-only check (core invariant 3, idempotency at
 * the storage layer). Fire-and-forget from the caller's own perspective
 * (`messages.routes.ts` never awaits this on the hot send path) - a failure
 * here must never fail a send.
 */
export async function touchLastUsedAt(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<void> {
  await tx.query(
    `UPDATE api_keys SET last_used_at = now()
      WHERE client_id = $1 AND id = $2
        AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
    [clientId, id],
  );
}

export interface ApiKeyLookupSqlRow extends Record<string, unknown> {
  client_id: string;
  id: string;
  secret_hash: Buffer;
  created_by_user_id: string;
  revoked_at: Date | null;
}

/**
 * The pre-tenant-context lookup - runs OUTSIDE `withTenant` (see module doc
 * comment). `tx` here is a plain queryable (NOT tenant-scoped) backed by
 * U1's `wp_api_key_lookup(p_key_prefix text)` SECURITY DEFINER function,
 * which returns AT MOST ONE row (`key_prefix` is globally unique) and
 * deliberately does NOT filter out a revoked row - `verify.ts`'s caller
 * decides what a revoked row means. Mapped straight to `verify.ts`'s own
 * `ApiKeyLookupRow` shape (its `VerifyApiKeyDeps.lookupByKeyPrefix` contract)
 * so `roles/api.ts` can bind this function directly with no adapter.
 */
export async function lookupByKeyPrefix(
  tx: TenantQueryable,
  keyPrefix: string,
): Promise<ApiKeyLookupRow | null> {
  const result = await tx.query<ApiKeyLookupSqlRow>('SELECT * FROM wp_api_key_lookup($1)', [
    keyPrefix,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    apiKeyId: row.id,
    secretHash: row.secret_hash,
    createdByUserId: row.created_by_user_id,
    revokedAt: row.revoked_at,
  };
}
