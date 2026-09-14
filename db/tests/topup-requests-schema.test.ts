import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P19 (topup-and-staff-audit) Unit U1 - schema tests for migration 0058
 * (`topup_requests_and_staff_audit`): `topup_requests` (client-facing manual
 * top-up submissions, ADR 0019 SS9) and `staff_audit_log` (minimal - P28
 * ALTERs it, never re-CREATEs). Pure catalog/information_schema probes, no
 * business-logic writes - the review/approve mutation itself is a later P19
 * unit.
 */
describe('topup_requests_schema', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('a_duplicate_client_external_ref_is_rejected_by_the_database', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    let clientId: string | undefined;
    try {
      clientId = await insertProbeClient(client, 'dup-ext-ref');
      const insertSql = `INSERT INTO topup_requests
          (client_id, amount_minor, method, external_ref, status)
        VALUES ($1, $2, 'upi', $3, 'pending')`;
      const externalRef = `topup-schema-probe-${Date.now()}`;
      await client.query(insertSql, [clientId, 10000, externalRef]);

      await expect(client.query(insertSql, [clientId, 20000, externalRef])).rejects.toMatchObject({
        code: '23505',
      });
    } finally {
      await cleanupProbeClient(client, clientId);
      client.release();
    }
  });

  it('a_non_positive_amount_is_rejected', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();
    let clientId: string | undefined;
    try {
      clientId = await insertProbeClient(client, 'non-positive-amount');
      const insertSql = `INSERT INTO topup_requests
          (client_id, amount_minor, method, external_ref, status)
        VALUES ($1, $2, 'upi', $3, 'pending')`;

      await expect(
        client.query(insertSql, [clientId, 0, `topup-schema-probe-zero-${Date.now()}`]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(insertSql, [clientId, -1, `topup-schema-probe-neg-${Date.now()}`]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await cleanupProbeClient(client, clientId);
      client.release();
    }
  });

  it('wp_app_has_no_update_grant_on_topup_requests', async () => {
    const pool = await getMigratedPool();

    const tableGrants = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = 'topup_requests'
          AND privilege_type = 'UPDATE'`,
    );
    expect(tableGrants.rows, JSON.stringify(tableGrants.rows, null, 2)).toEqual([]);

    const columnGrants = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.column_privileges
        WHERE table_schema = 'public'
          AND grantee = 'wp_app'
          AND table_name = 'topup_requests'
          AND privilege_type = 'UPDATE'`,
    );
    expect(columnGrants.rows, JSON.stringify(columnGrants.rows, null, 2)).toEqual([]);
  });

  it('no_money_column_is_a_floating_point_type', async () => {
    const pool = await getMigratedPool();
    const tables = ['topup_requests'];

    const minorColumns = await pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
    }>(
      `SELECT table_name, column_name, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND column_name LIKE '%\\_minor' ESCAPE '\\'`,
      [tables],
    );
    expect(minorColumns.rows.length).toBeGreaterThan(0);

    const notInt8 = minorColumns.rows.filter((row) => row.udt_name !== 'int8');
    expect(notInt8, JSON.stringify(notInt8, null, 2)).toEqual([]);

    const floatTyped = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND udt_name IN ('float4', 'float8', 'numeric')`,
      [tables],
    );
    expect(floatTyped.rows, JSON.stringify(floatTyped.rows, null, 2)).toEqual([]);
  });

  it('topup_requests_has_rls_enabled_and_forced', async () => {
    const pool = await getMigratedPool();

    const relRow = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE relname = 'topup_requests' AND relnamespace = 'public'::regnamespace`,
    );
    expect(relRow.rowCount).toBe(1);
    expect(relRow.rows[0]?.relrowsecurity).toBe(true);
    expect(relRow.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it('staff_audit_log_header_states_p28_must_alter', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrationPath = path.resolve(
      here,
      '..',
      'migrations',
      '0058_topup_requests_and_staff_audit.sql',
    );
    const source = readFileSync(migrationPath, 'utf8');
    expect(source).toContain('P28 must ALTER, never CREATE');
  });
});

/** Inserts a minimal probe client (bypassing RLS as the pool's migrator/superuser role) and returns its id. */
async function insertProbeClient(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  label: string,
): Promise<string> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = randomUUID();
  await client.query(`INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)`, [
    id,
    `Topup Schema Probe ${suffix}`,
    `topup-schema-probe-${suffix}`,
  ]);
  return id;
}

/** Reverse-FK-order cleanup for a probe client created by insertProbeClient; tolerant of undefined (no-op). */
async function cleanupProbeClient(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  clientId: string | undefined,
): Promise<void> {
  if (!clientId) return;
  await client.query('DELETE FROM topup_requests WHERE client_id = $1', [clientId]);
  await client.query('DELETE FROM clients WHERE id = $1', [clientId]);
}
