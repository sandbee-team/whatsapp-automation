// NOTE: the `WP_*` test env is now supplied by `packages/config/vitest-setup-env.ts`,
// wired as `setupFiles` in `vitest.base.ts`, so it is applied before ANY test
// module is imported in every project. The per-file first-import of
// `__test-support__/stub-wp-server-kit-env.js` (still used by ~10 siblings under
// engine/fleet/) is therefore no longer load-bearing here. Deliberately omitted
// as the live proof that the setupFile carries this on its own.
import { describe, expect, it, vi } from 'vitest';

/**
 * session-worker-runner-factory.config-threading.test.ts (P10 U5-followup) -
 * proves the two Signal-cap config values
 * (`config.SIGNAL_KEYSTORE_MAX_RECORDS`, `config.REDIS_SIG_MAX_FIELDS_PER_INSTANCE`)
 * actually reach the store constructors `buildSessionRunnerFor` calls,
 * rather than silently falling back to the hardcoded 4000 default inside
 * `store.ts`/`redis-repo.ts`.
 *
 * `createSignalRedisRepo` IS invoked eagerly at BUILD time (before any lease/
 * socket) - asserted via a direct spy on the real module.
 *
 * `createEncryptedAuthStore` is only invoked LAZILY, inside the
 * `buildAuthStore` closure `runner.ts#start()` calls after a real lease is
 * acquired - reaching that live path here would need real Postgres/a live
 * socket for a config-threading question fully decided at BUILD time. This
 * test instead spies on `createSessionRunner` (the factory's one call site
 * for that closure), captures the `buildAuthStore` fn it was handed, and
 * invokes it directly with a minimal identity/ports - proving exactly what
 * reaches `createEncryptedAuthStore` without paying for a live lease/socket.
 */

const createSignalRedisRepoMock = vi.fn();

vi.mock('../../provider/baileys/auth-state/redis-repo.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../provider/baileys/auth-state/redis-repo.js')>();
  return {
    ...actual,
    createSignalRedisRepo: (
      ...args: Parameters<typeof actual.createSignalRedisRepo>
    ): ReturnType<typeof actual.createSignalRedisRepo> => {
      createSignalRedisRepoMock(...args);
      return actual.createSignalRedisRepo(...args);
    },
  };
});

const createSessionRunnerMock = vi.fn();

vi.mock('./runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runner.js')>();
  return {
    ...actual,
    createSessionRunner: (
      ...args: Parameters<typeof actual.createSessionRunner>
    ): ReturnType<typeof actual.createSessionRunner> => {
      createSessionRunnerMock(...args);
      return actual.createSessionRunner(...args);
    },
  };
});

const { buildSessionRunnerFor } = await import('./session-worker-runner-factory.js');
const { createEncryptedAuthStore } = await import('../../provider/baileys/auth-state/store.js');
const { bindSignalMetrics } = await import('../../platform/metrics/signal-metrics.js');
const { createMetricsRegistry } = await import('@wp/server-kit');

vi.mock('../../provider/baileys/auth-state/store.js', () => ({
  createEncryptedAuthStore: vi.fn(() => ({
    loadCreds: vi.fn(),
    saveCreds: vi.fn(),
    getKeys: vi.fn(),
    setKeys: vi.fn(),
    purge: vi.fn(),
    asSignalKeyStore: vi.fn(() => ({})),
  })),
}));

const createEncryptedAuthStoreMock = vi.mocked(createEncryptedAuthStore);

function fakeRedis(): unknown {
  return { defineCommand: vi.fn() };
}

function buildOptionsWith(overrides: {
  signalKeystoreMaxRecords?: number;
  maxFieldsPerInstance?: number;
}): Parameters<typeof buildSessionRunnerFor>[0] {
  const signalMetrics = bindSignalMetrics(createMetricsRegistry());

  return {
    instanceId: 'instance-config-threading',
    clientId: 'client-config-threading',
    env: 'test',
    workerId: 'worker-config-threading',
    pool: {} as never,
    tenantDb: { withTenant: vi.fn() } as never,
    redisSig: fakeRedis() as never,
    redisCache: fakeRedis() as never,
    provider: {} as never,
    encVersion: 1,
    signalMetrics,
    leaseManager: {} as never,
    heartbeat: {} as never,
    registry: { has: vi.fn(() => false) } as never,
    sessionOwner: {} as never,
    connectGate: {} as never,
    publish: vi.fn() as never,
    socketFactory: vi.fn() as never,
    currentFence: () => 0n,
    ...overrides,
  } as unknown as Parameters<typeof buildSessionRunnerFor>[0];
}

describe('buildSessionRunnerFor - Signal-cap config threading (P10 U5-followup)', () => {
  it('signal_keystore_max_records_reaches_the_bounded_store_from_config', () => {
    createEncryptedAuthStoreMock.mockClear();
    createSessionRunnerMock.mockClear();

    buildSessionRunnerFor(buildOptionsWith({ signalKeystoreMaxRecords: 777 }));

    expect(createSessionRunnerMock).toHaveBeenCalledTimes(1);
    const [runnerDeps] = createSessionRunnerMock.mock.calls[0] as [
      { buildAuthStore: (identity: unknown, ports: unknown) => unknown },
    ];

    // Invoke the captured closure directly - never through a real start()/
    // live lease/socket - to observe exactly what it hands
    // createEncryptedAuthStore.
    runnerDeps.buildAuthStore(
      {
        instanceId: 'i',
        clientId: 'c',
        sessionEpoch: 0,
        fence: 0n,
        env: 'test',
        workerId: 'w',
      },
      {
        onFenceConflict: vi.fn(),
        onSignalWriteFailure: vi.fn(),
        releaseLease: vi.fn(),
      },
    );

    expect(createEncryptedAuthStoreMock).toHaveBeenCalledTimes(1);
    const [deps] = createEncryptedAuthStoreMock.mock.calls[0] as [
      { signalKeystoreMaxRecords?: number },
    ];
    expect(deps.signalKeystoreMaxRecords).toBe(777);
  });

  it('redis_sig_max_fields_per_instance_reaches_the_signal_redis_repo_from_config', () => {
    createSignalRedisRepoMock.mockClear();

    buildSessionRunnerFor(buildOptionsWith({ maxFieldsPerInstance: 777 }));

    expect(createSignalRedisRepoMock).toHaveBeenCalledTimes(1);
    const [deps] = createSignalRedisRepoMock.mock.calls[0] as [{ maxFieldsPerInstance?: number }];
    expect(deps.maxFieldsPerInstance).toBe(777);
  });
});
