import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';

/**
 * wallet-checkpoint-and-signup-shape.integration.test.ts (P18 fix-round F1,
 * reviewer C2) - replaces
 * checkpoint-balance-not-initialised-at-signup.integration.test.ts, which
 * exercised `runOneWalletReconcileSweep` against the `seedSendTenant`
 * FIXTURE shape (a wallet_accounts row with a non-zero balance and ZERO
 * wallet_ledger rows) and asserted that shape should be reported as clean.
 * That premise was wrong: `seedSendTenant` is a send-path fixture, not a
 * signup simulation - the REAL signup path
 * (`modules/identity/signup.service.ts`, via
 * `provisioningRepo.insertWalletAccount` + `insertWalletLedgerEntry`) always
 * writes a `wallet_ledger` row at `seq = 1` (`kind = 'signup_credit'`)
 * alongside `wallet_accounts.entry_seq = 1`, so a real fresh signup's ledger
 * is never empty. This file calls `wp_wallet_check_continuity` directly
 * (migration 0057) against BOTH shapes to pin the correct, current
 * behaviour of each: the real production signup shape must be clean, and
 * the old fixture's ledger-less shape is, BY DESIGN, still flagged as
 * balance_mismatch drift (a plain `seedSendTenant()` call is not a signup
 * simulation and was never meant to satisfy the continuity check).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-checkpoint-and-signup-shape-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wallet checkpoint continuity vs. the real signup shape', () => {
  it('the_production_signup_shape_produces_zero_continuity_findings', async () => {
    const tenant = await seedSendTenant(pool, probeClientIds, { balanceMinor: 100_000 });

    // Reproduce the REAL signup.service.ts shape: one wallet_ledger row at
    // seq 1, kind 'signup_credit', amount/balance_after = the seeded
    // balance, actor_type 'user', instance_id NULL (a signup credit is not
    // tied to any WhatsApp instance) - and wallet_accounts.entry_seq
    // bumped to 1 to match (checkpoint stays at its schema default 0/0,
    // exactly as insertWalletAccount leaves it).
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, instance_id, created_at)
       VALUES ($1, 1, 'signup_credit', 100000, 100000, 'user', NULL, now())`,
      [tenant.clientId],
    );
    await pool.query('UPDATE wallet_accounts SET entry_seq = 1 WHERE client_id = $1', [
      tenant.clientId,
    ]);

    const findings = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM wp_wallet_check_continuity(500) WHERE client_id = $1`,
      [tenant.clientId],
    );

    expect(findings.rows).toHaveLength(0);
  });

  it('a_balance_with_no_ledger_rows_is_reported_as_drift_by_design', async () => {
    // Plain seedSendTenant(): balance_minor 100000, zero wallet_ledger
    // rows. This is NOT the real signup shape (see file header) - it is
    // flagged as balance_mismatch by design, and this test exists so a
    // future change cannot silently "fix" the continuity check to treat an
    // empty ledger with a non-zero balance as clean, which would also mask
    // a genuine drift for a client whose real ledger history fell out of
    // the reconciler's scan window entirely.
    const tenant = await seedSendTenant(pool, probeClientIds, { balanceMinor: 100_000 });

    const findings = await pool.query<{
      client_id: string;
      kind: string;
      detail: { ledger_balance?: number; account_balance?: number };
      amount_minor: string;
    }>(
      `SELECT client_id, kind, detail, amount_minor::text FROM wp_wallet_check_continuity(500) WHERE client_id = $1`,
      [tenant.clientId],
    );

    expect(findings.rows).toHaveLength(1);
    expect(findings.rows[0]?.kind).toBe('balance_mismatch');
    expect(findings.rows[0]?.amount_minor).toBe('100000');
    expect(findings.rows[0]?.detail).toMatchObject({ ledger_balance: 0, account_balance: 100000 });
  });
});
