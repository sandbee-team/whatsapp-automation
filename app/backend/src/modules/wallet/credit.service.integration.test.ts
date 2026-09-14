import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  seedQueuedJob,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { claimOne } from '../queue/queue.repo.js';
import { creditWalletAndNotify } from './credit.service.js';

/**
 * credit.service.integration.test.ts (P19 Unit U4, step 5/6/7 demo) - real
 * Postgres, no Redis (`publishWake` is a no-op stub here - the real-channel
 * proof lives in `resume-wake.test.ts`'s own unit-level fan-out assertions
 * plus `engine/queue/wake.ts`'s own suite; this file only proves the credit
 * -> state -> claim-eligibility chain end to end).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'credit-service-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function noopWakeDeps(): { publishWake: () => void; nowMs: number } {
  return { publishWake: () => undefined, nowMs: Date.parse('2026-09-04T00:00:00.000Z') };
}

describe('creditWalletAndNotify - the phase demo', () => {
  it('a_staff_credit_from_empty_sets_active_and_the_drain_resumes', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      walletState: 'empty',
      maxRateMinor: 100,
    });
    await pool.query(
      `UPDATE wallet_accounts SET low_balance_threshold_minor = 0 WHERE client_id = $1`,
      [seeded.clientId],
    );
    await seedQueuedJob(pool, { clientId: seeded.clientId, instanceId: seeded.instanceId });

    const tenantDb = createTenantDb(pool);
    const result = await creditWalletAndNotify(
      { tenantDb, ...noopWakeDeps() },
      {
        clientId: seeded.clientId,
        amountMinor: 10_000n,
        kind: 'topup_manual',
        reason: 'staff approved manual top-up',
        externalRef: `topup-${randomUUID()}`,
        staffId: randomUUID(),
      },
    );

    expect(result.stateBefore).toBe('empty');
    expect(result.stateAfter).toBe('active');
    expect(result.wokeInstances).toBe(true);

    const ledgerRow = await pool.query<{ balance_after_minor: string }>(
      'SELECT balance_after_minor::text FROM wallet_ledger WHERE client_id = $1 ORDER BY seq DESC LIMIT 1',
      [seeded.clientId],
    );
    expect(ledgerRow.rows[0]?.balance_after_minor).toBe('10000');

    const claimed = await claimOne(
      { clientId: seeded.clientId, sql: pool },
      {
        instanceId: seeded.instanceId,
        band: 3,
        fence: 1,
        workerId: 'worker-1',
        claimExpiryMs: TIMING.claimExpiryMs,
      },
    );
    expect(claimed).toBeDefined();
  });

  it('topup_does_not_clear_a_provider_restriction_pause', async () => {
    const restricted = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      walletState: 'empty',
      maxRateMinor: 100,
      healthState: 'paused',
    });
    await pool.query(
      `UPDATE whatsapp_instances SET pause_reason = 'provider_restriction' WHERE id = $1`,
      [restricted.instanceId],
    );
    await seedQueuedJob(pool, { clientId: restricted.clientId, instanceId: restricted.instanceId });

    const healthy = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      walletState: 'empty',
      maxRateMinor: 100,
    });
    await seedQueuedJob(pool, { clientId: healthy.clientId, instanceId: healthy.instanceId });

    const tenantDb = createTenantDb(pool);

    for (const seeded of [restricted, healthy]) {
      await creditWalletAndNotify(
        { tenantDb, ...noopWakeDeps() },
        {
          clientId: seeded.clientId,
          amountMinor: 10_000n,
          kind: 'topup_manual',
          reason: 'staff approved manual top-up',
          externalRef: `topup-${randomUUID()}`,
          staffId: randomUUID(),
        },
      );
    }

    const restrictedInstance = await pool.query<{ health_state: string; pause_reason: string }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [restricted.instanceId],
    );
    expect(restrictedInstance.rows[0]?.health_state).toBe('paused');
    expect(restrictedInstance.rows[0]?.pause_reason).toBe('provider_restriction');

    const restrictedClaim = await claimOne(
      { clientId: restricted.clientId, sql: pool },
      {
        instanceId: restricted.instanceId,
        band: 3,
        fence: 1,
        workerId: 'worker-1',
        claimExpiryMs: TIMING.claimExpiryMs,
      },
    );
    expect(restrictedClaim).toBeUndefined();

    const healthyClaim = await claimOne(
      { clientId: healthy.clientId, sql: pool },
      {
        instanceId: healthy.instanceId,
        band: 3,
        fence: 1,
        workerId: 'worker-1',
        claimExpiryMs: TIMING.claimExpiryMs,
      },
    );
    expect(healthyClaim).toBeDefined();
  });
});
