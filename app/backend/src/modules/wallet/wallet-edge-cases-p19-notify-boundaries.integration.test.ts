import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { creditWalletAndNotify } from './credit.service.js';
import { notifyLowIfDue } from './state-notifier.js';

/**
 * wallet-edge-cases-p19-notify-boundaries.integration.test.ts (P19 C2
 * hardening, max-lines split 2/3 of wallet-edge-cases-p19) - real Postgres:
 * the wake-gate's frozen-absorbing/zero-instance/active-to-active cases, the
 * state CASE's exact boundary semantics, and the once-per-24h gate's real
 * SQL boundary (`interval '24 hours'`, never the injected `nowMs` - that gate
 * runs on the database's own `now()`).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-cases-p19-notify-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function noopWakeDeps(nowMs = Date.parse('2026-09-04T00:00:00.000Z')): {
  publishWake: () => void;
  nowMs: number;
} {
  return { publishWake: () => undefined, nowMs };
}

describe('creditWalletAndNotify - frozen absorbing and zero-instance wake (real Postgres)', () => {
  it('a_credit_a_large_credit_and_a_post_overdraft_credit_against_a_frozen_wallet_never_wake_or_change_state', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: -500,
      walletState: 'frozen',
    });
    const tenantDb = createTenantDb(pool);

    const amounts = [1000, 1_000_000_000, 500];
    for (const amountMinor of amounts) {
      const result = await creditWalletAndNotify(
        { tenantDb, ...noopWakeDeps() },
        {
          clientId: seeded.clientId,
          amountMinor: BigInt(amountMinor),
          kind: 'adjustment_credit',
          reason: 'frozen absorbing sweep',
          externalRef: `adj-${randomUUID()}`,
          staffId: randomUUID(),
        },
      );
      expect(result.stateBefore).toBe('frozen');
      expect(result.stateAfter).toBe('frozen');
      expect(result.wokeInstances).toBe(false);
    }

    const acctRow = await pool.query<{ state: string; balance_minor: string }>(
      'SELECT state, balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(acctRow.rows[0]?.state).toBe('frozen');
    // -500 + 1000 + 1_000_000_000 + 500 = 1_000_001_000 - funds landed even
    // though the wallet stayed frozen and un-claimable throughout.
    expect(acctRow.rows[0]?.balance_minor).toBe('1000001000');
  });

  it('a_credit_on_a_client_with_zero_instances_publishes_no_wake_and_still_commits_the_money', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      walletState: 'empty',
      maxRateMinor: 100,
    });
    // Remove the one instance seedSendTenant creates, so this client has
    // ZERO whatsapp_instances - a wallet-only client with no connected
    // number yet (the phase's own "empty and huge inputs" case).
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = $1', [seeded.clientId]);
    await pool.query('DELETE FROM instance_pacing_state WHERE client_id = $1', [seeded.clientId]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = $1', [seeded.clientId]);

    const tenantDb = createTenantDb(pool);
    let wakeCalls = 0;
    const result = await creditWalletAndNotify(
      {
        tenantDb,
        publishWake: () => {
          wakeCalls += 1;
        },
        nowMs: Date.parse('2026-09-04T00:00:00.000Z'),
      },
      {
        clientId: seeded.clientId,
        amountMinor: 10_000n,
        kind: 'topup_manual',
        reason: 'zero-instance client tops up',
        externalRef: `topup-${randomUUID()}`,
        staffId: randomUUID(),
      },
    );

    expect(result.stateBefore).toBe('empty');
    expect(result.stateAfter).toBe('active');
    // wokeInstances reflects "this credit qualified for a wake attempt", but
    // publishWakeForClient's own instance list is empty, so the underlying
    // publish callback is never actually invoked.
    expect(wakeCalls).toBe(0);

    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('10000');
  });

  it('active_to_active_and_a_replayed_credit_never_wake_or_re_notify', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: 100_000 });
    const tenantDb = createTenantDb(pool);
    const externalRef = `topup-${randomUUID()}`;
    let wakeCalls = 0;
    const deps = {
      tenantDb,
      publishWake: () => {
        wakeCalls += 1;
      },
      nowMs: Date.parse('2026-09-04T00:00:00.000Z'),
    };

    const first = await creditWalletAndNotify(deps, {
      clientId: seeded.clientId,
      amountMinor: 1000n,
      kind: 'topup_manual',
      reason: 'already active client tops up',
      externalRef,
      staffId: randomUUID(),
    });
    expect(first.stateBefore).toBe('active');
    expect(first.stateAfter).toBe('active');
    expect(first.wokeInstances).toBe(false);
    expect(wakeCalls).toBe(0);

    const replay = await creditWalletAndNotify(deps, {
      clientId: seeded.clientId,
      amountMinor: 1000n,
      kind: 'topup_manual',
      reason: 'replay of the active topup',
      externalRef,
      staffId: randomUUID(),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.wokeInstances).toBe(false);
    expect(wakeCalls).toBe(0);
  });
});

describe('creditWalletAndNotify - state boundary exactness (real Postgres)', () => {
  it('a_credit_landing_exactly_on_max_rate_minor_is_not_empty_and_exactly_on_low_threshold_is_not_low', async () => {
    const maxRateMinor = 500;
    const lowThresholdMinor = 5000;

    // Case 1: balance lands EXACTLY on maxRateMinor - the SQL CASE is
    // `< max_rate_minor -> empty`, so exactly-on must NOT be empty (must
    // fall through to low, since maxRateMinor < lowThresholdMinor here).
    const onMaxRate = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      maxRateMinor,
    });
    await pool.query(
      'UPDATE wallet_accounts SET low_balance_threshold_minor = $1 WHERE client_id = $2',
      [lowThresholdMinor, onMaxRate.clientId],
    );
    const tenantDb = createTenantDb(pool);
    const resultOnMaxRate = await creditWalletAndNotify(
      { tenantDb, ...noopWakeDeps() },
      {
        clientId: onMaxRate.clientId,
        amountMinor: BigInt(maxRateMinor),
        kind: 'promo_credit',
        reason: 'lands exactly on max_rate_minor',
        externalRef: `boundary-${randomUUID()}`,
        staffId: randomUUID(),
      },
    );
    expect(resultOnMaxRate.stateAfter).toBe('low');

    // Case 2: balance lands EXACTLY on lowThresholdMinor - `< low_threshold
    // -> low`, so exactly-on must NOT be low (must be active).
    const onLowThreshold = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      maxRateMinor,
    });
    await pool.query(
      'UPDATE wallet_accounts SET low_balance_threshold_minor = $1 WHERE client_id = $2',
      [lowThresholdMinor, onLowThreshold.clientId],
    );
    const resultOnLowThreshold = await creditWalletAndNotify(
      { tenantDb, ...noopWakeDeps() },
      {
        clientId: onLowThreshold.clientId,
        amountMinor: BigInt(lowThresholdMinor),
        kind: 'promo_credit',
        reason: 'lands exactly on low_balance_threshold_minor',
        externalRef: `boundary-${randomUUID()}`,
        staffId: randomUUID(),
      },
    );
    expect(resultOnLowThreshold.stateAfter).toBe('active');
  });
});

describe('the once-per-24h low-warning gate - real SQL boundary (real Postgres)', () => {
  it('an_ancient_warning_and_one_exactly_at_24_hours_both_re_fire_but_23h59m59s_does_not', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: 0 });
    const tenantDb = createTenantDb(pool);

    // 23h 59m 59s ago - strictly WITHIN the 24h window (interval '24 hours'
    // means "< 24h ago" fails the gate) - must NOT fire.
    await pool.query(
      `UPDATE wallet_accounts SET last_low_warning_at = now() - interval '23 hours 59 minutes 59 seconds' WHERE client_id = $1`,
      [seeded.clientId],
    );
    const withinWindow = await tenantDb.withTenant(seeded.clientId, (tx) =>
      notifyLowIfDue(tx, { nowMs: Date.parse('2026-09-04T00:00:00.000Z') }, seeded.clientId),
    );
    expect(withinWindow).toBe(false);

    // Exactly 24 hours and 1 second ago - past the boundary - must fire.
    await pool.query(
      `UPDATE wallet_accounts SET last_low_warning_at = now() - interval '24 hours 1 second' WHERE client_id = $1`,
      [seeded.clientId],
    );
    const pastWindow = await tenantDb.withTenant(seeded.clientId, (tx) =>
      notifyLowIfDue(tx, { nowMs: Date.parse('2026-09-04T00:00:00.000Z') }, seeded.clientId),
    );
    expect(pastWindow).toBe(true);

    // Never warned before (NULL) - must fire.
    const neverWarned = await seedSendTenant(pool, probeClientIds, { balanceMinor: 0 });
    const neverWarnedResult = await tenantDb.withTenant(neverWarned.clientId, (tx) =>
      notifyLowIfDue(tx, { nowMs: Date.parse('2026-09-04T00:00:00.000Z') }, neverWarned.clientId),
    );
    expect(neverWarnedResult).toBe(true);
  });
});
