import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { signup, SignupConflictError, type SignupCtx } from '../../identity/index.js';

/**
 * memberships.integration.test.ts (P04a Unit A3) - proves the
 * single-workspace-per-user invariant lives at the DATABASE layer
 * (`memberships_one_workspace_per_user_uq`, migration 0002), and that the
 * signup service maps a second-signup-with-existing-email conflict onto the
 * same generic typed error, creating no partial second workspace.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function baseCtx(overrides: Partial<SignupCtx> = {}): SignupCtx {
  return {
    tenantDb,
    sendVerificationEmail: async () => {},
    publicBaseUrl: 'http://localhost:5173',
    signupCreditMinor: 10000,
    lowBalanceThresholdMinor: 500,
    ...overrides,
  };
}

function uniqueEmail(label: string): string {
  return `memberships-${label}-${randomUUID()}@example.test`;
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
  }
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await pool.end();
});

describe('memberships (P04a Unit A3, single-workspace-per-user)', () => {
  it('a_second_membership_for_a_user_is_rejected_at_the_database', async () => {
    const userId = randomUUID();
    const clientAId = randomUUID();
    const clientBId = randomUUID();
    createdUserIds.push(userId);
    createdClientIds.push(clientAId, clientBId);

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Raw Insert User',
      uniqueEmail('raw-insert'),
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientAId,
      'Tenant A Raw',
      `tenant-a-raw-${clientAId}`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientBId,
      'Tenant B Raw',
      `tenant-b-raw-${clientBId}`,
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
    ).rejects.toMatchObject({ code: '23505', constraint: 'memberships_one_workspace_per_user_uq' });
  });

  it('signup_with_an_existing_email_creates_no_second_workspace', async () => {
    const email = uniqueEmail('dup-email');

    const first = await signup(baseCtx(), {
      fullName: 'First Signup',
      email,
      companyName: 'First Workspace Co',
    });
    createdUserIds.push(first.userId);
    createdClientIds.push(first.clientId);

    await expect(
      signup(baseCtx(), {
        fullName: 'Second Signup',
        email,
        companyName: 'Second Workspace Co',
      }),
    ).rejects.toThrow(SignupConflictError);

    const clientsCount = await pool.query('SELECT id FROM clients WHERE company_name = $1', [
      'Second Workspace Co',
    ]);
    expect(clientsCount.rows).toHaveLength(0);

    const membershipsCount = await pool.query(
      `SELECT m.client_id FROM memberships m
         JOIN clients c ON c.id = m.client_id
        WHERE c.company_name = $1`,
      ['Second Workspace Co'],
    );
    expect(membershipsCount.rows).toHaveLength(0);

    const usersCount = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(usersCount.rows).toHaveLength(1);
  });
});
