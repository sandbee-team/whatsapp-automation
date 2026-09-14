import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { waJidFromE164 } from '@wp/domain';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  createAndAttestImport,
  phoneForIndex,
  noOpMetrics,
  seedClientWithPlan,
  sweepUntilDone,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * import-runner-attrs-merge-overflow.integration.test.ts (P20 C1 m4) -
 * proves the SAVEPOINT per-row fallback (`import-runner-batch.ts#upsert
 * RowByRow`) reports the DISTINCT reason `attrs_too_large_after_merge` (not
 * the pre-upsert `attrs_too_large`) for a row that passes `readImportBatch`'s
 * own size check but whose SQL-side `attrs || EXCLUDED.attrs` merge with an
 * existing contact's stored attrs overflows the DB's 2048-byte CHECK.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-import-attrs-merge-overflow-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('a merge-time attrs overflow uses the distinct reason', () => {
  it('reports_attrs_too_large_after_merge_not_attrs_too_large', async () => {
    const { clientId, userId } = await seedClientWithPlan(pool, {
      label: 'attrs-merge-overflow',
      maxContacts: 100,
    });
    createdClientIds.push(clientId);

    const targetPhone = phoneForIndex(0);
    const phoneHash = hashRecipient(keyProvider, targetPhone);
    const waJid = waJidFromE164(targetPhone);

    // Seed an existing contact whose stored attrs already sits near the
    // 2048-byte cap (a single key with ~2000 bytes of value).
    const nearCapValue = 'x'.repeat(2000);
    await pool.query(
      `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source, attrs)
       VALUES ($1, $2, $3, $4, 'manual', $5::jsonb)`,
      [clientId, targetPhone, phoneHash, waJid, JSON.stringify({ existing: nearCapValue })],
    );

    const objectStore = buildTestObjectStore();
    // A small-but-nonzero attrs value: passes readImportBatch's own
    // pre-check (well under MAX_ATTRS_BYTES alone) but the SQL-side merge
    // with the existing ~2000-byte attrs blows the 2048-byte CHECK. Reuses
    // the fixture's own `city` column (the only one `import-test-support.ts`
    // declares in `mappingColumns`) as the attrs source.
    const csv =
      ['phone,name,city', `${targetPhone},Merge Overflow,${'y'.repeat(100)}`].join('\r\n') + '\r\n';

    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId,
      userId,
      csvText: csv,
      mapping: { phone: 'phone', name: 'name', attrs: { note: 'city' } },
    });

    const { row } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: noOpMetrics() },
      clientId,
      created.id,
    );

    expect(row.status).toBe('done');
    expect(row.invalidCount).toBe(1);

    const errorRows = await pool.query<{ reason: string; raw_excerpt: string }>(
      'SELECT reason, raw_excerpt FROM contact_import_errors WHERE client_id = $1 AND import_id = $2 AND row_no > 0',
      [clientId, created.id],
    );
    expect(errorRows.rows).toHaveLength(1);
    expect(errorRows.rows[0]?.reason).toBe('attrs_too_large_after_merge');
  });
});
