import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '../src/pool.js';
import { createTenantDb } from '../src/tenant-db.js';
import { resolveDatabaseUrl } from './helpers/db-url.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
}

/**
 * Edge cases for `createTenantDb`/`withTenant` (migration 0005 RLS + roles)
 * beyond the smoke tests in `tenant-db.test.ts` and the cross-tenant SELECT/
 * UPDATE/DELETE probes in `isolation-suite-a.test.ts`: pooled-connection
 * context leakage, concurrent interleaving, rollback-on-throw, and the
 * INSERT verb of the cross-tenant probe. Probe rows are created as the
 * superuser (`wp`, bypasses RLS/grants) and removed in `afterEach` in
 * reverse-FK order, same pattern as `tenant-db.test.ts`.
 */
describe('tenant_db edge cases', () => {
  let probeUserIds: string[] = [];
  let probeClientIds: string[] = [];
  let leakPool: pg.Pool | undefined;

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
    if (leakPool) {
      await leakPool.end();
      leakPool = undefined;
    }
    await closeMigratedPool();
  });

  /** Creates a probe user + client + wallet_accounts row, tracked for cleanup. */
  async function createProbeClientWithWallet(): Promise<string> {
    const pool = await getMigratedPool();
    const userId = randomUUID();
    const clientId = randomUUID();

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Tenant Db Edge Probe',
      `tenant-db-edge-probe-${clientId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Tenant Db Edge Probe Client',
      `tenant-db-edge-probe-${clientId}`,
    ]);
    await pool.query('INSERT INTO wallet_accounts (client_id, max_rate_minor) VALUES ($1, $2)', [
      clientId,
      15,
    ]);

    probeUserIds.push(userId);
    probeClientIds.push(clientId);
    return clientId;
  }

  it('tenant_context_does_not_leak_to_the_next_pooled_transaction', async () => {
    const tenantA = await createProbeClientWithWallet();

    // Dedicated max=1 pool: the same physical connection is provably reused
    // between the withTenant call below and the plain transaction after it.
    leakPool = createPool({
      connectionString: resolveDatabaseUrl(),
      max: 1,
      applicationName: 'wp-tenant-edge-leak',
    });
    const tenantDb = createTenantDb(leakPool);

    await tenantDb.withTenant(tenantA, async (tx) => {
      await tx.query('SELECT 1');
    });

    const client = await leakPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      // set_config(..., true) in withTenant was transaction-local; nothing
      // persisted on the pooled connection for this brand new transaction.
      const result = await client.query('SELECT * FROM wallet_accounts');
      expect(result.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('two_interleaved_tenants_each_see_only_their_own_rows', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const tenantA = await createProbeClientWithWallet();
    const tenantB = await createProbeClientWithWallet();

    for (let i = 0; i < 10; i += 1) {
      const [rowsA, rowsB] = await Promise.all([
        tenantDb.withTenant(tenantA, async (tx) => {
          await tx.query('SET LOCAL ROLE wp_app');
          const result = await tx.query<{ client_id: string }>(
            'SELECT client_id FROM wallet_accounts',
          );
          return result.rows;
        }),
        tenantDb.withTenant(tenantB, async (tx) => {
          await tx.query('SET LOCAL ROLE wp_app');
          const result = await tx.query<{ client_id: string }>(
            'SELECT client_id FROM wallet_accounts',
          );
          return result.rows;
        }),
      ]);

      expect(rowsA, `iteration ${i}: tenant A`).toEqual([{ client_id: tenantA }]);
      expect(rowsB, `iteration ${i}: tenant B`).toEqual([{ client_id: tenantB }]);
    }
  });

  it('with_tenant_rolls_back_when_fn_throws', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const tenantA = await createProbeClientWithWallet();
    const thrown = new Error('with_tenant_rolls_back_when_fn_throws: injected failure');

    await expect(
      tenantDb.withTenant(tenantA, async (tx) => {
        await tx.query('SET LOCAL ROLE wp_app');
        await tx.query(
          `INSERT INTO wallet_ledger
             (client_id, seq, kind, amount_minor, balance_after_minor, actor_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantA, 1, 'signup_credit', 1000, 1000, 'system'],
        );
        throw thrown;
      }),
    ).rejects.toBe(thrown);

    const check = await pool.query('SELECT 1 FROM wallet_ledger WHERE client_id = $1', [tenantA]);
    expect(check.rowCount).toBe(0);
  });

  it('tenant_b_cannot_insert_a_row_claiming_tenant_a', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const tenantA = await createProbeClientWithWallet();
    const tenantB = await createProbeClientWithWallet();

    await tenantDb.withTenant(tenantB, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');
      await tx.query('SAVEPOINT before_cross_tenant_insert');
      await expect(
        tx.query(
          `INSERT INTO wallet_ledger
             (client_id, seq, kind, amount_minor, balance_after_minor, actor_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenantA, 1, 'signup_credit', 1000, 1000, 'system'],
        ),
      ).rejects.toMatchObject<Partial<PgError>>({
        code: '42501',
        message: expect.stringMatching(/row-level security/i),
      });
      await tx.query('ROLLBACK TO SAVEPOINT before_cross_tenant_insert');
    });

    const check = await pool.query('SELECT 1 FROM wallet_ledger WHERE client_id = $1', [tenantA]);
    expect(check.rowCount).toBe(0);
  });

  describe('release-error handling (fake pool/client, no DB required)', () => {
    /** Builds a fake `pg.Pool` whose single `connect()` call yields `fakeClient`. */
    function fakePoolFor(fakeClient: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: (err?: Error) => void;
    }): pg.Pool {
      return {
        connect: vi.fn(async () => fakeClient),
      } as unknown as pg.Pool;
    }

    it('a_failing_rollback_still_propagates_the_original_error_and_destroys_the_client', async () => {
      const originalError = new Error(
        'a_failing_rollback_still_propagates_the_original_error_and_destroys_the_client: E',
      );
      const rollbackError = new Error('ROLLBACK: connection already broken');
      const release = vi.fn();
      const query = vi.fn(async (sql: string) => {
        if (sql === 'ROLLBACK') {
          throw rollbackError;
        }
        return { rows: [], rowCount: 0 };
      });
      const tenantDb = createTenantDb(fakePoolFor({ query, release }));

      await expect(
        tenantDb.withTenant(randomUUID(), async () => {
          throw originalError;
        }),
      ).rejects.toBe(originalError);

      expect(release).toHaveBeenCalledTimes(1);
      expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });

    it('a_successful_rollback_returns_the_client_to_the_pool', async () => {
      const originalError = new Error('a_successful_rollback_returns_the_client_to_the_pool: E');
      const release = vi.fn();
      const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      const tenantDb = createTenantDb(fakePoolFor({ query, release }));

      await expect(
        tenantDb.withTenant(randomUUID(), async () => {
          throw originalError;
        }),
      ).rejects.toBe(originalError);

      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith();
    });
  });
});
