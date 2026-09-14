import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { assertExactlyOneDefaultPlan } from '../../../platform/db/assert-db-preconditions.js';
import { NoDefaultPlanError, signup, type SignupCtx } from '../signup.service.js';

/**
 * signup-plan.integration.test.ts (P28 U5, item 3) - plan assignment at
 * signup: the real signup route assigns the default (`starter`) plan in the
 * same transaction, resolving it fails closed (`NoDefaultPlanError`, never a
 * zero-capacity workspace) when no default exists, and the migration 0070
 * NULL-plan_id backfill left no pre-existing client behind.
 */

const STARTER_PLAN_ID = '10000000-0000-4000-8000-000000000001';

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
  return `signup-plan-${label}-${randomUUID()}@example.test`;
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

describe('signup plan assignment (P28 U5, item 3)', () => {
  it('signup_assigns_the_default_plan_in_the_same_transaction', async () => {
    const email = uniqueEmail('happy-path');

    const result = await signup(baseCtx(), {
      fullName: 'Plan Assignee',
      email,
      companyName: 'Plan Assignee Co',
    });
    createdUserIds.push(result.userId);
    createdClientIds.push(result.clientId);

    const clientRow = await pool.query<{ plan_id: string }>(
      'SELECT plan_id FROM clients WHERE id = $1',
      [result.clientId],
    );
    expect(clientRow.rows[0]!.plan_id).toBe(STARTER_PLAN_ID);

    const limitsRow = await pool.query<{
      max_connected_instances: number;
      max_registered_instances: number;
      max_contacts: number;
    }>(
      `SELECT max_connected_instances, max_registered_instances, max_contacts
         FROM plan_limits WHERE plan_id = $1`,
      [STARTER_PLAN_ID],
    );
    expect(limitsRow.rows[0]!.max_connected_instances).toBe(1);
    expect(limitsRow.rows[0]!.max_registered_instances).toBe(3);
    expect(limitsRow.rows[0]!.max_contacts).toBe(5000);
  });

  it('signup_fails_closed_without_a_default_plan', async () => {
    const email = uniqueEmail('no-default-plan');

    await expect(
      signup(
        baseCtx({
          provisioningRepo: {
            readDefaultPlanId: async () => null,
          },
        }),
        { fullName: 'No Default Plan', email, companyName: 'No Default Plan Co' },
      ),
    ).rejects.toThrow(NoDefaultPlanError);

    const users = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users.rows).toHaveLength(0);
    const clients = await pool.query('SELECT id FROM clients WHERE company_name = $1', [
      'No Default Plan Co',
    ]);
    expect(clients.rows).toHaveLength(0);

    // Unit-level: the boot precondition function against a stub pool with no
    // default-plan row (count 0) also fails closed.
    const stubPoolZero = {
      query: async () => ({ rows: [{ default_count: 0 }] }),
    };
    await expect(assertExactlyOneDefaultPlan(stubPoolZero)).rejects.toThrow();

    const stubPoolTwo = {
      query: async () => ({ rows: [{ default_count: 2 }] }),
    };
    await expect(assertExactlyOneDefaultPlan(stubPoolTwo)).rejects.toThrow();
  });

  it('existing_null_plan_clients_were_backfilled', async () => {
    // Migration 0070's own backfill only covers rows created BEFORE it ran -
    // this asserts that population, never the whole table (other suites
    // deliberately insert plan-less probe clients, e.g.
    // preflight-c1fix.integration.test.ts's `plan_id = NULL` fixtures).
    const result = await pool.query<{ applied_at: Date }>(
      `SELECT applied_at FROM schema_migrations WHERE version = 70`,
    );
    expect(result.rows).toHaveLength(1);
    const appliedAt = result.rows[0]!.applied_at;

    const staleNullCount = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM clients
        WHERE plan_id IS NULL AND deleted_at IS NULL AND created_at < $1`,
      [appliedAt],
    );
    expect(Number(staleNullCount.rows[0]!.count)).toBe(0);
  });
});
