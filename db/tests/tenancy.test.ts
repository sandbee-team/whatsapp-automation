import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * Blueprint mandatory tenancy tests for migration 0002 - see
 * `plan/v1/P02-db-foundations-and-isolation.md` step 4. Each test tracks the
 * user/client ids it creates and `afterEach` deletes exactly those rows (in
 * reverse-FK order: memberships, clients, users) - the pattern used
 * elsewhere in `db/tests` (see `wallet-schema.test.ts`, `tenant-db.test.ts`).
 * The dev database is shared and persistent across test files; a
 * `TRUNCATE ... CASCADE` here would also wipe `plans`/`plan_limits` seed data
 * and any other suite's concurrently-held rows the moment `fileParallelism`
 * is enabled - scoped deletes never touch a row this file did not create.
 */
describe('tenancy', () => {
  let createdUserIds: string[] = [];
  let createdClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (createdClientIds.length > 0) {
      await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    createdUserIds = [];
    createdClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('a_second_membership_for_a_user_is_rejected_at_the_database', async () => {
    const pool = await getMigratedPool();

    const userId = randomUUID();
    const clientAId = randomUUID();
    const clientBId = randomUUID();
    createdUserIds.push(userId);
    createdClientIds.push(clientAId, clientBId);

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Ada Lovelace',
      'ada@example.com',
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientAId,
      'Client A',
      'client-a',
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientBId,
      'Client B',
      'client-b',
    ]);

    await pool.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
      clientAId,
      userId,
      'owner',
    ]);

    await expect(
      pool.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
        clientBId,
        userId,
        'owner',
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({
      code: '23505',
      constraint: 'memberships_one_workspace_per_user_uq',
    });
  });

  it('dropping_memberships_one_workspace_per_user_uq_breaks_no_test_except_that_one', async () => {
    const pool = await getMigratedPool();
    const client = await pool.connect();

    const userId = randomUUID();
    const clientAId = randomUUID();
    const clientBId = randomUUID();
    createdUserIds.push(userId);
    createdClientIds.push(clientAId, clientBId);

    try {
      await client.query('BEGIN');

      await client.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
        userId,
        'Grace Hopper',
        'grace@example.com',
      ]);
      await client.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
        clientAId,
        'Client A',
        'client-a',
      ]);
      await client.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
        clientBId,
        'Client B',
        'client-b',
      ]);
      await client.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
        clientAId,
        userId,
        'owner',
      ]);

      await client.query('DROP INDEX memberships_one_workspace_per_user_uq');

      // Proves the index is the SOLE enforcement: with it gone, a second
      // membership for the same user (a different client) now succeeds.
      await expect(
        client.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
          clientBId,
          userId,
          'owner',
        ]),
      ).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    const indexCheck = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'memberships_one_workspace_per_user_uq'`,
    );
    expect(indexCheck.rowCount).toBe(1);
  });

  it('clients_slug_and_users_email_are_unique_case_insensitively', async () => {
    const pool = await getMigratedPool();

    const clientId = randomUUID();
    const userId = randomUUID();
    createdClientIds.push(clientId);
    createdUserIds.push(userId);

    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Acme Corp',
      'acme-corp',
    ]);
    await expect(
      pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
        randomUUID(),
        'Acme Corp Again',
        'ACME-Corp',
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23505' });

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Owner One',
      'owner@x.com',
    ]);
    await expect(
      pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
        randomUUID(),
        'Owner Two',
        'OWNER@X.com',
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23505' });
  });

  it('two_concurrent_second_memberships_for_one_user_yield_exactly_one_row', async () => {
    const pool = await getMigratedPool();

    const userId = randomUUID();
    const clientAId = randomUUID();
    const clientBId = randomUUID();
    createdUserIds.push(userId);
    createdClientIds.push(clientAId, clientBId);

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Concurrent Membership Probe',
      `concurrent-membership-${userId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientAId,
      'Concurrent Client A',
      `concurrent-client-a-${clientAId}`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientBId,
      'Concurrent Client B',
      `concurrent-client-b-${clientBId}`,
    ]);

    // Two separate pool connections (not the same connection sequentially):
    // the unique index must win under real concurrency, not just when the
    // two inserts happen to be serialized by sharing one client.
    const clientOne = await pool.connect();
    const clientTwo = await pool.connect();
    try {
      const results = await Promise.allSettled([
        clientOne.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
          clientAId,
          userId,
          'owner',
        ]),
        clientTwo.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
          clientBId,
          userId,
          'owner',
        ]),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejection = (rejected[0] as PromiseRejectedResult).reason as PgError;
      expect(rejection.code).toBe('23505');
      expect(rejection.constraint).toBe('memberships_one_workspace_per_user_uq');
    } finally {
      clientOne.release();
      clientTwo.release();
    }

    const membershipRows = await pool.query(
      'SELECT client_id FROM memberships WHERE user_id = $1',
      [userId],
    );
    expect(membershipRows.rowCount).toBe(1);
  });
});
