import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTenantDb, InvalidTenantIdError } from '../src/tenant-db.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
}

/**
 * Smoke tests for migration 0005 (RLS, four roles, grants) and
 * `createTenantDb`/`withTenant` - see `plan/v1/P02-db-foundations-and-
 * isolation.md` step 7. The full grant-matrix snapshot is a later step's
 * job; these four cases only prove the isolation + append-only shape works
 * end to end under `wp_app`. Probe rows are created as the superuser (`wp`,
 * which bypasses RLS and every grant) and removed in `afterEach` in
 * reverse-FK order.
 */
describe('tenant_db', () => {
  let probeUserIds: string[] = [];
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    }
    if (probeUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [probeUserIds]);
    }
    probeUserIds = [];
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  /** Creates a probe user + client + wallet_accounts row, tracked for cleanup. */
  async function createProbeClientWithWallet(): Promise<string> {
    const pool = await getMigratedPool();
    const userId = randomUUID();
    const clientId = randomUUID();

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Tenant Db Probe',
      `tenant-db-probe-${clientId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Tenant Db Probe Client',
      `tenant-db-probe-${clientId}`,
    ]);
    await pool.query('INSERT INTO wallet_accounts (client_id, max_rate_minor) VALUES ($1, $2)', [
      clientId,
      15,
    ]);

    probeUserIds.push(userId);
    probeClientIds.push(clientId);
    return clientId;
  }

  it('with_tenant_scopes_reads_to_the_tenant_under_wp_app', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);

    const clientA = await createProbeClientWithWallet();
    const clientB = await createProbeClientWithWallet();

    await tenantDb.withTenant(clientA, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');
      const result = await tx.query<{ client_id: string }>('SELECT client_id FROM wallet_accounts');
      expect(result.rows).toEqual([{ client_id: clientA }]);
      expect(result.rows.some((row) => row.client_id === clientB)).toBe(false);
    });
  });

  it('unset_context_under_wp_app_returns_zero_rows', async () => {
    const pool = await getMigratedPool();
    await createProbeClientWithWallet();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await expect(client.query('SELECT * FROM wallet_accounts')).resolves.toMatchObject({
        rows: [],
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('with_tenant_rejects_a_non_uuid_client_id', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);

    await expect(tenantDb.withTenant('', async () => undefined)).rejects.toThrow(
      InvalidTenantIdError,
    );
    await expect(tenantDb.withTenant('not-a-uuid', async () => undefined)).rejects.toThrow(
      InvalidTenantIdError,
    );
  });

  it('wp_app_cannot_update_or_delete_wallet_ledger_smoke', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const clientId = await createProbeClientWithWallet();

    await tenantDb.withTenant(clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');

      await tx.query(
        `INSERT INTO wallet_ledger
           (client_id, seq, kind, amount_minor, balance_after_minor, actor_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [clientId, 1, 'signup_credit', 1000, 1000, 'system'],
      );

      // A rejected statement leaves the surrounding Postgres transaction
      // aborted (subsequent statements fail 25P02, not the interesting
      // error), so each denied statement gets its own SAVEPOINT to recover
      // from - a smoke proof, not the full grant-matrix snapshot.
      await tx.query('SAVEPOINT before_update');
      await expect(
        tx.query('UPDATE wallet_ledger SET amount_minor = 2000 WHERE client_id = $1', [clientId]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: '42501' });
      await tx.query('ROLLBACK TO SAVEPOINT before_update');

      await tx.query('SAVEPOINT before_delete');
      await expect(
        tx.query('DELETE FROM wallet_ledger WHERE client_id = $1', [clientId]),
      ).rejects.toMatchObject<Partial<PgError>>({ code: '42501' });
      await tx.query('ROLLBACK TO SAVEPOINT before_delete');
    });
  });
});
