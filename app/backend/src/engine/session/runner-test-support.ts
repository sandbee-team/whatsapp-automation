import { vi } from 'vitest';
import { ctxFor } from '../../modules/instances/__tests__/instances-test-helpers.js';
import * as instancesRepo from '../../modules/instances/repo.js';
import type { InstanceServiceDeps } from '../../modules/instances/service.js';
import { resolveDisconnect } from '../../provider/baileys/disconnect-map.js';
import { toFsmRow } from './to-fsm-row.js';
import { createSessionRunner } from './runner.js';
import { createSessionRegistry, createSessionOwner } from './registry.js';
import { createPairingController } from './pairing.js';
import { buildInstancesAdapter } from './runner-test-instances-adapter.js';
import type { SessionLease } from '../lease/lease-manager.js';
import { release as pgReleaseLease } from '../lease/lease-state-repo.js';
import {
  pool,
  makeClock,
  type FakeSock,
  type FakeTimerScheduler,
  type PublishMock,
} from './runner-test-fixtures.js';

/**
 * runner-test-support.ts (P08 U5a) - `buildRunner`, the shared runner-
 * composition helper for runner.test.ts/runner-reconnect.test.ts and every
 * other runner-level test file. Real Postgres for every instance/creds write
 * (through the landed U4 repo/service and a FAKE auth store standing in for
 * the real P07 store). Only the runner's OWN orchestration (event wiring,
 * pairing accounting, disconnect mapping, reconnect scheduling) is under
 * test here. The fake-socket/fake-clock/fake-scheduler/seed primitives live
 * in the sibling runner-test-fixtures.ts (split to stay under max-lines) -
 * re-exported below so existing imports of this module keep working.
 */

export {
  pool,
  probeClientIds,
  makeFakeSock,
  makeClock,
  makeFakeTimerScheduler,
  seedProbe,
  type FakeSock,
  type FakeTimerScheduler,
  type PublishedEvent,
  type PublishMock,
} from './runner-test-fixtures.js';

export interface BuildRunnerOptions {
  sock: FakeSock;
  fence: bigint;
  clock: ReturnType<typeof makeClock>;
  scheduler: FakeTimerScheduler;
  clientId: string;
  publish: PublishMock;
  /** Pairing controller's `instanceId` (U5b fix - real hub needs a real UUID); optional, defaults `''`. */
  instanceId?: string;
  /** P09 fleet-recovery FIX test seam - the fake `leaseManager.acquire`'s returned `SessionLease.graceMs`. Defaults to `0` (no deferred wait), matching every pre-existing test's expectation of an immediate socket open. */
  graceMs?: number;
  authStore?: {
    loadCreds: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    saveCreds: ReturnType<typeof vi.fn<(args: unknown) => Promise<{ credVersion: bigint }>>>;
    currentCredVersion?: ReturnType<typeof vi.fn<() => Promise<bigint>>>;
  };
  /** FIX-A (P26 C1 review) test seam - when supplied, `buildAuthStore`'s result includes this fake `CredsSaveBufferPort`, exactly like the real `session-worker-runner-factory.ts` wiring does when a store is built. Omitted by default (no `creds.update` listener registered), matching every pre-existing test's expectation. FIX-P26-G: `save`/`flush` widened to resolve `{ credVersion }` - see `CredsSaveBufferPort`'s own doc comment. */
  credsSaveBuffer?: {
    save: ReturnType<typeof vi.fn<(args: unknown) => Promise<{ credVersion: bigint } | undefined>>>;
    flush: ReturnType<
      typeof vi.fn<() => Promise<{ applied: boolean; remaining: number; credVersion?: bigint }>>
    >;
    unavailable: ReturnType<typeof vi.fn<() => boolean>>;
    dispose: ReturnType<typeof vi.fn<() => void>>;
  };
  expectedTakeoverCheck?: ReturnType<
    typeof vi.fn<(instanceId: string, clientId: string, myFence: bigint) => Promise<boolean>>
  >;
  reconnect?: {
    nextDelayMs: ReturnType<
      typeof vi.fn<
        (input: {
          attempt: number;
          instanceId: string;
          rng: { random(): number };
          baseMultiplier?: number;
        }) => number
      >
    >;
    shouldGiveUp: ReturnType<typeof vi.fn<(attempt: number) => boolean>>;
    onOpen: ReturnType<
      typeof vi.fn<(input: { openedAtMs: number; closedAtMs: number; attempt: number }) => number>
    >;
  };
  /** CRITICAL 3 pinning test seam - overrides the default always-resolves-instantly fake connect gate, so a test can park `take()` and assert it is aborted by teardown/drain. Defaults to `{ take: vi.fn().mockResolvedValue(undefined) }`, matching every pre-existing test's expectation of an immediate connect-gate grant. */
  connectGate?: { take: (options?: { signal?: AbortSignal }) => Promise<void> };
  /** P12 U3 test seam - threaded straight into `CreateSessionRunnerDeps.onMessagesUpsert`. Omitted (undefined) by default, matching every pre-existing test's expectation that no `messages.upsert` listener is registered. */
  onMessagesUpsert?: (payload: unknown) => void;
  /** P21 U6b test seam - threaded straight into `CreateSessionRunnerDeps.onMessagesUpdate`. Omitted by default. */
  onMessagesUpdate?: (payload: unknown) => void;
  /** P21 U6b test seam - threaded straight into `CreateSessionRunnerDeps.onMessageReceiptUpdate`. Omitted by default. */
  onMessageReceiptUpdate?: (payload: unknown) => void;
}

export interface BuiltRunner {
  runner: ReturnType<typeof createSessionRunner>;
  instanceIdHolderSet: (id: string) => void;
  leaseManager: { acquire: unknown; release: unknown };
  heartbeat: { add: unknown; remove: unknown };
  registry: ReturnType<typeof createSessionRegistry>;
  /** Exposed so a test can assert whether a reconnect actually rebuilt the socket. */
  socketFactory: ReturnType<typeof vi.fn<() => FakeSock>>;
  /** FIX-A (P26 C1 review) test seam - see its own doc comment at the return site. */
  getOnCredsSaveBufferError: () => ((err: unknown) => void) | undefined;
  /** FIX-P26-G test seam - the `readCredVersion`/`onCredsSaveBufferFlushed` ports captured from `buildAuthStore`, so a test can simulate a retry-timer-driven flush advancing state directly (mirroring `session-worker-runner-factory.ts`'s real wiring) without a real `CredsSaveBuffer`. */
  readCredVersion: () => bigint;
  flushCredVersion: (credVersion: bigint) => void;
}

export function buildRunner(options: BuildRunnerOptions): BuiltRunner {
  const registry = createSessionRegistry();
  const sessionOwner = createSessionOwner(registry);
  const ctx = ctxFor(pool, options.clientId);
  const auditSql = pool as unknown as InstanceServiceDeps['auditSql'];
  const serviceDeps: InstanceServiceDeps = { ctx, auditSql };

  const lease: SessionLease = {
    instanceId: '',
    clientId: options.clientId,
    fence: options.fence,
    workerId: 'worker-runner-test',
    graceMs: options.graceMs ?? 0,
  };

  const leaseManager = {
    acquire: vi.fn(async (input: { instanceId: string; clientId: string }) => ({
      ...lease,
      instanceId: input.instanceId,
    })),
    // Backed by the REAL fence-guarded Postgres release statement (not a
    // bare stub) so `instance_lease_state.released_at` genuinely lands -
    // the named test `sixth_qr_attempt_...` asserts this row directly. No
    // Redis leg here (this dispatch's lease manager is otherwise faked;
    // U5b is where a real Redis-backed LeaseManager gets proven).
    release: vi.fn(async (released: SessionLease) => {
      await pgReleaseLease(ctx, {
        instanceId: released.instanceId,
        fence: released.fence,
        workerId: released.workerId,
      });
    }),
  };

  const heartbeat = { add: vi.fn(), remove: vi.fn() };

  const authStore: NonNullable<BuildRunnerOptions['authStore']> = options.authStore ?? {
    loadCreds: vi.fn().mockResolvedValue(null),
    saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
  };

  let onCredsSaveBufferErrorCapture: ((err: unknown) => void) | undefined;
  let readCredVersionCapture: (() => bigint) | undefined;
  let onCredsSaveBufferFlushedCapture: ((credVersion: bigint) => void) | undefined;
  const buildAuthStore = vi.fn(
    (
      _identity: unknown,
      ports: {
        onCredsSaveBufferError(err: unknown): void;
        readCredVersion(): bigint;
        onCredsSaveBufferFlushed(credVersion: bigint): void;
      },
    ) => {
      onCredsSaveBufferErrorCapture = ports.onCredsSaveBufferError;
      readCredVersionCapture = ports.readCredVersion;
      onCredsSaveBufferFlushedCapture = ports.onCredsSaveBufferFlushed;
      return {
        store: {
          loadCreds: authStore.loadCreds,
          saveCreds: authStore.saveCreds,
          currentCredVersion: authStore.currentCredVersion,
          getKeys: vi.fn(),
          setKeys: vi.fn(),
          purge: vi.fn().mockResolvedValue({ purged: true }),
          asSignalKeyStore: vi.fn(),
        },
        signalKeyStore: {},
        credsSaveBuffer: options.credsSaveBuffer,
      };
    },
  );

  const socketFactory = vi.fn(() => options.sock);

  let instanceIdHolder = '';
  function currentInstanceId(): string {
    return instanceIdHolder;
  }

  const pairing = createPairingController({
    repoCtx: {
      incrementQrAttempts: async () => {
        const result = await instancesRepo.incrementQrAttempts(ctx, {
          instanceId: currentInstanceId(),
          fence: options.fence,
          workerId: 'worker-runner-test',
        });
        return { qr_attempts: result.qrAttempts, pairing_started_at: result.pairingStartedAt };
      },
      markPairingExpired: () =>
        instancesRepo.markPairingExpired(ctx, {
          instanceId: currentInstanceId(),
          fence: options.fence,
          workerId: 'worker-runner-test',
        }),
    },
    publish: (event) => options.publish(event),
    clock: options.clock,
    clientId: options.clientId,
    instanceId: options.instanceId ?? '',
  });

  const instances = buildInstancesAdapter({
    ctx,
    serviceDeps,
    currentFence: () => options.fence,
    workerId: 'worker-runner-test',
    currentInstanceId,
  });

  const runner = createSessionRunner({
    leaseManager,
    heartbeat,
    buildAuthStore,
    socketFactory,
    instances,
    pairing,
    connectGate: options.connectGate ?? { take: vi.fn().mockResolvedValue(undefined) },
    publish: options.publish,
    resolveDisconnect,
    toFsmRow,
    reconnect: options.reconnect ?? {
      nextDelayMs: vi.fn().mockReturnValue(1234),
      shouldGiveUp: vi.fn().mockReturnValue(false),
      onOpen: vi.fn().mockReturnValue(0),
    },
    rng: { random: () => 0.5 },
    clock: options.clock,
    setTimeoutFn: options.scheduler.setTimeoutFn,
    clearTimeoutFn: (handle: unknown) => options.scheduler.clearTimeoutFn(handle as number),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    workerId: 'worker-runner-test',
    env: 'test',
    expectedTakeoverCheck: options.expectedTakeoverCheck ?? vi.fn().mockResolvedValue(false),
    registry,
    sessionOwner,
    onMessagesUpsert: options.onMessagesUpsert,
    onMessagesUpdate: options.onMessagesUpdate,
    onMessageReceiptUpdate: options.onMessageReceiptUpdate,
  });

  return {
    runner,
    instanceIdHolderSet: (id: string) => (instanceIdHolder = id),
    leaseManager,
    heartbeat,
    registry,
    socketFactory,
    // FIX-A (P26 C1 review) test seam - the captured `onCredsSaveBufferError`
    // port `buildAuthStore` received, so a test can simulate the buffer's own
    // retry-timer firing without a real timer/buffer.
    getOnCredsSaveBufferError: () => onCredsSaveBufferErrorCapture,
    // FIX-P26-G test seams - see BuiltRunner's own doc comment.
    readCredVersion: () => {
      if (!readCredVersionCapture) throw new Error('readCredVersion not captured');
      return readCredVersionCapture();
    },
    flushCredVersion: (credVersion: bigint) => onCredsSaveBufferFlushedCapture?.(credVersion),
  };
}
