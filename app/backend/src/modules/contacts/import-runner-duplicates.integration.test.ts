import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOneContactImportSweep } from './import-runner.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  createAndAttestImport,
  phoneForIndex,
  recordingMetrics,
  seedClientWithPlan,
  sweepUntilDone,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-runner-duplicates.integration.test.ts (P20 C1 M4, gap fix; NEW-1
 * provenance case added P20 C1 round-3) - split out of
 * `import-runner-limits-and-cursor.integration.test.ts` purely for that
 * file's own max-lines cap.
 *
 * `readImportBatch`'s own dedup (`import-runner-parse.ts#seenE164`) is
 * scoped to ONE batch only, so a repeat in a LATER batch than its original
 * is NOT caught there - it is instead caught by
 * `import-runner-cross-batch-dedupe.ts#findAlreadyWrittenByThisImport`,
 * which queries `contacts` for numbers THIS import already wrote in an
 * earlier batch (`import_id = this OR last_import_id = this`, migration
 * 0062's exact provenance column) before the upsert runs. This test spreads
 * repeats BOTH within a batch AND across batches so both dedup paths are
 * exercised, and asserts the first occurrence's data survives (never
 * overwritten by a later repeat's name). Every assertion is an EXACT
 * expected value, never a bound.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-duplicates-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('within-file duplicates are counted, not inserted', () => {
  it('within_file_duplicates_are_counted_not_inserted', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'within-file-dupes',
      maxContacts: 5000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();

    // 1,200 records = 1,000 unique originals (records 1-1,000) + 200 repeats
    // (records 1,001-1,200, repeating records 1-200) - every repeat lands in
    // batch 3 (records 1,001-1,200) while its original is in batch 1
    // (records 1-500), so EVERY repeat here is a CROSS-batch repeat, never a
    // within-batch one - it can only be caught by the cross-batch DB check,
    // never by `readImportBatch`'s own per-batch `seenE164` set. Each repeat
    // carries a DIFFERENT name so a "first wins" failure is observable.
    const lines = ['phone,name,city'];
    for (let i = 0; i < 1000; i += 1) {
      lines.push(`${phoneForIndex(i)},First ${i},City ${i}`);
    }
    for (let i = 0; i < 200; i += 1) {
      lines.push(`${phoneForIndex(i)},REPEAT NAME ${i},City repeat ${i}`);
    }
    const csv = lines.join('\r\n') + '\r\n';

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    const { row } = await sweepUntilDone(
      {
        pool,
        tenantDb,
        keyProvider,
        objectStore,
        metrics: recordingMetrics().metrics,
        batchSize: 500,
      },
      clientId,
      created.id,
    );

    expect(row.status).toBe('done');
    expect(row.importedCount).toBe(1000);
    expect(row.duplicateCount).toBe(200);
    expect(row.updatedCount).toBe(0);

    const countResult = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [clientId],
    );
    expect(countResult.rows[0]?.count).toBe('1000');

    for (const spotCheckIndex of [0, 50, 199]) {
      const phone = phoneForIndex(spotCheckIndex);
      const contact = await pool.query<{ display_name: string }>(
        'SELECT display_name FROM contacts WHERE client_id = $1 AND phone_e164 = $2',
        [clientId, phone],
      );
      expect(contact.rows[0]?.display_name).toBe(`First ${spotCheckIndex}`);
    }
  });
});

describe('a within-batch repeat is still counted a duplicate, first wins', () => {
  it('within_batch_repeat_is_a_duplicate_first_wins', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'within-batch-dupes',
      maxContacts: 5000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();

    // A single batch (10 records) with one number repeated immediately -
    // caught by `readImportBatch`'s own within-batch `seenE164` set, not the
    // cross-batch DB check.
    const lines = ['phone,name,city'];
    for (let i = 0; i < 9; i += 1) {
      lines.push(`${phoneForIndex(i)},First ${i},City ${i}`);
    }
    lines.push(`${phoneForIndex(0)},REPEAT NAME,City repeat`);
    const csv = lines.join('\r\n') + '\r\n';

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    const { row } = await sweepUntilDone(
      {
        pool,
        tenantDb,
        keyProvider,
        objectStore,
        metrics: recordingMetrics().metrics,
        batchSize: 500,
      },
      clientId,
      created.id,
    );

    expect(row.status).toBe('done');
    expect(row.importedCount).toBe(9);
    expect(row.duplicateCount).toBe(1);
    expect(row.updatedCount).toBe(0);

    const contact = await pool.query<{ display_name: string }>(
      'SELECT display_name FROM contacts WHERE client_id = $1 AND phone_e164 = $2',
      [clientId, phoneForIndex(0)],
    );
    expect(contact.rows[0]?.display_name).toBe('First 0');
  });
});

describe('a contact touched by another actor mid-import is still updated, not dropped', () => {
  it('a_contact_touched_by_another_actor_mid_import_is_still_updated_not_dropped', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'touched-mid-import',
      maxContacts: 5000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();

    // Contact X: pre-existing, created OUTSIDE any import (import_id NULL).
    // X's phone is index 9000 - OUTSIDE the 0-1,198 range used for the other
    // 1,199 unique numbers below, so it never collides with them. The file
    // is 1,200 UNIQUE numbers total (no genuine repeats here - that case is
    // covered unchanged by the sibling tests above); X sits at record 1,001
    // (batch 3, records 1,001-1,500), its ONLY occurrence in this file.
    const targetPhone = phoneForIndex(9000);
    const contactId = randomUUID();
    await pool.query(
      `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, display_name, source)
       VALUES ($1, $2, $3, $4, $5, 'Old', 'manual')`,
      [
        contactId,
        clientId,
        targetPhone,
        randomBytes(32),
        `${targetPhone.replace('+', '')}@s.whatsapp.net`,
      ],
    );

    const lines = ['phone,name,city'];
    for (let i = 0; i < 1000; i += 1) {
      lines.push(`${phoneForIndex(i)},First ${i},City ${i}`);
    }
    lines.push(`${targetPhone},From Import,City target`);
    for (let i = 1000; i < 1199; i += 1) {
      lines.push(`${phoneForIndex(i)},First ${i},City ${i}`);
    }
    const csv = lines.join('\r\n') + '\r\n';

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    const deps = {
      pool,
      tenantDb,
      keyProvider,
      objectStore,
      metrics: recordingMetrics().metrics,
      batchSize: 500,
      maxClientsPerSweep: 50,
    };

    // Sweep batch 1 and batch 2 only (records 1-999, X not yet reached).
    await runOneContactImportSweep(deps);
    await runOneContactImportSweep(deps);

    // Another actor (a panel PATCH / inbound event / the nightly mirror
    // reconciler) touches X mid-import, stamping updated_at = now() - the
    // OLD time-based heuristic would misclassify X's upcoming first-in-
    // import occurrence (batch 3) as a duplicate on this alone.
    await pool.query(
      `UPDATE contacts SET display_name = 'Touched', updated_at = now() WHERE id = $1`,
      [contactId],
    );

    const { row } = await sweepUntilDone(deps, clientId, created.id);

    expect(row.status).toBe('done');
    expect(row.importedCount).toBe(1199);
    expect(row.updatedCount).toBe(1);
    expect(row.duplicateCount).toBe(0);

    const contact = await pool.query<{
      display_name: string;
      import_id: string | null;
      last_import_id: string | null;
    }>(
      'SELECT display_name, import_id, last_import_id FROM contacts WHERE client_id = $1 AND id = $2',
      [clientId, contactId],
    );
    expect(contact.rows[0]?.display_name).toBe('From Import');
    expect(contact.rows[0]?.import_id).toBeNull();
    expect(contact.rows[0]?.last_import_id).toBe(created.id);
  });
});
