import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupProbeClients } from '../../modules/instances/__tests__/instances-test-helpers.js';
import {
  makeClock,
  makeFakeSock,
  makeFakeTimerScheduler,
  pool,
  probeClientIds,
  seedProbe,
  buildRunner,
  type PublishMock,
} from './runner-test-support.js';

/**
 * runner.c2.teardown-race.test.ts (P08 FIX BATCH A, A4) - split out of
 * runner.c2.test.ts purely to keep that suite under max-lines. Proves
 * `teardown()`'s release guard: two teardown callers racing on the SAME
 * handle must release the lease at most once.
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('runner.c2 - concurrent teardown paths never double-release the lease', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('a_give_up_teardown_racing_a_pairing_exhaustion_teardown_releases_exactly_once', async () => {
    const { clientId, instanceId, fence } = await seedProbe({
      healthState: 'connected',
      linkState: 'linked',
    });
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet, leaseManager, registry } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    // FIX (A4): teardown() has no release guard, so two teardown callers
    // racing (e.g. a give-up branch's teardownWithRelease and a concurrent
    // registry-driven teardown for the SAME handle) could both reach
    // `leaseManager.release`. state.releasedLease is now set BEFORE the
    // await, so only the FIRST caller through actually releases.
    const handle = registry.get(instanceId);
    expect(handle).toBeDefined();

    await Promise.all([handle?.teardownWithRelease(), handle?.teardownWithRelease()]);

    expect(leaseManager.release as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });
});
