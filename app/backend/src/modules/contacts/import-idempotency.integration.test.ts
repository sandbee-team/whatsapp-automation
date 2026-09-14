import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { recordOptOut } from '../pacing/index.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  createAndAttestImport,
  generateCsv,
  noOpMetrics,
  phoneForIndex,
  seedClientWithPlan,
  sweepUntilDone,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-idempotency.integration.test.ts (P20 Unit U5, step 6) - the
 * re-upload and opt-out-preservation halves of the resumable CSV import
 * sweep, split from `import.integration.test.ts` (bounded-batch/crash
 * cases) purely for that file's own max-lines cap - same idiom as
 * `reconcile.integration.test.ts`/`reconcile-checks.integration.test.ts`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-idempotency-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('re-uploading the same file', () => {
  it('re_uploading_the_same_file_adds_no_rows', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'reupload',
      maxContacts: 30000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const csv = generateCsv(10000);

    const first = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });
    const { row: firstRow } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: noOpMetrics() },
      clientId,
      first.id,
    );
    expect(firstRow.status).toBe('done');

    const second = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });
    const { row: secondRow } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: noOpMetrics() },
      clientId,
      second.id,
    );

    expect(secondRow.status).toBe('done');
    expect(secondRow.importedCount).toBe(0);
    expect(secondRow.updatedCount).toBe(10000);

    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1',
      [clientId],
    );
    expect(Number(count.rows[0]?.count)).toBe(10000);

    const finishedAtRow = await pool.query<{ finished_at: Date }>(
      'SELECT finished_at FROM contact_imports WHERE id = $1',
      [first.id],
    );
    const firstFinishedAt = finishedAtRow.rows[0]?.finished_at;
    expect(firstFinishedAt).toBeDefined();

    const updatedAts = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM contacts WHERE client_id = $1',
      [clientId],
    );
    for (const r of updatedAts.rows) {
      expect(r.updated_at.getTime()).toBeGreaterThan(firstFinishedAt!.getTime());
    }
  });
});

describe('an import never clears an existing opt-out', () => {
  it('import_never_clears_an_existing_opt_out', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, { label: 'preserve-optout' });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const targetPhone = phoneForIndex(0);
    const phoneHash = hashRecipient(keyProvider, targetPhone);

    await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'manual',
        },
        // No contacts mirror wiring needed in this suite - it proves the
        // IMPORT never clears an opt-out, not the mirror port itself (that
        // is optout-mirror.integration.test.ts's own case).
        { mirror: async () => ({ contactsUpdated: 0 }) },
      ),
    );
    const optOutRow = await pool.query<{ created_at: Date }>(
      'SELECT created_at FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
      [clientId, phoneHash],
    );
    const optOutCreatedAt = optOutRow.rows[0]?.created_at;
    expect(optOutCreatedAt).toBeDefined();

    const csv = generateCsv(5);
    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });
    await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: noOpMetrics() },
      clientId,
      created.id,
    );

    const contactRow = await pool.query<{ opt_out_state: string; opted_out_at: Date }>(
      'SELECT opt_out_state, opted_out_at FROM contacts WHERE client_id = $1 AND phone_e164 = $2',
      [clientId, targetPhone],
    );
    expect(contactRow.rows[0]?.opt_out_state).toBe('opted_out');
    expect(contactRow.rows[0]?.opted_out_at?.toISOString()).toBe(optOutCreatedAt!.toISOString());

    // Re-import the SAME file: still opted-out, timestamp unchanged.
    const second = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });
    const { row: secondRow } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: noOpMetrics() },
      clientId,
      second.id,
    );
    expect(secondRow.optedOutCount).toBe(1);

    const contactRowAgain = await pool.query<{ opt_out_state: string; opted_out_at: Date }>(
      'SELECT opt_out_state, opted_out_at FROM contacts WHERE client_id = $1 AND phone_e164 = $2',
      [clientId, targetPhone],
    );
    expect(contactRowAgain.rows[0]?.opt_out_state).toBe('opted_out');
    expect(contactRowAgain.rows[0]?.opted_out_at?.toISOString()).toBe(
      optOutCreatedAt!.toISOString(),
    );

    // STATIC proof: the DO UPDATE SET clause never mentions opt_out_state/opted_out_at.
    const sqlText = await readFile(
      new URL('../../../../../db/queries/upsert-import-contacts.sql', import.meta.url),
      'utf8',
    );
    // Skip the header prose (which quotes "DO UPDATE SET" in its own
    // explanation) and start scanning only from the actual statement.
    const statementStart = sqlText.indexOf('-- name: upsert-import-contacts');
    const doUpdateStart = sqlText.indexOf('DO UPDATE SET', statementStart);
    const returningStart = sqlText.indexOf('RETURNING', doUpdateStart);
    const doUpdateClause = sqlText.slice(doUpdateStart, returningStart);
    expect(doUpdateClause).not.toContain('opt_out_state');
    expect(doUpdateClause).not.toContain('opted_out_at');
    expect(sqlText).toContain('opt_outs');
    expect(sqlText).toContain('phone_hash');
  });
});
