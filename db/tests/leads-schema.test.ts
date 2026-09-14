import { afterAll, describe, expect, it } from 'vitest';
import {
  ISOLATION_NON_TENANT_TABLES,
  TENANT_TABLE_COVERAGE,
} from '../src/isolation/tenant-tables.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  fetchLiveColumnGrantsForTables,
  fetchLiveGrantsForTables,
  SNAPSHOT_ROLES,
} from './helpers/grants.js';

/**
 * P29 (website-and-launch-hardening) Unit U4a - schema tests for migration
 * 0074 (`leads`). Non-tenant table (no `client_id`) written by admin/
 * backend's public lead endpoint (blueprint [R-52]) before any client
 * exists - see the migration's own header for the full rationale. Every
 * probe row this suite inserts as the pool owner is cleaned up by id in
 * `afterAll`.
 */

const VALID_IP_HASH = 'a'.repeat(64);

function makeValidLeadRow(overrides: Partial<Record<string, unknown>> = {}): {
  name: string;
  email: string;
  message: string;
  source: string;
  ipHash: string;
} {
  return {
    name: 'Probe Lead',
    email: `probe-${Date.now().toString()}@example.com`,
    message: 'x'.repeat(2000),
    source: 'pricing',
    ipHash: VALID_IP_HASH,
    ...overrides,
  };
}

describe('leads_schema', () => {
  const insertedIds: string[] = [];

  afterAll(async () => {
    const pool = await getMigratedPool();
    if (insertedIds.length > 0) {
      await pool.query('DELETE FROM leads WHERE id = ANY($1::uuid[])', [insertedIds]);
    }
    await closeMigratedPool();
  });

  it('leads_is_a_registered_non_tenant_table_with_a_reason', () => {
    expect(ISOLATION_NON_TENANT_TABLES.leads).toBe('marketing lead, no tenant exists yet');
    expect(Object.keys(TENANT_TABLE_COVERAGE)).not.toContain('leads');
  });

  it('leads_grants_are_select_insert_for_wp_admin_app_only', async () => {
    const pool = await getMigratedPool();

    const adminTableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', ['leads']);
    const adminColumnGrants = await fetchLiveColumnGrantsForTables(pool, 'wp_admin_app', ['leads']);

    expect([...new Set(adminTableGrants.map((row) => row.privilege_type))].sort()).toEqual([
      'INSERT',
      'SELECT',
    ]);
    // A table-level GRANT SELECT, INSERT also surfaces as a per-column grant
    // in information_schema.role_column_grants for every column - assert the
    // privilege set is still exactly {INSERT, SELECT}, never UPDATE/DELETE.
    expect([...new Set(adminColumnGrants.map((row) => row.privilege_type))].sort()).toEqual([
      'INSERT',
      'SELECT',
    ]);

    // wp_migrator OWNS leads (ALTER TABLE ... OWNER TO wp_migrator in the
    // migration) - Postgres reports an owner's implicit full privilege set
    // via the same catalog views, which is expected ownership, not an
    // explicit extra grant, so wp_migrator is excluded from this "zero
    // grants" loop (the brief's "no grant for wp_migrator-beyond-ownership").
    for (const role of SNAPSHOT_ROLES) {
      if (role === 'wp_admin_app' || role === 'wp_migrator') {
        continue;
      }
      const tableGrants = await fetchLiveGrantsForTables(pool, role, ['leads']);
      const columnGrants = await fetchLiveColumnGrantsForTables(pool, role, ['leads']);
      expect(tableGrants, `${role} should have zero table grants on leads`).toEqual([]);
      expect(columnGrants, `${role} should have zero column grants on leads`).toEqual([]);
    }
  });

  it('leads_rejects_a_raw_ip_and_an_oversized_message_at_the_storage_layer', async () => {
    const pool = await getMigratedPool();

    const insertSql = `INSERT INTO leads (name, email, message, source, ip_hash)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`;

    await expect(
      pool.query(insertSql, ['Raw Ip', 'raw-ip@example.com', 'hello', 'pricing', '203.0.113.9']),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(insertSql, [
        'Oversized Message',
        'oversized@example.com',
        'x'.repeat(2001),
        'pricing',
        VALID_IP_HASH,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      pool.query(insertSql, [
        'Bad Source',
        'bad-source@example.com',
        'hello',
        'Pricing Page',
        VALID_IP_HASH,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    const valid = makeValidLeadRow({ email: `valid-storage-${Date.now().toString()}@example.com` });
    const result = await pool.query<{ id: string }>(insertSql, [
      valid.name,
      valid.email,
      valid.message,
      valid.source,
      valid.ipHash,
    ]);
    const insertedId = result.rows[0]?.id;
    expect(insertedId).toBeDefined();
    if (insertedId) {
      insertedIds.push(insertedId);
    }
  });

  it('the_largest_zod_accepted_utm_inserts_and_a_2049_byte_utm_is_rejected_at_storage', async () => {
    const pool = await getMigratedPool();

    const insertSql = `INSERT INTO leads (name, email, message, source, ip_hash, utm)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;

    // Largest utm the admin-backend zod schema still accepts (9 single-
    // letter keys x 190 chars, ~1774 raw JSON bytes - under the 1800-byte
    // zod refine in leads.routes.ts#utmSchema) must succeed at storage.
    const nineKeys190Chars: Record<string, string> = {};
    'abcdefghi'.split('').forEach((key) => {
      nineKeys190Chars[key] = 'a'.repeat(190);
    });
    const valid = makeValidLeadRow({
      email: `valid-utm-bound-${Date.now().toString()}@example.com`,
    });
    const result = await pool.query<{ id: string }>(insertSql, [
      valid.name,
      valid.email,
      valid.message,
      valid.source,
      valid.ipHash,
      JSON.stringify(nineKeys190Chars),
    ]);
    const insertedId = result.rows[0]?.id;
    expect(insertedId).toBeDefined();
    if (insertedId) {
      insertedIds.push(insertedId);
    }

    // A utm whose `pg_column_size` exceeds 2048 (10 single-letter keys x 200
    // chars - the same shape the zod refine rejects at the API layer) is
    // rejected at the storage layer too, so the CHECK is a real backstop,
    // not merely a documented intent.
    const tenKeys200Chars: Record<string, string> = {};
    'abcdefghij'.split('').forEach((key) => {
      tenKeys200Chars[key] = 'a'.repeat(200);
    });
    const oversized = makeValidLeadRow({
      email: `oversized-utm-${Date.now().toString()}@example.com`,
    });
    await expect(
      pool.query(insertSql, [
        oversized.name,
        oversized.email,
        oversized.message,
        oversized.source,
        oversized.ipHash,
        JSON.stringify(tenKeys200Chars),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('leads_has_no_row_level_security_and_wp_admin_app_can_insert_and_select', async () => {
    const pool = await getMigratedPool();

    const relRowSecurity = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'leads'`,
    );
    expect(relRowSecurity.rows[0]?.relrowsecurity).toBe(false);

    const client = await pool.connect();
    let insertedId: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_admin_app');

      const valid = makeValidLeadRow({
        email: `valid-rls-${Date.now().toString()}@example.com`,
      });
      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO leads (name, email, message, source, ip_hash)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [valid.name, valid.email, valid.message, valid.source, valid.ipHash],
      );
      insertedId = insertResult.rows[0]?.id;
      expect(insertedId).toBeDefined();

      const selectResult = await client.query<{ id: string }>(
        'SELECT id FROM leads WHERE id = $1',
        [insertedId],
      );
      expect(selectResult.rows).toHaveLength(1);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (insertedId) {
      insertedIds.push(insertedId);
    }
  });
});
