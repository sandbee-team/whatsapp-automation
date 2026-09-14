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
  generateCsvWithQuotedNewlines,
  phoneForIndex,
  recordingMetrics,
  seedClientWithPlan,
  sweepUntilDone,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-runner-limits-and-cursor.integration.test.ts (P20 C1 M4) - three of
 * the four tests the phase file's "Tests that prove it" table named but were
 * never written: the quoted-newline row-cursor resume, the over-
 * `max_contacts` clean failure, and the 1,000-row error-retention cap. Every
 * assertion is an EXACT expected value, never a bound.
 *
 * The fourth (within-file duplicate counting, including ACROSS batches) now
 * lives in the sibling `import-runner-duplicates.integration.test.ts`, split
 * out purely for this file's own max-lines cap.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-limits-cursor-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('a quoted embedded newline does not desynchronise the row cursor', () => {
  it('a_quoted_newline_does_not_desynchronise_the_row_cursor', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'quoted-newline-cursor',
      maxContacts: 5000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const rowCount = 1100;
    const csv = generateCsvWithQuotedNewlines(rowCount, 7);

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    let crashedOnce = false;
    // (recordNo, phone) pairs in the exact order `onRecord` fires - the
    // generator assigns `phoneForIndex(recordNo - 1)` to every record
    // (NEW-2), independent of which records carry a quoted embedded
    // newline, so pairing lets the assertion below prove the cursor
    // resumed at the exact right RECORD, not merely "some record numbered
    // 501 occurred somewhere".
    const recorded: { recordNo: number; phone: string }[] = [];
    const { row } = await sweepUntilDone(
      {
        pool,
        tenantDb,
        keyProvider,
        objectStore,
        metrics: recordingMetrics().metrics,
        batchSize: 500,
        hooks: {
          onBeforeCommit: (ctx) => {
            if (ctx.batchIndex === 0 && !crashedOnce) {
              crashedOnce = true;
              throw new Error('injected crash after batch 1 upsert, before commit');
            }
          },
          onRecord: (ctx) => {
            recorded.push({ recordNo: ctx.recordNo, phone: phoneForIndex(ctx.recordNo - 1) });
          },
        },
      },
      clientId,
      created.id,
    );

    expect(row.status).toBe('done');
    expect(row.importedCount).toBe(1100);
    expect(row.duplicateCount).toBe(0);
    expect(row.invalidCount).toBe(0);

    // The crash happened DURING batch 1's first attempt (before commit) - the
    // whole batch tx rolled back, so a resumed sweep re-reads from cursor_row
    // 0 and re-processes records 1..500 again, THEN batch 2 begins at record
    // 501. The LAST occurrence of record 500 marks the end of that final
    // (successful, committed) batch-1 attempt, so the very next entry is the
    // RESUMED batch 2's true first record - it must be EXACTLY 501 (never a
    // desynchronised row/record count from the embedded quoted newlines),
    // and the next two must be exactly 502 and 503, each with its generator
    // phone.
    const lastRecord500Index = recorded.map((r) => r.recordNo).lastIndexOf(500);
    expect(lastRecord500Index).toBeGreaterThan(-1);
    const batch2Start = lastRecord500Index + 1;
    expect(recorded[batch2Start]).toEqual({ recordNo: 501, phone: phoneForIndex(500) });
    expect(recorded[batch2Start + 1]).toEqual({ recordNo: 502, phone: phoneForIndex(501) });
    expect(recorded[batch2Start + 2]).toEqual({ recordNo: 503, phone: phoneForIndex(502) });
  });
});

describe('an import over max_contacts fails cleanly, never truncated silently', () => {
  it('import_over_max_contacts_fails_with_a_clear_error_not_a_truncation', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'over-max-contacts',
      maxContacts: 1200,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();
    const csv = generateCsv(1500);

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    const { metrics, countsByResult } = recordingMetrics();
    const { row } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics, batchSize: 500 },
      clientId,
      created.id,
    );

    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();
    // Batches 1-2 (1000 records) completed before batch 3's projection
    // (1000 + 500 = 1500 > 1200) tripped the limit - nothing partial from
    // batch 3 itself.
    expect(row.importedCount).toBe(1000);

    const reason = await tenantDb.withTenant(clientId, (tx) =>
      lastErrorReason(tx, clientId, created.id),
    );
    expect(reason).toBe('max_contacts_exceeded');
    expect(countsByResult.get('failed')).toBe(1);

    // A further sweep is a byte-identical no-op - a failed import is never re-claimed.
    const before = await tenantDb.withTenant(clientId, (tx) =>
      getContactImport(tx, clientId, created.id),
    );
    await runOneContactImportSweep({
      pool,
      tenantDb,
      keyProvider,
      objectStore,
      metrics,
      maxClientsPerSweep: 50,
    });
    const after = await tenantDb.withTenant(clientId, (tx) =>
      getContactImport(tx, clientId, created.id),
    );
    expect(after).toEqual(before);
  });
});

describe('error rows are capped at one thousand and the rest are counted', () => {
  it('error_rows_are_capped_at_one_thousand_and_the_rest_are_counted', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'error-cap',
      maxContacts: 5000,
    });
    createdClientIds.push(clientId);
    const objectStore = buildTestObjectStore();

    const lines = ['phone,name,city'];
    const garbagePhone = '1'.repeat(300);
    for (let i = 0; i < 1500; i += 1) {
      lines.push(`12345,Bad ${i},City ${i}`);
    }
    for (let i = 0; i < 10; i += 1) {
      lines.push(`${phoneForIndex(i)},Good ${i},City ${i}`);
    }
    // One row with a 300-char garbage phone cell - raw_excerpt must still be capped at 120.
    lines.push(`${garbagePhone},Garbage,City`);
    const csv = lines.join('\r\n') + '\r\n';

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
    });

    const { row } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: recordingMetrics().metrics },
      clientId,
      created.id,
    );

    expect(row.status).toBe('done');
    expect(row.invalidCount).toBe(1501);
    expect(row.importedCount).toBe(10);

    const errorCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_import_errors WHERE client_id = $1 AND import_id = $2 AND row_no > 0',
      [clientId, created.id],
    );
    expect(errorCount.rows[0]?.count).toBe('1000');

    const excerpts = await pool.query<{ raw_excerpt: string }>(
      'SELECT raw_excerpt FROM contact_import_errors WHERE client_id = $1 AND import_id = $2 AND row_no > 0',
      [clientId, created.id],
    );
    for (const r of excerpts.rows) {
      expect(r.raw_excerpt.length).toBeLessThanOrEqual(120);
    }
  });
});
