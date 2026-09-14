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
 * runner-creds-update.test.ts (FIX-A, P26 C1 review CRITICAL 1) - proves the
 * `creds.update` fail-safe boundary end-to-end through the real runner
 * wiring (a FakeSock emitting the real event, a fake `CredsSaveBufferPort`):
 * healthy save, a PG-unavailable-shaped resolve, a fence-conflict-class
 * error (warn only, no second teardown), an unknown error (exactly one
 * teardown without release), and the buffer's own `onError` port never
 * escaping as an unhandled rejection. No real Postgres save-buffer plumbing
 * here - see creds-save-buffer.test.ts for the buffer's own unit coverage.
 * `state.credVersion` advancing across multiple `creds.update` events (FIX-
 * P26-G, round-2 review CRITICAL A) is covered in the sibling
 * runner-creds-update-version.test.ts (max-lines split).
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

describe('createSessionRunner - creds.update fail-safe boundary', () => {
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

  it('healthy: exactly one saveCreds call via the buffer, correct expectedVersion, zero teardowns', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const credsSaveBuffer = makeCredsSaveBuffer();
    const authStore = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
      currentCredVersion: vi.fn().mockResolvedValue(0n),
    };

    const { runner, instanceIdHolderSet, registry } = buildRunner({
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

    expect(credsSaveBuffer.save).toHaveBeenCalledTimes(1);
    expect(credsSaveBuffer.save).toHaveBeenCalledWith({
      creds: expect.anything(),
      expectedVersion: 0n,
      fence,
    });
    expect(registry.get(instanceId)).toBeDefined();
    expect(unhandled).toHaveLength(0);
  });

  it('PG-unavailable-shaped save (resolves, per the buffer contract): no teardown, no unhandled rejection', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    // The buffer's OWN contract: a PG-unavailable save resolves (buffered),
    // never rejects - this proves the runner does not treat that as failure.
    const credsSaveBuffer = makeCredsSaveBuffer();

    const { runner, instanceIdHolderSet, registry } = buildRunner({
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

    expect(credsSaveBuffer.save).toHaveBeenCalledTimes(1);
    expect(registry.get(instanceId)).toBeDefined();
    expect(unhandled).toHaveLength(0);
  });

  it('FenceConflictError: warns, no second teardown, nothing escapes', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    class FenceConflictErrorStub extends Error {
      constructor() {
        super('fence conflict');
        this.name = 'FenceConflictError';
      }
    }
    const credsSaveBuffer = makeCredsSaveBuffer({
      save: vi.fn().mockRejectedValue(new FenceConflictErrorStub()),
    });

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

    // No second teardown: the runner's own handle is still registered (a
    // teardown, with or without release, always calls registry.delete).
    expect(registry.get(instanceId)).toBeDefined();
    expect(leaseManager.release).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });

  it('an unknown error: exactly one teardown without release', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const credsSaveBuffer = makeCredsSaveBuffer({
      save: vi.fn().mockRejectedValue(new Error('boom: decrypt failed')),
    });

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

    // teardown({ release: false }) never releases the lease, but DOES
    // deregister the handle - both assertions pin "exactly one teardown".
    expect(registry.get(instanceId)).toBeUndefined();
    expect(leaseManager.release).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });

  it("the buffer's onError port routes a fence-class error through warn-only, never a teardown loop or unhandled rejection", async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const credsSaveBuffer = makeCredsSaveBuffer();

    const { runner, instanceIdHolderSet, getOnCredsSaveBufferError, registry } = buildRunner({
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

    class StoreFencedErrorStub extends Error {
      constructor() {
        super('store fenced');
        this.name = 'StoreFencedError';
      }
    }
    getOnCredsSaveBufferError()?.(new StoreFencedErrorStub());
    await Promise.resolve();

    expect(registry.get(instanceId)).toBeDefined();
    expect(unhandled).toHaveLength(0);
  });

  it("the buffer's onError port routes an unknown error to exactly one teardown without release", async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();
    const credsSaveBuffer = makeCredsSaveBuffer();

    const { runner, instanceIdHolderSet, getOnCredsSaveBufferError, leaseManager, registry } =
      buildRunner({
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

    getOnCredsSaveBufferError()?.(new Error('CredsSaveExhaustedError: exhausted retries'));
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.get(instanceId)).toBeUndefined();
    expect(leaseManager.release).not.toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
  });

  it('no credsSaveBuffer supplied: no creds.update listener is registered (fail-safe default)', async () => {
    const { clientId, instanceId, fence } = await seedProbe();
    const sock = makeFakeSock();
    const clock = makeClock(1_000);
    const scheduler = makeFakeTimerScheduler();
    const publish: PublishMock = vi.fn();

    const { runner, instanceIdHolderSet } = buildRunner({
      sock,
      fence,
      clock,
      scheduler,
      clientId,
      publish,
    });
    instanceIdHolderSet(instanceId);

    await runner.start({ instanceId, clientId, method: 'qr' });

    await expect(sock.ev.emit('creds.update', undefined)).rejects.toThrow(/no handler registered/);
  });
});
