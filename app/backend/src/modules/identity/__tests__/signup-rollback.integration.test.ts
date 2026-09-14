import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { DefaultPriceListMissingError, signup, type SignupCtx } from '../signup.service.js';

/**
 * signup-rollback.integration.test.ts (P04a Unit A3; split out of
 * signup.integration.test.ts, P04a FIXD, for max-lines) - proves the
 * one-transaction signup rolls back COMPLETELY (no partial rows anywhere)
 * on an injected failure at three different points in the write span (an
 * early failure, a missing-config failure, and the LAST write in the
 * transaction). Pure move: no test case dropped, weakened or merged, no
 * assertion changed. Own fixtures (independent of the sibling
 * signup.integration.test.ts).
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
  return `signup-${label}-${randomUUID()}@example.test`;
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

describe('signup (P04a Unit A3, rollback on failure)', () => {
  it('signup_rolls_back_completely_when_the_wallet_insert_fails', async () => {
    const email = uniqueEmail('wallet-fail');

    await expect(
      signup(
        baseCtx({
          provisioningRepo: {
            insertWalletAccount: async () => {
              throw new Error('injected wallet insert failure');
            },
          },
        }),
        { fullName: 'Failed Signup', email, companyName: 'Should Not Exist Inc' },
      ),
    ).rejects.toThrow('injected wallet insert failure');

    const users = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users.rows).toHaveLength(0);

    const clients = await pool.query('SELECT id FROM clients WHERE company_name = $1', [
      'Should Not Exist Inc',
    ]);
    expect(clients.rows).toHaveLength(0);

    const ledger = await pool.query(
      'SELECT wl.client_id FROM wallet_ledger wl JOIN clients c ON c.id = wl.client_id WHERE c.company_name = $1',
      ['Should Not Exist Inc'],
    );
    expect(ledger.rows).toHaveLength(0);
  });

  it('signup_fails_loudly_when_the_default_price_list_is_missing', async () => {
    const email = uniqueEmail('missing-price-list');

    await expect(
      signup(baseCtx({ priceListKey: 'nonexistent_price_list_key' }), {
        fullName: 'No Price List',
        email,
        companyName: 'No Price List Co',
      }),
    ).rejects.toThrow(DefaultPriceListMissingError);

    const users = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users.rows).toHaveLength(0);

    const clients = await pool.query('SELECT id FROM clients WHERE company_name = $1', [
      'No Price List Co',
    ]);
    expect(clients.rows).toHaveLength(0);
  });

  it('signup_rolls_back_completely_when_the_audit_log_insert_fails', async () => {
    // Failure point moved to the LAST write in the transaction (after wallet
    // account, client_pricing, wallet_ledger and wallet_ledger_ext_refs have
    // all already been written to the in-transaction buffer) - proves the
    // rollback covers the whole span, not just the point the other injected
    // test happens to hit.
    const email = uniqueEmail('audit-fail');

    await expect(
      signup(
        baseCtx({
          provisioningRepo: {
            insertAuditLog: async () => {
              throw new Error('injected audit log insert failure');
            },
          },
        }),
        { fullName: 'Audit Fail Signup', email, companyName: 'Audit Fail Co' },
      ),
    ).rejects.toThrow('injected audit log insert failure');

    const users = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users.rows).toHaveLength(0);

    const clients = await pool.query('SELECT id FROM clients WHERE company_name = $1', [
      'Audit Fail Co',
    ]);
    expect(clients.rows).toHaveLength(0);

    const walletAccounts = await pool.query(
      `SELECT wa.client_id FROM wallet_accounts wa
         JOIN clients c ON c.id = wa.client_id
        WHERE c.company_name = $1`,
      ['Audit Fail Co'],
    );
    expect(walletAccounts.rows).toHaveLength(0);

    const ledger = await pool.query(
      `SELECT wl.client_id FROM wallet_ledger wl
         JOIN clients c ON c.id = wl.client_id
        WHERE c.company_name = $1`,
      ['Audit Fail Co'],
    );
    expect(ledger.rows).toHaveLength(0);

    const extRefs = await pool.query(
      `SELECT wler.client_id FROM wallet_ledger_ext_refs wler
         JOIN clients c ON c.id = wler.client_id
        WHERE c.company_name = $1`,
      ['Audit Fail Co'],
    );
    expect(extRefs.rows).toHaveLength(0);
  });
});
