import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOneContactImportSweep } from './import-runner.js';
import { getContactImport } from './import.repo.js';
import { ObjectNotFoundError } from '../../platform/storage/object-store.js';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  createAndAttestImport,
  generateCsv,
  noOpMetrics,
  seedClientWithPlan,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-runner-concurrency-c2.integration.test.ts (C2 hardening) - two
 * behaviours the C2 brief calls out as priority edge cases for the import
 * runner: double-claim safety under a genuine race (two concurrent sweeps
 * against the SAME pending import), and the runner's behaviour when its
 * object-store dependency fails/hangs rather than succeeding cleanly.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-runner-c2-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('two concurrent sweeps racing on the SAME pending import', () => {
  it('never_double_processes_a_batch_final_counts_match_the_row_count_exactly', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'race-double-claim',
      maxContacts: 5000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const rowCount = 1200; // several 500-row batches, so the race spans multiple ticks
    const csv = generateCsv(rowCount);

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    // Two sweeps racing concurrently against the same claimable import: the
    // `FOR UPDATE SKIP LOCKED` claim plus the `status IN ('uploaded',
    // 'importing')` predicate must make exactly one of them win each tick -
    // never both processing the same rows. We race repeatedly (not once)
    // because a single race only proves the invariant held for one
    // interleaving; the DB-level lock is what we are actually asserting, so
    // we drive enough concurrent ticks to exhaust the whole file.
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 40) throw new Error('test guard: import did not finish in time');

      const rowBefore = await tenantDb.withTenant(clientId, (tx) =>
        getContactImport(tx, clientId, created.id),
      );
      if (!rowBefore || (rowBefore.status !== 'uploaded' && rowBefore.status !== 'importing')) {
        break;
      }

      await Promise.all([
        runOneContactImportSweep({
          pool,
          tenantDb,
          keyProvider,
          objectStore,
          metrics: noOpMetrics(),
          maxClientsPerSweep: 50,
        }),
        runOneContactImportSweep({
          pool,
          tenantDb,
          keyProvider,
          objectStore,
          metrics: noOpMetrics(),
          maxClientsPerSweep: 50,
        }),
      ]);
    }

    const final = await tenantDb.withTenant(clientId, (tx) =>
      getContactImport(tx, clientId, created.id),
    );
    expect(final?.status).toBe('done');
    // The invariant under test, not a sampled "who won" count: the total
    // rows processed must equal the file's row count EXACTLY - a
    // double-processed batch would inflate imported_count/cursor_row past
    // rowCount, and a lost batch would leave it short.
    expect(final?.cursorRow).toBe(rowCount);
    expect(final?.importedCount).toBe(rowCount);
    expect((final?.importedCount ?? 0) + (final?.updatedCount ?? 0)).toBe(rowCount);

    const liveCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId],
    );
    expect(liveCount.rows[0]?.count).toBe(String(rowCount));
  });
});

describe('the object store fails rather than succeeding', () => {
  it('getStream_rejecting_with_ObjectNotFoundError_should_not_strand_the_import_forever', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'store-rejects',
      maxContacts: 100,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: generateCsv(5),
    });

    // Simulate the uploaded object having been purged (or never existing) -
    // exactly the case `readImportBatch`/`processOneClientBatch` never
    // catches around `objectStore.getStream`.
    const failingStore: ObjectStore = {
      ...objectStore,
      async getStream(key: string) {
        throw new ObjectNotFoundError(key);
      },
    };

    // FIXED (P20 C1 M1): the sweep resolves - it never rejects on a
    // per-client failure. `import-runner.ts`'s per-client try/catch
    // classifies `ObjectNotFoundError` as `source_object_missing`, marks
    // the import `failed` with a durable row-0 error row in a fresh
    // transaction, and continues (never stalling other clients either).
    const result = await runOneContactImportSweep({
      pool,
      tenantDb,
      keyProvider,
      objectStore: failingStore,
      metrics: noOpMetrics(),
      maxClientsPerSweep: 50,
    });
    expect(result.importsFailed).toBe(1);

    const row = await tenantDb.withTenant(clientId, (tx) =>
      getContactImport(tx, clientId, created.id),
    );
    expect(row?.status).toBe('failed');
    expect(row?.finishedAt).not.toBeNull();

    const errorRows = await pool.query<{ row_no: string; reason: string }>(
      'SELECT row_no, reason FROM contact_import_errors WHERE client_id = $1 AND import_id = $2',
      [clientId, created.id],
    );
    expect(errorRows.rows).toEqual([{ row_no: '0', reason: 'source_object_missing' }]);

    // A second sweep never re-touches a failed import - it is no longer
    // claimable (`status IN ('uploaded', 'importing')` excludes it).
    const secondResult = await runOneContactImportSweep({
      pool,
      tenantDb,
      keyProvider,
      objectStore: failingStore,
      metrics: noOpMetrics(),
      maxClientsPerSweep: 50,
    });
    expect(secondResult.importsTouched).toBe(0);
    expect(secondResult.importsFailed).toBe(0);
  });
});
