import { bindQueryParams, loadQuery, type TenantDb, type TenantQueryable } from '@wp/db';
import { assertTenantKey, type ObjectStore } from '../../platform/storage/object-store.js';

/**
 * retention-purge.ts (P34 U-upload, ADR 0052 accepted item 7) - the 90-day
 * media retention purge: deletes a `media_assets` row and its object 90
 * days after `COALESCE(last_used_at, created_at)`. ROW-DRIVEN, never an
 * object-store prefix scan (ADR 0018 S4, same discipline as
 * `contacts/retention-purge.ts`'s own module doc): the candidate set is
 * `db/queries/purge-media-assets.sql`, bounded per client by `batchLimit`,
 * and each candidate's object is `head`ed (already-gone = the idempotency
 * marker) before it is `delete`d - an object a live row still references is
 * NEVER touched, because the candidate query itself only selects rows past
 * the cutoff.
 *
 * `listClientIds` is an INJECTED port, same as `contacts/retention-purge.ts`
 * - this unit needs no cross-tenant SQL and no registry entry of its own; a
 * later wiring unit supplies the real client registry via the SAME
 * `listActiveClientIds` cursor the contacts maintenance loops already use.
 */

export interface MediaRetentionPurgeDeps {
  tenantDb: TenantDb;
  objectStore: ObjectStore;
  listClientIds: () => Promise<string[]>;
  /** Injected clock (core invariants: no ambient wall-clock reads in a derivation). */
  now: () => Date;
  /** Defaults 90 (ADR 0052 accepted item 7). */
  retentionDays?: number;
  /** Bounded per-client batch size. Defaults 200. */
  batchLimit?: number;
}

export interface MediaRetentionPurgeOutcome {
  clientsScanned: number;
  assetsDeleted: number;
}

interface RawMediaAssetRow extends Record<string, unknown> {
  id: string;
  storage_key: string;
}

async function purgeAgedMediaAssets(
  tx: TenantQueryable,
  objectStore: ObjectStore,
  clientId: string,
  cutoff: Date,
  batchLimit: number,
): Promise<number> {
  const query = await loadQuery('purge-media-assets');
  const result = await tx.query<RawMediaAssetRow>(
    query.text,
    bindQueryParams(query, { client_id: clientId, cutoff, limit: batchLimit }),
  );

  let deleted = 0;
  for (const row of result.rows) {
    assertTenantKey(row.storage_key, clientId);
    const head = await objectStore.head(row.storage_key);
    if (head !== null) {
      await objectStore.delete(row.storage_key);
    }
    // The row delete is the durable half - conditional on the SAME id so a
    // concurrent dispatch that just stamped last_used_at (and therefore
    // moved the asset out of the candidate window) is never raced: this
    // statement only ever deletes the exact row this iteration already
    // selected as a candidate.
    await tx.query('DELETE FROM media_assets WHERE client_id = $1 AND id = $2', [clientId, row.id]);
    deleted += 1;
  }
  return deleted;
}

/** Runs one media-retention purge sweep across every client `listClientIds` returns. */
export async function runOneMediaRetentionPurge(
  deps: MediaRetentionPurgeDeps,
): Promise<MediaRetentionPurgeOutcome> {
  const retentionDays = deps.retentionDays ?? 90;
  const batchLimit = deps.batchLimit ?? 200;
  const cutoff = new Date(deps.now().getTime() - retentionDays * 86_400_000);

  const clientIds = await deps.listClientIds();
  let assetsDeleted = 0;

  for (const clientId of clientIds) {
    const deletedForClient = await deps.tenantDb.withTenant(clientId, (tx) =>
      purgeAgedMediaAssets(tx, deps.objectStore, clientId, cutoff, batchLimit),
    );
    assetsDeleted += deletedForClient;
  }

  return { clientsScanned: clientIds.length, assetsDeleted };
}
