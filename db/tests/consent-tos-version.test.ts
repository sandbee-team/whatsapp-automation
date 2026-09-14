import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P29a (launch-hardening-and-drills) step 10, Unit U4a - schema test for
 * migration 0075 (`clients.consent_tos_version`). Every probe row this
 * suite inserts as the pool owner is cleaned up by id in `afterAll`.
 */

const createdClientIds: string[] = [];

afterAll(async () => {
  const pool = await getMigratedPool();
  for (const id of createdClientIds) {
    await pool.query('DELETE FROM clients WHERE id = $1', [id]);
  }
  await closeMigratedPool();
});

/** Inserts a minimal probe client (bypassing RLS as the pool's migrator/superuser role) and returns its id. */
async function insertProbeClient(
  pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  label: string,
): Promise<string> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = randomUUID();
  await pool.query(`INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)`, [
    id,
    `Consent ToS Version Probe ${suffix}`,
    `consent-tos-version-probe-${suffix}`,
  ]);
  return id;
}

describe('clients_consent_tos_version', () => {
  it('clients_consent_tos_version_exists_and_rejects_a_non_date_value', async () => {
    const pool = await getMigratedPool();

    const column = await pool.query<{ data_type: string; is_nullable: 'YES' | 'NO' }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'consent_tos_version'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]?.data_type).toBe('text');
    expect(column.rows[0]?.is_nullable).toBe('YES');

    const clientId = await insertProbeClient(pool, 'reject');
    createdClientIds.push(clientId);

    await expect(
      pool.query(`UPDATE clients SET consent_tos_version = $2 WHERE id = $1`, [clientId, 'v1']),
    ).rejects.toMatchObject({ code: '23514' });

    await pool.query(`UPDATE clients SET consent_tos_version = $2 WHERE id = $1`, [
      clientId,
      '2026-09-08',
    ]);
    const row = await pool.query<{ consent_tos_version: string | null }>(
      `SELECT consent_tos_version FROM clients WHERE id = $1`,
      [clientId],
    );
    expect(row.rows[0]?.consent_tos_version).toBe('2026-09-08');
  });
});
