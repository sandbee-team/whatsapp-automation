import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOneContactImportSweep } from './import-runner.js';
import { getContactImport, lastErrorReason } from './import.repo.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  createAndAttestImport,
  generateCsv,
  recordingMetrics,
  seedClientWithPlan,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-runner-failures.integration.test.ts (P20 C1 M1) - proves a poison
 * import (its source object deleted after attestation) can no longer stall
 * every other tenant's imports in the same sweep: the sweep classifies the
 * failure, marks THAT import `failed` with a durable row-0 error reason, and
 * continues to the next client in the SAME tick.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-runner-failures-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('one poison import never stalls another tenant in the same sweep', () => {
  it('tenant_a_source_object_missing_is_failed_and_tenant_b_still_processes_normally', async () => {
    const tenantA = await seedClientWithPlan(pool, { label: 'poison-a', maxContacts: 100 });
    const tenantB = await seedClientWithPlan(pool, { label: 'poison-b', maxContacts: 100 });
    createdClientIds.push(tenantA.clientId, tenantB.clientId);

    const objectStore = buildTestObjectStore();

    const importA = await createAndAttestImport(tenantDb, objectStore, {
      clientId: tenantA.clientId,
      userId: tenantA.userId,
      csvText: generateCsv(5, { startIndex: 0 }),
    });
    // Simulate the uploaded object having been purged after attestation -
    // the exact "poison" shape: a claimable row whose object is gone.
    await tenantDb.withTenant(tenantA.clientId, async (tx) => {
      const row = await getContactImport(tx, tenantA.clientId, importA.id);
      if (row) await objectStore.delete(row.storageKey);
    });

    const importB = await createAndAttestImport(tenantDb, objectStore, {
      clientId: tenantB.clientId,
      userId: tenantB.userId,
      csvText: generateCsv(5, { startIndex: 500 }),
    });

    const { metrics, countsByResult } = recordingMetrics();

    const result = await runOneContactImportSweep({
      pool,
      tenantDb,
      keyProvider,
      objectStore,
      metrics,
      maxClientsPerSweep: 50,
    });

    // The sweep itself never rejects.
    expect(result).toBeDefined();

    const rowA = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      getContactImport(tx, tenantA.clientId, importA.id),
    );
    expect(rowA?.status).toBe('failed');
    expect(rowA?.finishedAt).not.toBeNull();

    const reasonA = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      lastErrorReason(tx, tenantA.clientId, importA.id),
    );
    expect(reasonA).toBe('source_object_missing');
    expect(countsByResult.get('failed')).toBe(1);

    const rowB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      getContactImport(tx, tenantB.clientId, importB.id),
    );
    expect(rowB?.status).toBe('done');
    expect(rowB?.importedCount).toBe(5);

    // A second sweep never re-claims A's failed import (a failed import is
    // never re-claimed - the "stranded forever" case is closed).
    const secondResult = await runOneContactImportSweep({
      pool,
      tenantDb,
      keyProvider,
      objectStore,
      metrics,
      maxClientsPerSweep: 50,
    });
    expect(secondResult.importsTouched).toBe(0);

    const rowAAfter = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      getContactImport(tx, tenantA.clientId, importA.id),
    );
    expect(rowAAfter?.status).toBe('failed');
  });
});
