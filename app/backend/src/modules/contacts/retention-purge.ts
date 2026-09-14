import { bindQueryParams, loadQuery, type TenantDb, type TenantQueryable } from '@wp/db';
import {
  assertTenantKey,
  importsPrefix,
  type ObjectStore,
} from '../../platform/storage/object-store.js';

/**
 * retention-purge.ts (P20 Unit U7, step 8; P20 C1 M2) - the 30-day import
 * retention purge: deletes `contact_import_errors` rows and their imports'
 * uploaded CSV objects once the import is older than `retentionDays`. NEVER
 * deletes `contact_imports` rows or `contacts`, and never touches
 * `opt_outs` (see `optout-mirror.test.ts`'s static proof) - only the two
 * capped-retention artifacts named above.
 *
 * Two independent halves per client, both bounded (ADR 0018 S4):
 *  1. `db/queries/purge-import-errors.sql` via `tenantDb.withTenant` -
 *     capped at `batchLimit` error rows.
 *  2. The OBJECT half is ROW-DRIVEN (M2 fix - `objectStore.list(...,
 *     {olderThan})` alone selects on mtime only and would delete the
 *     source CSV of a still-running import): `purge-terminal-import-
 *     objects.sql` selects `contact_imports` rows gated on `status IN
 *     ('done', 'failed', 'cancelled')` - a still-`uploaded`/`importing`
 *     import's object is NEVER touched regardless of age - then each
 *     candidate key is `head`ed (already-gone = the idempotency marker, no
 *     column needed) and `delete`d. ORPHAN objects (an upload attested
 *     directly as a `contact_imports` row always exists per
 *     `createContactImport`, but a NEVER-attested upload has no row at
 *     all) are handled separately: the prefix `list({ olderThan })` scan
 *     still runs, but a listed key is only deleted when NO
 *     `contact_imports` row for this client references it at all -  an
 *     object referenced by any row, terminal or not, is governed by the
 *     row-driven half above exclusively.
 *
 * `listClientIds` is an INJECTED port, same as `mirror-reconcile.ts` (this
 * unit needs no cross-tenant SQL and no registry entry - a later unit wires
 * cron + the real client registry).
 */

export interface RetentionPurgeDeps {
  tenantDb: TenantDb;
  objectStore: ObjectStore;
  listClientIds: () => Promise<string[]>;
  /** Injected clock (core invariants: no ambient wall-clock reads in a derivation). */
  now: () => Date;
  /** Defaults 30. */
  retentionDays?: number;
  /** Bounded per-client, per-half batch size. Defaults 200. */
  batchLimit?: number;
}

export interface RetentionPurgeOutcome {
  clientsScanned: number;
  errorRowsDeleted: number;
  objectsDeleted: number;
}

interface RawTerminalImportRow extends Record<string, unknown> {
  id: string;
  storage_key: string;
}

/** The row-driven object half (M2): deletes ONLY objects belonging to a terminal-status import older than `cutoff` - never a still-`uploaded`/`importing` one, regardless of its object's age. */
async function purgeTerminalImportObjects(
  tx: TenantQueryable,
  objectStore: ObjectStore,
  clientId: string,
  cutoff: Date,
  batchLimit: number,
): Promise<number> {
  const query = await loadQuery('purge-terminal-import-objects');
  const result = await tx.query<RawTerminalImportRow>(
    query.text,
    bindQueryParams(query, { client_id: clientId, cutoff, limit: batchLimit }),
  );

  let deleted = 0;
  for (const row of result.rows) {
    assertTenantKey(row.storage_key, clientId);
    const head = await objectStore.head(row.storage_key);
    if (head === null) continue; // already gone - the idempotency marker, no column needed
    await objectStore.delete(row.storage_key);
    deleted += 1;
  }
  return deleted;
}

/** The orphan-object half (M2): a listed key with NO `contact_imports` row at all for this client is deleted directly - any key that DOES have a row (terminal or not) is governed by `purgeTerminalImportObjects` exclusively. */
async function purgeOrphanObjects(
  tx: TenantQueryable,
  objectStore: ObjectStore,
  clientId: string,
  cutoff: Date,
  batchLimit: number,
): Promise<number> {
  const listedKeys: string[] = [];
  for await (const obj of objectStore.list(importsPrefix(clientId), {
    olderThan: cutoff,
    limit: batchLimit,
  })) {
    listedKeys.push(obj.key);
  }
  if (listedKeys.length === 0) return 0;

  const referenced = await tx.query<{ storage_key: string }>(
    `SELECT storage_key FROM contact_imports
      WHERE client_id = $1 AND storage_key = ANY($2::text[])
      -- client_id = $1`,
    [clientId, listedKeys],
  );
  const referencedKeys = new Set(referenced.rows.map((r) => r.storage_key));

  let deleted = 0;
  for (const key of listedKeys) {
    if (referencedKeys.has(key)) continue;
    await objectStore.delete(key);
    deleted += 1;
  }
  return deleted;
}

/** Runs one import-retention purge sweep across every client `listClientIds` returns. */
export async function runOneImportRetentionPurge(
  deps: RetentionPurgeDeps,
): Promise<RetentionPurgeOutcome> {
  const retentionDays = deps.retentionDays ?? 30;
  const batchLimit = deps.batchLimit ?? 200;
  const cutoff = new Date(deps.now().getTime() - retentionDays * 86_400_000);

  const clientIds = await deps.listClientIds();
  const errorsQuery = await loadQuery('purge-import-errors');

  let errorRowsDeleted = 0;
  let objectsDeleted = 0;

  for (const clientId of clientIds) {
    const [errorsDeletedForClient, terminalDeleted] = await deps.tenantDb.withTenant(
      clientId,
      async (tx) => {
        const errorsResult = await tx.query(
          errorsQuery.text,
          bindQueryParams(errorsQuery, { client_id: clientId, cutoff, limit: batchLimit }),
        );
        const terminal = await purgeTerminalImportObjects(
          tx,
          deps.objectStore,
          clientId,
          cutoff,
          batchLimit,
        );
        return [errorsResult.rowCount ?? 0, terminal] as const;
      },
    );
    errorRowsDeleted += errorsDeletedForClient;
    objectsDeleted += terminalDeleted;

    const orphanDeleted = await deps.tenantDb.withTenant(clientId, (tx) =>
      purgeOrphanObjects(tx, deps.objectStore, clientId, cutoff, batchLimit),
    );
    objectsDeleted += orphanDeleted;
  }

  return { clientsScanned: clientIds.length, errorRowsDeleted, objectsDeleted };
}
