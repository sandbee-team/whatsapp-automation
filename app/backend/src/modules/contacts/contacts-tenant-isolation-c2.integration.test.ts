import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createContactTag } from './tags.repo.js';
import { ImportMappingInvalidError } from './import.repo.js';
import {
  buildTestKeyProvider,
  buildTestObjectStore,
  cleanupImportProbeClients,
  createAndAttestImport,
  generateCsv,
  noOpMetrics,
  seedClientWithPlan,
  sweepUntilDone,
  type TestPool,
} from './__tests__/import-test-support.js';

/**
 * contacts-tenant-isolation-c2.integration.test.ts (C2 hardening; flipped
 * for P20 C1 addendum B) - the C2 brief's "two-tenant interference" case:
 * an import's `apply_tag_ids` entry belonging to a DIFFERENT tenant is now
 * REJECTED up front at creation (`createContactImport`), and even if one
 * somehow reached the batch upsert, `applyTags`' link INSERT joins
 * `contact_tags` on `client_id` so it can never write a cross-tenant link.
 */

let pool: TestPool;
let tenantDb: TenantDb;
const keyProvider = buildTestKeyProvider();
const createdClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-tenant-isolation-c2-it',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupImportProbeClients(pool, createdClientIds);
  await pool.end();
});

describe('an import apply_tag_ids referencing a foreign tenant tag id', () => {
  it('creation_is_rejected_up_front_with_zero_rows_written', async () => {
    const tenantA = await seedClientWithPlan(pool, { label: 'iso-a-reject', maxContacts: 100 });
    const tenantB = await seedClientWithPlan(pool, { label: 'iso-b-reject', maxContacts: 100 });
    createdClientIds.push(tenantA.clientId, tenantB.clientId);

    const tagB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      createContactTag(tx, {
        clientId: tenantB.clientId,
        name: 'tenant-b-only-tag-reject',
        createdByUserId: tenantB.userId,
      }),
    );

    const objectStore = buildTestObjectStore();
    const csv = generateCsv(5, { startIndex: 900 });

    // FIXED (addendum B): `createContactImport` now rejects an
    // `apply_tag_ids` entry that does not belong to the creating tenant,
    // BEFORE any row is written.
    await expect(
      createAndAttestImport(tenantDb, objectStore, {
        clientId: tenantA.clientId,
        userId: tenantA.userId,
        csvText: csv,
        applyTagIds: [tagB.id],
      }),
    ).rejects.toBeInstanceOf(ImportMappingInvalidError);

    const importsUnderA = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_imports WHERE client_id = $1',
      [tenantA.clientId],
    );
    expect(importsUnderA.rows[0]?.count).toBe('0');
  });

  it('applyTags_never_writes_a_cross_tenant_link_even_if_reached_directly', async () => {
    const tenantA = await seedClientWithPlan(pool, { label: 'iso-a', maxContacts: 100 });
    const tenantB = await seedClientWithPlan(pool, { label: 'iso-b', maxContacts: 100 });
    createdClientIds.push(tenantA.clientId, tenantB.clientId);

    const tagB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      createContactTag(tx, {
        clientId: tenantB.clientId,
        name: 'tenant-b-only-tag',
        createdByUserId: tenantB.userId,
      }),
    );

    const objectStore = buildTestObjectStore();
    const csv = generateCsv(5, { startIndex: 900 });

    // No apply_tag_ids at creation time (the up-front check would reject a
    // foreign one) - this test proves the DEFENCE-IN-DEPTH half directly:
    // `applyTags` itself never writes a cross-tenant link, by calling it
    // with tenant A's contacts but tenant B's tag id, bypassing the
    // creation-time gate entirely.
    const created = await createAndAttestImport(tenantDb, objectStore, {
      clientId: tenantA.clientId,
      userId: tenantA.userId,
      csvText: csv,
    });

    const { row } = await sweepUntilDone(
      { pool, tenantDb, keyProvider, objectStore, metrics: noOpMetrics() },
      tenantA.clientId,
      created.id,
    );
    expect(row.status).toBe('done');

    const { applyTags } = await import('./import-runner-batch.js');
    const contactIds = await pool.query<{ id: string }>(
      'SELECT id FROM contacts WHERE client_id = $1',
      [tenantA.clientId],
    );
    await tenantDb.withTenant(tenantA.clientId, (tx) =>
      applyTags(tx, {
        clientId: tenantA.clientId,
        tagIds: [tagB.id],
        contactIds: contactIds.rows.map((r) => r.id),
      }),
    );

    const tagBRow = await pool.query<{ contact_count: number }>(
      'SELECT contact_count FROM contact_tags WHERE client_id = $1 AND id = $2',
      [tenantB.clientId, tagB.id],
    );
    expect(tagBRow.rows[0]?.contact_count).toBe(0);

    const linksUnderA = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM contact_tag_links WHERE client_id = $1 AND tag_id = $2',
      [tenantA.clientId, tagB.id],
    );
    // FIXED (addendum B): `applyTags`' link INSERT now JOINS `contact_tags`
    // on `client_id`, so a foreign tag id matches ZERO rows and writes
    // nothing - never the cross-tenant link the pre-fix version wrote.
    expect(linksUnderA.rows[0]?.count).toBe('0');
  });
});
