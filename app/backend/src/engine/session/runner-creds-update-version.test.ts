import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * runner-creds-update-version.test.ts (FIX-P26-G, round-2 review CRITICAL A)
 * - max-lines split off runner-creds-update.test.ts (established idiom -
 * `session-worker-discovery-wiring.ts`): proves `state.credVersion` is
 * actually advanced by BOTH the live `creds.update` save path and the
 * buffer's own flush-driven path, so the SECOND `creds.update` (and every
 * one after it) targets the correct `expectedVersion` instead of replaying
 * the same stale value forever (the defect the round-2 review found).
 */

afterAll(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  await pool.end();
});

type CredsSaveMock = ReturnType<
  typeof vi.fn<(args: unknown) => Promise<{ credVersion: bigint } | undefined>>
>;

function makeCredsSaveBuffer(overrides: { save?: CredsSaveMock } = {}) {
  return {
    save: overrides.save ?? (vi.fn().mockResolvedValue({ credVersion: 1n }) as CredsSaveMock),
    flush: vi.fn().mockResolvedValue({ applied: false, remaining: 0 }),
    unavailable: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  };
}

describe('createSessionRunner - creds.update version tracking (FIX-P26-G)', () => {
  let unhandled: unknown[];
  function onUnhandledRejection(err: unknown): void {
    unhandled.push(err);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    unhandled = [];
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  it('two creds.update events - second save gets expectedVersion 1n (not 0n), state.credVersion is 2n after both', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const save = vi
      .fn()
      .mockResolvedValueOnce({ credVersion: 1n })
      .mockResolvedValueOnce({ credVersion: 2n }) as CredsSaveMock;
    const credsSaveBuffer = makeCredsSaveBuffer({ save });
    const authStore = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
      currentCredVersion: vi.fn().mockResolvedValue(0n),
    };

    const { runner, instanceIdHolderSet, readCredVersion } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      authStore,
      credsSaveBuffer,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    await sock.ev.emit('creds.update', undefined);
    await sock.ev.emit('creds.update', undefined);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, {
      creds: expect.anything(),
      expectedVersion: 0n,
      fence,
    });
    expect(save).toHaveBeenNthCalledWith(2, {
      creds: expect.anything(),
      expectedVersion: 1n,
      fence,
    });
    expect(readCredVersion()).toBe(2n);
    expect(unhandled).toHaveLength(0);
  });

  it('a buffered entry (undefined resolve) does NOT advance state - the next save still replays the same expectedVersion', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined) as CredsSaveMock;
    const credsSaveBuffer = makeCredsSaveBuffer({ save });

    const { runner, instanceIdHolderSet, readCredVersion, flushCredVersion } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      credsSaveBuffer,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    await sock.ev.emit('creds.update', undefined);
    await sock.ev.emit('creds.update', undefined);

    expect(save).toHaveBeenNthCalledWith(1, {
      creds: expect.anything(),
      expectedVersion: 0n,
      fence,
    });
    expect(save).toHaveBeenNthCalledWith(2, {
      creds: expect.anything(),
      expectedVersion: 0n,
      fence,
    });
    expect(readCredVersion()).toBe(0n);

    // A later flush (e.g. the buffer's own retry timer) resolves the version
    // - simulating `CredsSaveBufferPorts.onFlushed` firing, exactly as
    // `session-worker-runner-factory.ts` wires it - which advances state.
    flushCredVersion(3n);
    expect(readCredVersion()).toBe(3n);
    expect(unhandled).toHaveLength(0);
  });

  it('a CredsSaveExhaustedError on the SECOND creds.update event still routes to exactly one teardown without release', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    class CredsSaveExhaustedErrorStub extends Error {
      constructor() {
        super('exhausted 3 version-conflict retries');
        this.name = 'CredsSaveExhaustedError';
      }
    }
    const save = vi
      .fn()
      .mockResolvedValueOnce({ credVersion: 1n })
      .mockRejectedValueOnce(new CredsSaveExhaustedErrorStub()) as CredsSaveMock;
    const credsSaveBuffer = makeCredsSaveBuffer({ save });

    const { runner, instanceIdHolderSet, leaseManager, registry } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      credsSaveBuffer,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    await sock.ev.emit('creds.update', undefined);
    await sock.ev.emit('creds.update', undefined);

    expect(save).toHaveBeenCalledTimes(2);
    expect(registry.get(instanceId)).toBeUndefined();
    expect(leaseManager.release).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });

  it('onOpen and creds.update interleaved - versions strictly increase across both paths', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const save = vi.fn().mockResolvedValueOnce({ credVersion: 2n }) as CredsSaveMock;
    const credsSaveBuffer = makeCredsSaveBuffer({ save });
    const authStore = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
      currentCredVersion: vi.fn().mockResolvedValue(0n),
    };

    const { runner, instanceIdHolderSet, readCredVersion } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
      authStore,
      credsSaveBuffer,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });
    // onOpen's own saveCreds (authStore.saveCreds) advances state 0n -> 1n.
    await sock.ev.emit('connection.update', { connection: 'open' });
    expect(readCredVersion()).toBe(1n);

    // creds.update's save (via the buffer) then targets 1n and advances to 2n.
    await sock.ev.emit('creds.update', undefined);
    expect(save).toHaveBeenCalledWith({ creds: expect.anything(), expectedVersion: 1n, fence });
    expect(readCredVersion()).toBe(2n);
    expect(unhandled).toHaveLength(0);
  });
});
