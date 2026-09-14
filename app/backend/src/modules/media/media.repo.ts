import type { TenantQueryable } from '@wp/db';

/**
 * media.repo.ts (P34 U-upload, ADR 0052 accepted scope) - `media_assets`
 * SQL. Both statements run through the caller's own `tenantDb.withTenant`
 * transaction (RLS `app.client_id` PLUS an explicit `client_id` predicate,
 * belt-and-suspenders, same discipline `modules/api-keys/repo.ts`
 * documents).
 */

export interface MediaAssetRow {
  id: string;
  kind: 'image' | 'document';
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
  createdAt: string;
}

interface MediaAssetSqlRow extends Record<string, unknown> {
  id: string;
  kind: string;
  mime_type: string;
  size_bytes: string | number;
  file_name: string | null;
  created_at: string;
}

function mapRow(row: MediaAssetSqlRow): MediaAssetRow {
  return {
    id: row.id,
    kind: row.kind as 'image' | 'document',
    mimeType: row.mime_type,
    sizeBytes: typeof row.size_bytes === 'string' ? Number(row.size_bytes) : row.size_bytes,
    fileName: row.file_name,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface InsertOrGetMediaAssetInput {
  clientId: string;
  id: string;
  kind: 'image' | 'document';
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
  storageKey: string;
  sha256: Buffer;
  createdByUserId: string | null;
}

/**
 * `INSERT ... ON CONFLICT (client_id, sha256) DO NOTHING`, then a
 * conditional re-`SELECT` on the same unique key - the dedupe authority
 * (ADR 0052 accepted item 2: the same bytes uploaded twice by one tenant
 * resolve to ONE asset row). The caller-supplied `id`/`storageKey` are
 * discarded on a dedupe hit (the earlier upload's own id/key win) - the
 * caller's freshly-`put()` object is an ORPHAN in that case and the retention
 * sweep's own idempotent-delete-by-key handles it, never a second write
 * here.
 */
export async function insertOrGetMediaAsset(
  tx: TenantQueryable,
  input: InsertOrGetMediaAssetInput,
): Promise<MediaAssetRow> {
  await tx.query(
    `INSERT INTO media_assets
       (client_id, id, kind, mime_type, size_bytes, file_name, storage_key, sha256, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     -- client_id = $1
     ON CONFLICT (client_id, sha256) DO NOTHING`,
    [
      input.clientId,
      input.id,
      input.kind,
      input.mimeType,
      input.sizeBytes,
      input.fileName,
      input.storageKey,
      input.sha256,
      input.createdByUserId,
    ],
  );

  const result = await tx.query<MediaAssetSqlRow>(
    `SELECT id, kind, mime_type, size_bytes, file_name, created_at
       FROM media_assets
      WHERE client_id = $1 AND sha256 = $2`,
    [input.clientId, input.sha256],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertOrGetMediaAsset: no row after insert-or-dedupe');
  return mapRow(row);
}

/** Tenant-scoped read by id - a foreign or absent id returns `null` (the caller maps that to 404, never 403 - core invariant 4). */
export async function getMediaAssetById(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<MediaAssetRow | null> {
  const result = await tx.query<MediaAssetSqlRow>(
    `SELECT id, kind, mime_type, size_bytes, file_name, created_at
       FROM media_assets
      WHERE client_id = $1 AND id = $2`,
    [clientId, id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The dispatch-facing projection: adds `storageKey` (never returned to a tenant - see `resolveMediaAssetForDispatch`'s own doc) to the tenant-facing metadata shape above. */
export interface MediaAssetForDispatch extends MediaAssetRow {
  storageKey: string;
}

interface MediaAssetDispatchSqlRow extends MediaAssetSqlRow {
  storage_key: string;
}

/**
 * The ONE dispatch-facing accessor (P34 Unit B, ADR 0052 accepted scope item
 * 5) - resolves `mediaId` for THIS client to the object-store key the
 * transport streams from. `storageKey` never appears in any tenant-facing
 * route response (`media.routes.ts`'s `GET /v1/media/:id` uses
 * `getMediaAssetById` above instead, which omits it entirely) - this
 * function exists ONLY for `engine/queue/dispatch.ts`'s send-time resolve. A
 * foreign or absent id returns `null`, same tenant-scoped, fail-closed shape
 * as `getMediaAssetById` (core invariant 4 - the caller maps this to a
 * terminal `invalid_payload`/DEFER, never a 403).
 */
export async function resolveMediaAssetForDispatch(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<MediaAssetForDispatch | null> {
  const result = await tx.query<MediaAssetDispatchSqlRow>(
    `SELECT id, kind, mime_type, size_bytes, file_name, storage_key, created_at
       FROM media_assets
      WHERE client_id = $1 AND id = $2`,
    [clientId, id],
  );
  const row = result.rows[0];
  return row ? { ...mapRow(row), storageKey: row.storage_key } : null;
}

/**
 * Fire-and-forget `last_used_at` stamp (accepted scope item 5 / the ADR's own
 * `media_assets.last_used_at` grant) - a failure here must NEVER fail a send
 * (this dispatch's own instruction), so the caller (`dispatch.ts`) awaits
 * this but swallows any rejection itself; this function does not swallow on
 * its own so a genuine caller bug (a bad SQL shape) still surfaces in tests.
 */
export async function touchMediaAssetLastUsedAt(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<void> {
  await tx.query(`UPDATE media_assets SET last_used_at = now() WHERE client_id = $1 AND id = $2`, [
    clientId,
    id,
  ]);
}
