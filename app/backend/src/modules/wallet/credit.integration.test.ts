import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { nextWalletState } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { creditWallet } from './credit.repo.js';

/**
 * credit.integration.test.ts (P19 Unit U2, step 4) - real Postgres, the
 * guard-first credit's single-statement proofs: replay safety, overdraft
 * absorption, frozen-wallet non-unfreeze, and the DB half of the
 * nextWalletState agreement test (the pure boundary table lives in
 * `packages/domain/test/wallet-state.test.ts`, since `packages/domain` has
 * no DB - this file proves the real `wallet-credit.sql` CASE reproduces the
 * identical table through a live Postgres). Every test reads a
 * money-shaped column `::text` (bigint) and compares strings - never a JS
 * number round-trip.
 *
 * Cases NOT in this file (left to a later unit that has the service layer
 * + claim loop): `a_staff_credit_from_empty_sets_active_and_the_drain_
 * resumes`, `topup_does_not_clear_a_provider_restriction_pause`,
 * `pricing_change_takes_effect_on_the_very_next_claim`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'credit-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the guard-first credit - real Postgres', () => {
  it('a_replayed_credit_leaves_balance_byte_identical', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: 1000 });
    const tenantDb = createTenantDb(pool);
    const externalRef = `topup-${randomUUID()}`;

    const first = await tenantDb.withTenant(seeded.clientId, (tx) =>
      creditWallet(tx, {
        clientId: seeded.clientId,
        amountMinor: 5000n,
        kind: 'topup_manual',
        reason: 'approved manual top-up',
        externalRef,
        staffId: randomUUID(),
      }),
    );
    expect(first.replayed).toBe(false);

    const balanceAfterFirst = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterFirst.rows[0]?.balance_minor).toBe('6000');

    const second = await tenantDb.withTenant(seeded.clientId, (tx) =>
      creditWallet(tx, {
        clientId: seeded.clientId,
        amountMinor: 5000n,
        kind: 'topup_manual',
        reason: 'approved manual top-up',
        externalRef,
        staffId: randomUUID(),
      }),
    );
    expect(second.replayed).toBe(true);
    expect(second.seq).toBe(first.seq);

    const balanceAfterSecond = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterSecond.rows[0]?.balance_minor).not.toBeNull();
    expect(balanceAfterSecond.rows[0]?.balance_minor).toBe('6000');

    const ledgerRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND external_ref = $2',
      [seeded.clientId, externalRef],
    );
    expect(ledgerRows.rows[0]?.count).toBe('1');
  });

  it('a_credit_after_an_overdraft_absorbs_the_negative_balance', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: -45 });
    const tenantDb = createTenantDb(pool);

    await tenantDb.withTenant(seeded.clientId, (tx) =>
      creditWallet(tx, {
        clientId: seeded.clientId,
        amountMinor: 10_000n,
        kind: 'adjustment_credit',
        reason: 'goodwill correction after overdraft',
        externalRef: `adj-${randomUUID()}`,
        staffId: randomUUID(),
      }),
    );

    const balanceRow = await pool.query<{ balance_minor: string; entry_seq: string }>(
      'SELECT balance_minor::text, entry_seq::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('9955');
    expect(balanceRow.rows[0]?.entry_seq).toBe('1');

    const ledgerRow = await pool.query<{ balance_after_minor: string; amount_minor: string }>(
      'SELECT balance_after_minor::text, amount_minor::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRow.rows[0]?.balance_after_minor).toBe('9955');
    expect(ledgerRow.rows[0]?.amount_minor).toBe('10000');
  });

  it('a_topup_does_not_unfreeze_a_frozen_wallet', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 1000,
      walletState: 'frozen',
    });
    const tenantDb = createTenantDb(pool);

    await tenantDb.withTenant(seeded.clientId, (tx) =>
      creditWallet(tx, {
        clientId: seeded.clientId,
        amountMinor: 5000n,
        kind: 'topup_manual',
        reason: 'approved manual top-up while frozen',
        externalRef: `topup-${randomUUID()}`,
        staffId: randomUUID(),
      }),
    );

    const acctRow = await pool.query<{ state: string; balance_minor: string; entry_seq: string }>(
      'SELECT state, balance_minor::text, entry_seq::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(acctRow.rows[0]?.state).toBe('frozen');
    expect(acctRow.rows[0]?.balance_minor).toBe('6000');
    expect(acctRow.rows[0]?.entry_seq).toBe('1');

    const ledgerRow = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRow.rows[0]?.count).toBe('1');
  });

  it('the_sql_case_agrees_with_next_wallet_state_on_every_boundary', async () => {
    const maxRateMinor = 100;
    const lowThresholdMinor = 5000;
    // Same table as packages/domain/test/wallet-state.test.ts's
    // `the_ts_state_function_agrees_with_the_sql_case_on_every_boundary`.
    // Each row seeds a fresh wallet at (boundary - amount) and credits
    // exactly `amount`, so the account lands on the boundary balance
    // itself, then compares the real statement's resulting `state` against
    // the pure TS function fed the identical inputs.
    const boundaries = [maxRateMinor - 1, maxRateMinor, lowThresholdMinor - 1, lowThresholdMinor];

    for (const targetBalance of boundaries) {
      const startingBalance = 0;
      const amountMinor = targetBalance - startingBalance;
      const seeded = await seedSendTenant(pool, probeClientIds, {
        balanceMinor: startingBalance,
        maxRateMinor,
      });
      await pool.query(
        'UPDATE wallet_accounts SET low_balance_threshold_minor = $1 WHERE client_id = $2',
        [lowThresholdMinor, seeded.clientId],
      );
      const tenantDb = createTenantDb(pool);

      await tenantDb.withTenant(seeded.clientId, (tx) =>
        creditWallet(tx, {
          clientId: seeded.clientId,
          amountMinor: BigInt(amountMinor),
          kind: 'promo_credit',
          reason: 'boundary sweep',
          externalRef: `boundary-${randomUUID()}`,
          staffId: randomUUID(),
        }),
      );

      const acctRow = await pool.query<{ state: string }>(
        'SELECT state FROM wallet_accounts WHERE client_id = $1',
        [seeded.clientId],
      );
      const expected = nextWalletState({
        balanceMinor: targetBalance,
        maxRateMinor,
        lowThresholdMinor,
        currentState: 'active',
      });
      expect(acctRow.rows[0]?.state).toBe(expected);
    }
  });
});
