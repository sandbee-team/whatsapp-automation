import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  makeStaffHeaders,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { notificationKinds, walletAccount } from './__tests__/internal-probe-support.js';

/**
 * internal-unfreeze-state.integration.test.ts (P28 Unit U3a, step 4) -
 * `unfreeze_derives_the_state_from_the_balance`, split out of
 * `internal-mutations.integration.test.ts` for that file's `max-lines: 300`
 * cap (the established sibling-split idiom). It is the natural split point:
 * this is the only mutation case about STATE DERIVATION and wake publishing
 * rather than about money/audit rows, so it is the one case that needs a
 * recording `publishWake`.
 *
 * The derivation under test is `unfreeze`'s own SQL `CASE`: a frozen wallet
 * returns to `empty`/`low`/`active` purely from its stored balance against
 * `max_rate_minor`/`low_balance_threshold_minor` - staff never pick the
 * resulting state, and a wake is published ONLY when the wallet actually
 * became claimable (`active`/`low`), never on `empty`.
 */

const SECRET = 'internal-unfreeze-test-secret-0123456789';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];
const wakes: Array<{ clientId: string; instanceId: string }> = [];

const staffHeaders = makeStaffHeaders(SECRET);

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-unfreeze-tests',
  });
  tenantDb = createTenantDb(pool);
  app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: SECRET,
      allowedCidrs: '0.0.0.0/0',
      publishWake: (clientId, instanceId) => {
        wakes.push({ clientId, instanceId });
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

beforeEach(() => {
  wakes.length = 0;
});

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function unfreeze(clientId: string, staffId: string): Promise<InjectResponse> {
  const path = `/internal/v1/clients/${clientId}/wallet/unfreeze`;
  return app.inject({
    method: 'POST',
    url: path,
    headers: staffHeaders('POST', path, staffId),
    payload: { reason: 'dispute resolved, releasing the freeze' },
  });
}

describe('internal-unfreeze-state', () => {
  it('unfreeze_derives_the_state_from_the_balance', async () => {
    const staffId = await seedStaffUser(pool, 'superadmin');
    probeStaffIds.push(staffId);

    // (a) frozen + a balance below `max_rate_minor` -> 'empty': the wallet
    // cannot fund even one send, so it is still NOT claimable and NO wake is
    // published (waking a worker that would immediately find nothing
    // claimable is exactly the hot-spin this gate exists to prevent).
    const zero = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 0,
      walletState: 'frozen',
      maxRateMinor: 100,
    });
    const zeroResponse = await unfreeze(zero.clientId, staffId);
    expect(zeroResponse.statusCode).toBe(200);
    expect(zeroResponse.json().data.changed).toBe(true);
    expect(zeroResponse.json().data.state).toBe('empty');
    expect((await walletAccount(pool, zero.clientId)).state).toBe('empty');
    expect(wakes.filter((wake) => wake.clientId === zero.clientId)).toEqual([]);
    // The tenant is still told the freeze was lifted - that happened.
    expect(await notificationKinds(pool, zero.clientId)).toEqual(['wallet_unfrozen']);

    // (b) frozen + a healthy balance -> 'active', and exactly ONE wake per
    // non-deleted instance of that client (this tenant has one).
    const healthy = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 500_000,
      walletState: 'frozen',
      maxRateMinor: 100,
    });
    const healthyResponse = await unfreeze(healthy.clientId, staffId);
    expect(healthyResponse.statusCode).toBe(200);
    expect(healthyResponse.json().data.changed).toBe(true);
    expect(healthyResponse.json().data.state).toBe('active');
    expect((await walletAccount(pool, healthy.clientId)).state).toBe('active');
    expect(wakes.filter((wake) => wake.clientId === healthy.clientId)).toEqual([
      { clientId: healthy.clientId, instanceId: healthy.instanceId },
    ]);
    expect(await notificationKinds(pool, healthy.clientId)).toEqual(['wallet_unfrozen']);

    // (c) unfreezing an already-unfrozen wallet is a no-op (`changed:false`),
    // never an error - and it must not re-notify or re-wake.
    wakes.length = 0;
    const again = await unfreeze(healthy.clientId, staffId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.changed).toBe(false);
    expect(again.json().data.state).toBe('frozen');
    expect(wakes).toEqual([]);
    expect(await notificationKinds(pool, healthy.clientId)).toEqual(['wallet_unfrozen']);
  });

  it('unfreeze_with_balance_equal_to_the_low_threshold_derives_active', async () => {
    const staffId = await seedStaffUser(pool, 'superadmin');
    probeStaffIds.push(staffId);

    // `low_balance_threshold_minor` defaults to 5000 (migration 0004),
    // `max_rate_minor` set to 100 below. The canonical derivation
    // (`@wp/domain#nextWalletState`) uses STRICT `<` for the low-threshold
    // comparison, so a balance EXACTLY AT the threshold is 'active', never
    // 'low' - this is the exact boundary MAJOR 1 (C1 review round 2) found
    // wallet.ts's hand-rolled CASE getting wrong with `<=`.

    // (a) balance == low threshold (5000) -> 'active'.
    const atThreshold = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 5000,
      walletState: 'frozen',
      maxRateMinor: 100,
    });
    const atThresholdResponse = await unfreeze(atThreshold.clientId, staffId);
    expect(atThresholdResponse.statusCode).toBe(200);
    expect(atThresholdResponse.json().data.state).toBe('active');
    expect((await walletAccount(pool, atThreshold.clientId)).state).toBe('active');

    // (b) balance == low threshold - 1 (4999) -> 'low'.
    const belowThreshold = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 4999,
      walletState: 'frozen',
      maxRateMinor: 100,
    });
    const belowThresholdResponse = await unfreeze(belowThreshold.clientId, staffId);
    expect(belowThresholdResponse.statusCode).toBe(200);
    expect(belowThresholdResponse.json().data.state).toBe('low');
    expect((await walletAccount(pool, belowThreshold.clientId)).state).toBe('low');

    // (c) balance == max_rate_minor - 1 (99) -> 'empty'.
    const belowMaxRate = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 99,
      walletState: 'frozen',
      maxRateMinor: 100,
    });
    const belowMaxRateResponse = await unfreeze(belowMaxRate.clientId, staffId);
    expect(belowMaxRateResponse.statusCode).toBe(200);
    expect(belowMaxRateResponse.json().data.state).toBe('empty');
    expect((await walletAccount(pool, belowMaxRate.clientId)).state).toBe('empty');
  });
});
