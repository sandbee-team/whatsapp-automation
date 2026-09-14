import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFsObjectStore } from '../../platform/storage/object-store.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import {
  cleanupMirrorProbeClients,
  seedProbeClient,
  type TestPool,
} from './__tests__/mirror-test-support.js';
import { runOneImportRetentionPurge } from './retention-purge.js';

/**
 * retention-purge-row-driven.integration.test.ts (P20 C1 M2) - the object-
 * purge half's ROW-DRIVEN cases (a still-`importing` import keeps its
 * object regardless of age, an old `done` import loses it, orphan objects
 * with no `contact_imports` row are still reclaimed, and a mixed batch's
 * second sweep is a no-op). Split from `retention-purge.integration.test.ts`
 * purely for that file's own 300-line cap (same "independent beforeAll/
 * afterAll per split file" idiom as
 * `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`).
 */

let pool: TestPool;
let probeClientIds: string[] = [];
let rootDir: string;
let store: ObjectStore;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'retention-purge-row-driven-it',
  });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-retention-purge-row-driven-'));
  store = createFsObjectStore({ rootDir });
});

afterEach(async () => {
  await cleanupMirrorProbeClients(pool, probeClientIds);
  probeClientIds = [];
  await rm(rootDir, { recursive: true, force: true });
});

interface SeedImportResult {
  importId: string;
  key: string;
}

/** Inserts one `contact_imports` row + uploads its CSV object, backdating both `created_at` and the object's mtime. */
async function seedImportWithObject(
  clientId: string,
  ageInDays: number,
  status: 'done' | 'failed' | 'cancelled' | 'importing',
): Promise<SeedImportResult> {
  const createdAt = new Date(Date.now() - ageInDays * 86_400_000);
  const importId = randomUUID();
  const attestedByUserId = randomUUID();

  const stored = await store.put({
    clientId,
    kind: 'imports',
    body: Readable.from([Buffer.from('phone\n+15550000000\n')]),
    contentType: 'text/csv',
    maxBytes: 10_000,
    now: createdAt,
    id: importId,
  });
  const absolutePath = path.join(rootDir, ...stored.key.split('/'));
  await utimes(absolutePath, createdAt, createdAt);

  await pool.query(
    `INSERT INTO contact_imports
       (id, client_id, storage_key, mapping, default_country, attestation_text,
        attested_by_user_id, attested_at, status, created_at)
     VALUES ($1, $2, $3, $4, 'IN', 'test attestation', $5, $6, $7, $6)`,
    [
      importId,
      clientId,
      stored.key,
      JSON.stringify({ phone: 'phone' }),
      attestedByUserId,
      createdAt,
      status,
    ],
  );

  return { importId, key: stored.key };
}

/** Uploads an ORPHAN object (no `contact_imports` row references it) - the retention purge's object half must still be able to reclaim these. */
async function seedOrphanObject(clientId: string, ageInDays: number): Promise<string> {
  const createdAt = new Date(Date.now() - ageInDays * 86_400_000);
  const stored = await store.put({
    clientId,
    kind: 'imports',
    body: Readable.from([Buffer.from('phone\n+15550000001\n')]),
    contentType: 'text/csv',
    maxBytes: 10_000,
    now: createdAt,
    id: randomUUID(),
  });
  const absolutePath = path.join(rootDir, ...stored.key.split('/'));
  await utimes(absolutePath, createdAt, createdAt);
  return stored.key;
}

describe('runOneImportRetentionPurge row-driven object half', () => {
  it('an_old_import_still_importing_keeps_its_object', async () => {
    const clientId = await seedProbeClient(pool, 'suite-purge-still-importing');
    probeClientIds.push(clientId);

    const stillRunning = await seedImportWithObject(clientId, 40, 'importing');

    const tenantDb = createTenantDb(pool);
    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore: store,
      listClientIds: async () => [clientId],
      now: () => new Date(),
    });

    expect(result.objectsDeleted).toBe(0);
    expect(await store.head(stillRunning.key)).not.toBeNull();
  });

  it('an_old_done_import_loses_its_object', async () => {
    const clientId = await seedProbeClient(pool, 'suite-purge-old-done');
    probeClientIds.push(clientId);

    const done = await seedImportWithObject(clientId, 40, 'done');

    const tenantDb = createTenantDb(pool);
    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore: store,
      listClientIds: async () => [clientId],
      now: () => new Date(),
    });

    expect(result.objectsDeleted).toBe(1);
    expect(await store.head(done.key)).toBeNull();
  });

  it('an_old_orphan_object_with_no_row_is_deleted', async () => {
    const clientId = await seedProbeClient(pool, 'suite-purge-orphan');
    probeClientIds.push(clientId);

    const orphanKey = await seedOrphanObject(clientId, 40);

    const tenantDb = createTenantDb(pool);
    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore: store,
      listClientIds: async () => [clientId],
      now: () => new Date(),
    });

    expect(result.objectsDeleted).toBe(1);
    expect(await store.head(orphanKey)).toBeNull();
  });

  it('a_second_sweep_after_a_mixed_batch_is_a_no_op', async () => {
    const clientId = await seedProbeClient(pool, 'suite-purge-mixed-noop');
    probeClientIds.push(clientId);

    await seedImportWithObject(clientId, 40, 'importing');
    await seedImportWithObject(clientId, 40, 'done');
    await seedOrphanObject(clientId, 40);

    const tenantDb = createTenantDb(pool);
    const runSweep = () =>
      runOneImportRetentionPurge({
        tenantDb,
        objectStore: store,
        listClientIds: async () => [clientId],
        now: () => new Date(),
      });

    const first = await runSweep();
    expect(first.objectsDeleted).toBe(2); // the done import's object + the orphan, never the still-importing one

    const second = await runSweep();
    expect(second.objectsDeleted).toBe(0);
    expect(second.errorRowsDeleted).toBe(0);
  });
});
