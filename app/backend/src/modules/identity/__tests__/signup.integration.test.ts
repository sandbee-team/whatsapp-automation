import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { SignupConflictError, signup, type SignupCtx } from '../signup.service.js';

/**
 * signup.integration.test.ts (P04a Unit A3; rollback cases split out to
 * signup-rollback.integration.test.ts, P04a FIXD, for max-lines) - the
 * happy path, the bulk wallet-rate invariant, concurrent-duplicate-email
 * conflict, the slug-collision retry, and the direct wallet_ledger_ext_refs
 * idempotency proof, against a real Postgres. `pool` connects with the same
 * dev credentials every other app-backend integration test uses (see
 * claim.rls.integration.test.ts) - an owning/superuser role that bypasses
 * RLS, exactly like the rest of this suite; RLS-under-a-real-role proofs are
 * out of this unit's scope. Pure move: no test case dropped, weakened or
 * merged, no assertion changed.
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

describe('signup (P04a Unit A3, one-transaction signup)', () => {
  it('signup_creates_user_client_membership_wallet_pricing_and_credit_in_one_transaction', async () => {
    const email = uniqueEmail('happy-path');

    const result = await signup(baseCtx(), {
      fullName: 'Ada Lovelace',
      email,
      companyName: 'Analytical Engines Pvt Ltd',
    });
    createdUserIds.push(result.userId);
    createdClientIds.push(result.clientId);

    const [users, clients, memberships, walletAccounts, clientPricing, walletLedger, auditLogs] =
      await Promise.all([
        pool.query('SELECT id FROM users WHERE id = $1', [result.userId]),
        pool.query('SELECT id FROM clients WHERE id = $1', [result.clientId]),
        pool.query('SELECT client_id FROM memberships WHERE client_id = $1', [result.clientId]),
        pool.query('SELECT client_id, entry_seq FROM wallet_accounts WHERE client_id = $1', [
          result.clientId,
        ]),
        pool.query('SELECT client_id FROM client_pricing WHERE client_id = $1', [result.clientId]),
        pool.query('SELECT client_id, seq FROM wallet_ledger WHERE client_id = $1', [
          result.clientId,
        ]),
        pool.query(
          "SELECT client_id FROM audit_logs WHERE client_id = $1 AND action = 'auth.signup'",
          [result.clientId],
        ),
      ]);

    expect(users.rows).toHaveLength(1);
    expect(clients.rows).toHaveLength(1);
    expect(memberships.rows).toHaveLength(1);
    expect(walletAccounts.rows).toHaveLength(1);
    expect(clientPricing.rows).toHaveLength(1);
    expect(walletLedger.rows).toHaveLength(1);
    expect(auditLogs.rows).toHaveLength(1);

    // P18 Unit U7b: wallet_accounts.entry_seq must equal the highest
    // wallet_ledger.seq for the client - debit-send.sql allocates its next
    // ledger row at entry_seq + 1, so a mismatch here would collide on the
    // ledger's (client_id, seq, created_at) primary key on the first paid send.
    const maxSeq = Math.max(...walletLedger.rows.map((row: { seq: number }) => row.seq));
    expect(String(walletAccounts.rows[0].entry_seq)).toBe(String(maxSeq));
  });

  it('no_wallet_accounts_row_has_max_rate_minor_zero', async () => {
    const results = [];
    for (let i = 0; i < 50; i += 1) {
      const email = uniqueEmail(`bulk-${String(i)}`);

      const result = await signup(baseCtx(), {
        fullName: `Bulk Signup ${String(i)}`,
        email,
        companyName: `Bulk Co ${String(i)}`,
      });
      results.push(result);
    }
    for (const result of results) {
      createdUserIds.push(result.userId);
      createdClientIds.push(result.clientId);
    }

    const zeroCount = await pool.query(
      'SELECT count(*) AS count FROM wallet_accounts WHERE client_id = ANY($1) AND max_rate_minor <= 0',
      [results.map((r) => r.clientId)],
    );
    expect(Number(zeroCount.rows[0].count)).toBe(0);
  });

  it('two_concurrent_signups_with_the_same_email_only_one_succeeds', async () => {
    // Both signups start (and both do their `insertUser` INSERT) before
    // either commits - Postgres's own `users_email_key` unique index is the
    // arbiter, not an application-level pre-check (core invariant 3).
    const email = uniqueEmail('concurrent-dup');

    const results = await Promise.allSettled([
      signup(baseCtx(), { fullName: 'Concurrent A', email, companyName: 'Concurrent Co A' }),
      signup(baseCtx(), { fullName: 'Concurrent B', email, companyName: 'Concurrent Co B' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SignupConflictError);

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ userId: string; clientId: string }>)
      .value;
    createdUserIds.push(winner.userId);
    createdClientIds.push(winner.clientId);

    const users = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users.rows).toHaveLength(1);

    const clients = await pool.query(
      "SELECT id FROM clients WHERE company_name IN ('Concurrent Co A', 'Concurrent Co B')",
    );
    expect(clients.rows).toHaveLength(1);
  });

  it('signup_retries_once_on_a_slug_collision_and_still_succeeds', async () => {
    // FIX 5 (P04a FIXA C1 review): the retry was dead code (no SAVEPOINT) -
    // forces the FIRST slug attempt to collide via the injected suffix
    // generator, pre-seeded with a client that already owns that exact
    // slug, and asserts signup still succeeds with the SECOND suffix.
    const email = uniqueEmail('slug-collision');
    const companyName = 'Slug Collision Co';
    const collidingSuffix = 'aaaaaa';
    const freshSuffix = 'bbbbbb';
    const collidingSlug = `slug-collision-co-${collidingSuffix}`;

    const preexistingClientId = randomUUID();
    createdClientIds.push(preexistingClientId);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      preexistingClientId,
      'Pre-existing Slug Owner',
      collidingSlug,
    ]);

    let call = 0;
    const result = await signup(
      baseCtx({
        generateSlugSuffix: () => {
          call += 1;
          return call === 1 ? collidingSuffix : freshSuffix;
        },
      }),
      { fullName: 'Slug Collision', email, companyName },
    );
    createdUserIds.push(result.userId);
    createdClientIds.push(result.clientId);

    const clientRow = await pool.query<{ slug: string }>('SELECT slug FROM clients WHERE id = $1', [
      result.clientId,
    ]);
    expect(clientRow.rows[0]!.slug).toBe(`slug-collision-co-${freshSuffix}`);
  });

  it('wallet_ledger_ext_refs_blocks_a_second_insert_with_the_same_client_id_and_external_ref', async () => {
    // Direct proof of the storage-layer idempotency authority the signup
    // transaction relies on (ADR 0002/0019): the belt-and-suspenders
    // PRIMARY KEY (client_id, external_ref), exercised outside the service
    // so a future signup.service refactor can't quietly stop relying on it
    // without a test noticing.
    const clientId = randomUUID();
    createdClientIds.push(clientId);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Ext Ref Direct Co',
      `ext-ref-direct-${clientId}`,
    ]);
    const externalRef = `signup:${clientId}`;

    await pool.query(
      'INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq) VALUES ($1, $2, $3)',
      [clientId, externalRef, 1],
    );

    await expect(
      pool.query(
        'INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq) VALUES ($1, $2, $3)',
        [clientId, externalRef, 2],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
