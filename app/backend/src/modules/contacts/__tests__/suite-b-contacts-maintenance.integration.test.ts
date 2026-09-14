import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { hashRecipient } from '../../../platform/crypto/phone-hash.js';
import { detectInboundOptOut } from '../../inbound/optout-detect.js';
import { runOneMirrorReconcileSweep } from '../mirror-reconcile.js';
import { runOneImportRetentionPurge } from '../retention-purge.js';
import { syncOptOutMirror } from '../optout-mirror.js';
import { listActiveClientIds } from '../../../engine/cron/cron-wiring-contacts-maintenance.js';
import {
  buildSuiteBObjectStore,
  buildSuiteBPepperProvider,
  cleanupSuiteBClients,
  insertSuiteBContact,
  insertSuiteBLiveOptOut,
  seedSuiteBClient,
  seedSuiteBImportWithObject,
  type TestPool,
} from './suite-b-test-support.js';

/**
 * suite-b-contacts-maintenance.integration.test.ts (P20 Unit U8, step 9's
 * suite B) - split out of `suite-b-contacts.integration.test.ts` purely for
 * that file's own max-lines cap (same split idiom as `session-worker-
 * discovery-wiring.ts`). Covers the remaining two background paths (the
 * nightly opt-out mirror reconciler, the hourly import retention purge) plus
 * the inbound opt-out detection path, each as a two/three-tenant isolation
 * proof (clientA/clientB/clientNeither) - writes land on the right tenant
 * only, checked by CONTENT.
 */

let pool: TestPool;
let rootDir: string;
let objectStore: Awaited<ReturnType<typeof buildSuiteBObjectStore>>['store'];
let probeClientIds: string[] = [];

const pepperProvider = buildSuiteBPepperProvider();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'suite-b-contacts-maintenance',
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

describe('contacts maintenance sweeps - two/three-tenant isolation (suite B)', () => {
  it('mirror_reconciler_repairs_only_the_scanned_tenants_rows', async () => {
    const a = await seedSuiteBClient(pool, 'suite-b-mirror-a');
    const b = await seedSuiteBClient(pool, 'suite-b-mirror-b');
    const neither = await seedSuiteBClient(pool, 'suite-b-mirror-neither');
    probeClientIds.push(a.clientId, b.clientId, neither.clientId);

    const phoneHashA = Buffer.alloc(32, 0x11);
    const phoneHashB = Buffer.alloc(32, 0x22);
    const phoneHashNeither = Buffer.alloc(32, 0x33);

    const contactA = await insertSuiteBContact(pool, a.clientId, phoneHashA, 'none');
    const contactB = await insertSuiteBContact(pool, b.clientId, phoneHashB, 'none');
    const contactNeither = await insertSuiteBContact(
      pool,
      neither.clientId,
      phoneHashNeither,
      'none',
    );

    const optOutACreatedAt = new Date(Date.now() - 60_000);
    await insertSuiteBLiveOptOut(pool, a.clientId, phoneHashA, optOutACreatedAt);
    const optOutBCreatedAt = new Date(Date.now() - 30_000);
    await insertSuiteBLiveOptOut(pool, b.clientId, phoneHashB, optOutBCreatedAt);
    // Neither: no opt_outs row - no drift, must stay byte-identical.

    const optOutsSnapshotBefore = await pool.query(
      'SELECT * FROM opt_outs WHERE client_id = ANY($1) ORDER BY id',
      [[a.clientId, b.clientId, neither.clientId]],
    );
    const snapshotBefore = JSON.stringify(optOutsSnapshotBefore.rows);
    const neitherRowBefore = await pool.query('SELECT * FROM contacts WHERE id = $1', [
      contactNeither,
    ]);

    const tenantDb = createTenantDb(pool);
    const driftCalls: number[] = [];
    const result = await runOneMirrorReconcileSweep({
      tenantDb,
      listClientIds: () => listActiveClientIds(pool, { afterId: NIL_UUID, limit: 5000 }),
      metrics: { incOptoutMirrorDrift: (n) => driftCalls.push(n) },
    });
    expect(result.contactsRepaired).toBeGreaterThanOrEqual(2);

    const rowA = await pool.query<{ opt_out_state: string; opted_out_at: Date | null }>(
      'SELECT opt_out_state, opted_out_at FROM contacts WHERE id = $1',
      [contactA],
    );
    expect(rowA.rows[0]?.opt_out_state).toBe('opted_out');
    expect(rowA.rows[0]?.opted_out_at?.toISOString()).toBe(optOutACreatedAt.toISOString());

    const rowB = await pool.query<{ opt_out_state: string; opted_out_at: Date | null }>(
      'SELECT opt_out_state, opted_out_at FROM contacts WHERE id = $1',
      [contactB],
    );
    expect(rowB.rows[0]?.opt_out_state).toBe('opted_out');
    expect(rowB.rows[0]?.opted_out_at?.toISOString()).toBe(optOutBCreatedAt.toISOString());

    const neitherRowAfter = await pool.query('SELECT * FROM contacts WHERE id = $1', [
      contactNeither,
    ]);
    expect(JSON.stringify(neitherRowAfter.rows)).toBe(JSON.stringify(neitherRowBefore.rows));

    const optOutsSnapshotAfter = await pool.query(
      'SELECT * FROM opt_outs WHERE client_id = ANY($1) ORDER BY id',
      [[a.clientId, b.clientId, neither.clientId]],
    );
    expect(JSON.stringify(optOutsSnapshotAfter.rows)).toBe(snapshotBefore);
  });

  it('retention_purge_deletes_only_expired_objects_of_each_tenant', async () => {
    const a = await seedSuiteBClient(pool, 'suite-b-purge-a');
    const b = await seedSuiteBClient(pool, 'suite-b-purge-b');
    const neither = await seedSuiteBClient(pool, 'suite-b-purge-neither');
    probeClientIds.push(a.clientId, b.clientId, neither.clientId);

    const oldA = await seedSuiteBImportWithObject(
      pool,
      objectStore,
      rootDir,
      a.clientId,
      a.userId,
      31,
      3,
    );
    const oldB = await seedSuiteBImportWithObject(
      pool,
      objectStore,
      rootDir,
      b.clientId,
      b.userId,
      35,
      2,
    );
    const freshNeither = await seedSuiteBImportWithObject(
      pool,
      objectStore,
      rootDir,
      neither.clientId,
      neither.userId,
      1,
      4,
    );

    const tenantDb = createTenantDb(pool);
    const fixedNow = new Date();
    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore,
      listClientIds: () => listActiveClientIds(pool, { afterId: NIL_UUID, limit: 5000 }),
      now: () => fixedNow,
    });
    expect(result.errorRowsDeleted).toBeGreaterThanOrEqual(5);
    expect(result.objectsDeleted).toBeGreaterThanOrEqual(2);

    const errorsA = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_errors WHERE import_id = $1',
      [oldA.importId],
    );
    expect(errorsA.rows[0]?.count).toBe('0');
    const errorsB = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_errors WHERE import_id = $1',
      [oldB.importId],
    );
    expect(errorsB.rows[0]?.count).toBe('0');
    const errorsNeither = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_errors WHERE import_id = $1',
      [freshNeither.importId],
    );
    expect(errorsNeither.rows[0]?.count).toBe('4');

    expect(await objectStore.head(oldA.key)).toBeNull();
    expect(await objectStore.head(oldB.key)).toBeNull();
    expect(await objectStore.head(freshNeither.key)).not.toBeNull();

    // Every contact_imports row is intact (this sweep never deletes them).
    const importsIntact = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE id = ANY($1)',
      [[oldA.importId, oldB.importId, freshNeither.importId]],
    );
    expect(importsIntact.rows[0]?.count).toBe('3');
  });

  it('an_inbound_opt_out_flips_only_that_tenants_mirror', async () => {
    const a = await seedSuiteBClient(pool, 'suite-b-inbound-a');
    const b = await seedSuiteBClient(pool, 'suite-b-inbound-b');
    probeClientIds.push(a.clientId, b.clientId);

    const senderE164 = '+15556667777';
    const phoneHash = hashRecipient(pepperProvider, senderE164);

    const contactA = await insertSuiteBContact(pool, a.clientId, phoneHash, 'none');
    const contactB = await insertSuiteBContact(pool, b.clientId, phoneHash, 'none');

    const tenantDb = createTenantDb(pool);
    await tenantDb.withTenant(a.clientId, async (tx) => {
      const result = await detectInboundOptOut(
        { tx, provider: pepperProvider, mirror: syncOptOutMirror },
        {
          clientId: a.clientId,
          instanceId: randomUUID(),
          senderJid: `${senderE164.replace('+', '')}@s.whatsapp.net`,
          senderE164,
          text: 'STOP',
          tenantKeywords: [],
        },
      );
      expect(result.attributed).toBe(true);
    });

    const rowA = await pool.query<{ opt_out_state: string }>(
      'SELECT opt_out_state FROM contacts WHERE id = $1',
      [contactA],
    );
    expect(rowA.rows[0]?.opt_out_state).toBe('opted_out');
    const optOutsA = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
      [a.clientId, phoneHash],
    );
    expect(optOutsA.rows[0]?.count).toBe('1');

    const rowB = await pool.query<{ opt_out_state: string }>(
      'SELECT opt_out_state FROM contacts WHERE id = $1',
      [contactB],
    );
    expect(rowB.rows[0]?.opt_out_state).toBe('none');
    const optOutsB = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
      [b.clientId, phoneHash],
    );
    expect(optOutsB.rows[0]?.count).toBe('0');
  });
});
