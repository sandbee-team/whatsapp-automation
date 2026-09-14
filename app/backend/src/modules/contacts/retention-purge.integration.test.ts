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
 * retention-purge.integration.test.ts (P20 Unit U7, step 8) - real-Postgres
 * + real-fs proof that the 30-day import retention purge deletes only
 * `contact_import_errors` rows and their uploaded CSV objects older than the
 * cutoff, is bounded/idempotent, and never crosses tenants. Never touches
 * `contact_imports` rows or `contacts` (asserted directly).
 */

let pool: TestPool;
let probeClientIds: string[] = [];
let rootDir: string;
let store: ObjectStore;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'retention-purge-it',
  });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-retention-purge-'));
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
  errorRowCount: number,
  status: 'done' | 'failed' | 'cancelled' | 'importing' = 'done',
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

  for (let rowNo = 0; rowNo < errorRowCount; rowNo += 1) {
    await pool.query(
      `INSERT INTO contact_import_errors (import_id, client_id, row_no, reason)
       VALUES ($1, $2, $3, 'invalid phone')`,
      [importId, clientId, rowNo],
    );
  }

  return { importId, key: stored.key };
}

async function countErrorRows(importId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM contact_import_errors WHERE import_id = $1',
    [importId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function importStillExists(importId: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM contact_imports WHERE id = $1', [importId]);
  return result.rowCount === 1;
}

describe('runOneImportRetentionPurge', () => {
  it('purge_deletes_only_objects_and_error_rows_older_than_thirty_days', async () => {
    const clientId = await seedProbeClient(pool, 'suite-purge-basic');
    probeClientIds.push(clientId);

    const oldImport = await seedImportWithObject(clientId, 31, 5);
    const newImport = await seedImportWithObject(clientId, 1, 5);

    const contactPhoneHash = Buffer.alloc(32, 0x01);
    const otherContactPhoneHash = Buffer.alloc(32, 0x02);
    await pool.query(
      `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source)
       VALUES ($1, $2, $3, $4, 'manual'), ($1, $5, $6, $7, 'manual')`,
      [
        clientId,
        '+15559990001',
        contactPhoneHash,
        '15559990001@s.whatsapp.net',
        '+15559990002',
        otherContactPhoneHash,
        '15559990002@s.whatsapp.net',
      ],
    );

    const tenantDb = createTenantDb(pool);
    const fixedNow = new Date();
    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore: store,
      listClientIds: async () => [clientId],
      now: () => fixedNow,
    });

    expect(result.errorRowsDeleted).toBe(5);
    expect(result.objectsDeleted).toBe(1);

    expect(await countErrorRows(oldImport.importId)).toBe(0);
    expect(await countErrorRows(newImport.importId)).toBe(5);

    expect(await store.head(oldImport.key)).toBeNull();
    expect(await store.head(newImport.key)).not.toBeNull();

    expect(await importStillExists(oldImport.importId)).toBe(true);
    expect(await importStillExists(newImport.importId)).toBe(true);

    const contactsCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [clientId],
    );
    expect(contactsCount.rows[0]?.count).toBe('2');
  });

  it('purge_is_bounded_and_idempotent', async () => {
    const clientId = await seedProbeClient(pool, 'suite-purge-bounded');
    probeClientIds.push(clientId);

    const imports = await Promise.all([
      seedImportWithObject(clientId, 35, 3),
      seedImportWithObject(clientId, 40, 2),
      seedImportWithObject(clientId, 45, 2),
    ]);
    expect(imports).toHaveLength(3); // 3 objects, 7 error rows total

    const tenantDb = createTenantDb(pool);
    const fixedNow = new Date();
    const runSweep = () =>
      runOneImportRetentionPurge({
        tenantDb,
        objectStore: store,
        listClientIds: async () => [clientId],
        now: () => fixedNow,
        batchLimit: 3,
      });

    const sweep1 = await runSweep();
    expect(sweep1.errorRowsDeleted).toBe(3);
    expect(sweep1.objectsDeleted).toBe(3);

    const sweep2 = await runSweep();
    expect(sweep2.errorRowsDeleted).toBe(3);
    expect(sweep2.objectsDeleted).toBe(0);

    const sweep3 = await runSweep();
    expect(sweep3.errorRowsDeleted).toBe(1);
    expect(sweep3.objectsDeleted).toBe(0);

    const sweep4 = await runSweep();
    expect(sweep4.errorRowsDeleted).toBe(0);
    expect(sweep4.objectsDeleted).toBe(0);
  });

  it('purge_never_crosses_tenants', async () => {
    const clientA = await seedProbeClient(pool, 'suite-purge-tenant-a');
    const clientB = await seedProbeClient(pool, 'suite-purge-tenant-b');
    probeClientIds.push(clientA, clientB);

    const importB = await seedImportWithObject(clientB, 40, 4);

    const tenantDb = createTenantDb(pool);
    const fixedNow = new Date();
    const result = await runOneImportRetentionPurge({
      tenantDb,
      objectStore: store,
      listClientIds: async () => [clientA],
      now: () => fixedNow,
    });

    expect(result.errorRowsDeleted).toBe(0);
    expect(result.objectsDeleted).toBe(0);
    expect(await countErrorRows(importB.importId)).toBe(4);
    expect(await store.head(importB.key)).not.toBeNull();
  });
});

// The M2 row-driven-object-purge cases (still-importing keeps its object,
// old-done loses it, orphan objects, and the mixed-batch no-op) live in the
// sibling `retention-purge-row-driven.integration.test.ts` purely for this
// file's own 300-line cap (same "independent beforeAll/afterAll per split
// file" idiom as `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`).
