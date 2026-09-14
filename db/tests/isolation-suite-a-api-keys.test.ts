import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenantDb, TENANT_TABLE_COVERAGE } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * Go-live session, Unit U1 - sibling of `isolation-suite-a.test.ts` (same
 * "sits near the 300-line cap" reason `isolation-suite-a-p28.test.ts` gives),
 * covering migration 0076 (`api_keys`) plus the `wp_api_key_lookup` definer
 * helper the migration also creates. Seeds its own two tenants (self-
 * contained, no shared `isolation-fixtures.ts` seed) and cleans up in
 * `afterAll`.
 */

interface SeededTenant {
  clientId: string;
  userId: string;
  keyPrefix: string;
  keyId: string;
}

async function seedTenantWithOneKey(
  pool: Awaited<ReturnType<typeof getMigratedPool>>,
  label: string,
): Promise<SeededTenant> {
  const suffix = randomBytes(6).toString('hex');
  const clientId = randomUUID();
  const userId = randomUUID();
  const keyPrefix = `wp_live_${randomBytes(6).toString('hex')}`;

  await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
    userId,
    `Isolation Suite A Api Keys ${label} ${suffix}`,
    `isolation-suite-a-api-keys-${label}-${suffix}@example.com`,
  ]);
  await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
    clientId,
    `Isolation Suite A Api Keys ${label} ${suffix}`,
    `isolation-suite-a-api-keys-${label}-${suffix}`,
  ]);
  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (client_id, name, key_prefix, secret_hash, last4, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [clientId, `${label} key`, keyPrefix, Buffer.from('1'.repeat(64), 'hex'), 'ab12', userId],
  );
  const keyId = insertResult.rows[0]?.id;
  if (!keyId) throw new Error('seedTenantWithOneKey: insert did not return an id');

  return { clientId, userId, keyPrefix, keyId };
}

describe('isolation_suite_a_api_keys', () => {
  let tenantA: SeededTenant | undefined;
  let tenantB: SeededTenant | undefined;

  afterAll(async () => {
    const pool = await getMigratedPool();
    for (const tenant of [tenantA, tenantB]) {
      if (!tenant) continue;
      await pool.query('DELETE FROM api_keys WHERE client_id = $1', [tenant.clientId]);
      await pool.query('DELETE FROM clients WHERE id = $1', [tenant.clientId]);
      await pool.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
    }
    await closeMigratedPool();
  });

  it('api_keys_is_registered_in_tenant_table_coverage_on_client_id', () => {
    expect(TENANT_TABLE_COVERAGE.api_keys).toBe('client_id');
  });

  it('tenant_a_and_tenant_b_each_see_only_their_own_api_key_row', async () => {
    const pool = await getMigratedPool();
    tenantA = await seedTenantWithOneKey(pool, 'a');
    tenantB = await seedTenantWithOneKey(pool, 'b');

    const tenantDb = createTenantDb(pool);
    await tenantDb.withTenant(tenantA.clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');
      const result = await tx.query<{ id: string }>('SELECT id FROM api_keys');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.id).toBe(tenantA?.keyId);
    });

    await tenantDb.withTenant(tenantB.clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');
      const result = await tx.query<{ id: string }>('SELECT id FROM api_keys');
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.id).toBe(tenantB?.keyId);
    });
  });

  it('wp_api_key_lookup_returns_the_row_for_a_known_prefix_with_no_client_id_set', async () => {
    const pool = await getMigratedPool();
    if (!tenantA) throw new Error('tenantA must be seeded by the previous test');

    const result = await pool.query<{
      client_id: string;
      id: string;
      created_by_user_id: string;
      revoked_at: string | null;
    }>('SELECT * FROM wp_api_key_lookup($1)', [tenantA.keyPrefix]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.client_id).toBe(tenantA.clientId);
    expect(result.rows[0]?.id).toBe(tenantA.keyId);
    expect(result.rows[0]?.revoked_at).toBeNull();
  });

  it('wp_api_key_lookup_returns_zero_rows_for_an_unknown_prefix', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query('SELECT * FROM wp_api_key_lookup($1)', [
      `wp_live_${randomBytes(6).toString('hex')}`,
    ]);
    expect(result.rows).toHaveLength(0);
  });

  it('wp_api_key_lookup_does_not_filter_out_a_revoked_key', async () => {
    const pool = await getMigratedPool();
    if (!tenantA) throw new Error('tenantA must be seeded');

    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [tenantA.keyId]);
    const result = await pool.query<{ revoked_at: string | null }>(
      'SELECT * FROM wp_api_key_lookup($1)',
      [tenantA.keyPrefix],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.revoked_at).not.toBeNull();
  });
});
