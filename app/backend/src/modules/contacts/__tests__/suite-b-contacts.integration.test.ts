import { rm } from 'node:fs/promises';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createContactImport } from '../import.repo.js';
import { runOneContactImportSweep } from '../import-runner.js';
import {
  buildSuiteBObjectStore,
  buildSuiteBPepperProvider,
  cleanupSuiteBClients,
  seedSuiteBClient,
  suiteBCsv,
  uploadSuiteBCsv,
  type TestPool,
} from './suite-b-test-support.js';

/**
 * suite-b-contacts.integration.test.ts (P20 Unit U8, step 9's suite B) - the
 * resumable CSV import sweep as a two/three-tenant isolation proof
 * (clientA/clientB/clientNeither) - writes land on the right tenant only,
 * checked by CONTENT, including under a deliberate cross-tenant phone
 * collision. The remaining two background paths (mirror reconciler,
 * retention purge) plus the inbound opt-out path live in the sibling
 * `suite-b-contacts-maintenance.integration.test.ts`, split purely for this
 * file's own max-lines cap - same shape as `modules/wallet/__tests__/suite-
 * b-wallet.integration.test.ts`.
 */

let pool: TestPool;
let rootDir: string;
let objectStore: Awaited<ReturnType<typeof buildSuiteBObjectStore>>['store'];
let probeClientIds: string[] = [];

const pepperProvider = buildSuiteBPepperProvider();

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'suite-b-contacts',
  });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  const built = await buildSuiteBObjectStore();
  objectStore = built.store;
  rootDir = built.rootDir;
});

afterEach(async () => {
  await cleanupSuiteBClients(pool, probeClientIds);
  probeClientIds = [];
  await rm(rootDir, { recursive: true, force: true });
});

describe('contacts background paths - two/three-tenant isolation (suite B)', () => {
  it('import_runner_writes_each_tenants_rows_only_to_that_tenant', async () => {
    const a = await seedSuiteBClient(pool, 'suite-b-import-a');
    const b = await seedSuiteBClient(pool, 'suite-b-import-b');
    const neither = await seedSuiteBClient(pool, 'suite-b-import-neither');
    probeClientIds.push(a.clientId, b.clientId, neither.clientId);

    const tenantDb = createTenantDb(pool);
    // A's 20 rows (indices 0-19) and B's 20 rows (indices 15-34) share 5
    // IDENTICAL phones (indices 15-19) - proving cross-tenant isolation even
    // under a deliberate hash/phone collision.
    const csvA = suiteBCsv(20, 0);
    const csvB = suiteBCsv(20, 15);

    const uploadedA = await uploadSuiteBCsv(objectStore, a.clientId, csvA);
    const importA = await tenantDb.withTenant(a.clientId, (tx) =>
      createContactImport(tx, {
        clientId: a.clientId,
        filename: 'a.csv',
        storageKey: uploadedA.key,
        mapping: { phone: 'phone', name: 'name' },
        mappingColumns: ['phone', 'name'],
        defaultCountry: 'IN',
        applyTagIds: [],
        attestationText: 'Suite B tenant A attestation text.',
        attestedByUserId: a.userId,
        now: new Date('2026-01-15T00:00:00.000Z'),
      }),
    );

    const uploadedB = await uploadSuiteBCsv(objectStore, b.clientId, csvB);
    const importB = await tenantDb.withTenant(b.clientId, (tx) =>
      createContactImport(tx, {
        clientId: b.clientId,
        filename: 'b.csv',
        storageKey: uploadedB.key,
        mapping: { phone: 'phone', name: 'name' },
        mappingColumns: ['phone', 'name'],
        defaultCountry: 'IN',
        applyTagIds: [],
        attestationText: 'Suite B tenant B attestation text.',
        attestedByUserId: b.userId,
        now: new Date('2026-01-15T00:00:00.000Z'),
      }),
    );

    const metrics = {
      contactsImportedTotal: { inc: () => undefined },
      contactImportRowsTotal: { inc: () => undefined },
      optoutMirrorDriftTotal: { inc: () => undefined },
    } as never;

    // Sweep repeatedly until both imports are done (each tick processes ONE
    // batch per client - 20 rows fits in a single default-sized batch, but
    // this loop is robust to that changing).
    for (let i = 0; i < 10; i += 1) {
      await runOneContactImportSweep({
        pool,
        tenantDb,
        keyProvider: pepperProvider,
        objectStore,
        metrics,
        maxClientsPerSweep: 50,
      });
      const rowA = await pool.query<{ status: string }>(
        'SELECT status FROM contact_imports WHERE id = $1',
        [importA.id],
      );
      const rowB = await pool.query<{ status: string }>(
        'SELECT status FROM contact_imports WHERE id = $1',
        [importB.id],
      );
      if (rowA.rows[0]?.status === 'done' && rowB.rows[0]?.status === 'done') break;
    }

    const finalA = await pool.query<{ status: string; imported_count: number }>(
      'SELECT status, imported_count FROM contact_imports WHERE id = $1',
      [importA.id],
    );
    expect(finalA.rows[0]?.status).toBe('done');
    expect(finalA.rows[0]?.imported_count).toBe(20);

    const finalB = await pool.query<{ status: string; imported_count: number }>(
      'SELECT status, imported_count FROM contact_imports WHERE id = $1',
      [importB.id],
    );
    expect(finalB.rows[0]?.status).toBe('done');
    expect(finalB.rows[0]?.imported_count).toBe(20);

    const countA = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [a.clientId],
    );
    expect(countA.rows[0]?.count).toBe('20');
    const countB = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [b.clientId],
    );
    expect(countB.rows[0]?.count).toBe('20');
    const countNeither = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [neither.clientId],
    );
    expect(countNeither.rows[0]?.count).toBe('0');

    // The 5 shared phones (indices 15-19) exist under BOTH tenants as
    // separate rows.
    const sharedPhones = [15, 16, 17, 18, 19].map(
      (i) => `+919${String(i).padStart(9, '0').slice(-9)}`,
    );
    const sharedInA = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND phone_e164 = ANY($2)',
      [a.clientId, sharedPhones],
    );
    expect(sharedInA.rows[0]?.count).toBe('5');
    const sharedInB = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND phone_e164 = ANY($2)',
      [b.clientId, sharedPhones],
    );
    expect(sharedInB.rows[0]?.count).toBe('5');
  });
});
