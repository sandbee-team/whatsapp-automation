import type { Redis } from 'ioredis';
import { nextDelayMs, shouldGiveUp, onOpen } from '@wp/domain';
import { createPool, type TenantDb } from '@wp/db';
import { logger, describeError, type WpLogger } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { createAuthCodec } from '../../provider/baileys/auth-state/codec.js';
import { createSignalRedisRepo } from '../../provider/baileys/auth-state/redis-repo.js';
import { createEncryptedAuthStore } from '../../provider/baileys/auth-state/store.js';
import { createCredsSaveBuffer } from '../../provider/baileys/auth-state/creds-save-buffer.js';
import { isPgUnavailableError } from '../../provider/baileys/auth-state/pg-unavailable.js';
import { recordCredsSaveBufferEvent } from './metrics.js';
import type { SignalMetricsHandles } from '../../platform/metrics/signal-metrics.js';
import { resolveDisconnect } from '../../provider/baileys/disconnect-map.js';
import type { SocketFactoryLogger } from '../../provider/baileys/socket-factory.js';
import * as instancesRepo from '../../modules/instances/repo.js';
import type { InstanceCtx } from '../../modules/instances/repo.js';
import type { InstanceServiceDeps } from '../../modules/instances/service.js';
import type { LeaseManager } from '../lease/lease-manager.js';
import type { LeaseHeartbeat } from '../lease/heartbeat.js';
import type { SessionRunnerRegistry } from './registry.js';
import type { SessionOwner } from '../lease/session-owner.port.js';
import { createPairingController } from './pairing.js';
import type { ConnectGate } from './connect-gate.js';
import { createSessionRunner } from './runner.js';
import { buildInstancesAdapter } from './runner-test-instances-adapter.js';
import { buildPerQueryTenantSql } from './per-query-tenant-sql.js';
import { toFsmRow } from './to-fsm-row.js';
import { buildExpectedTakeoverCheck } from './expected-takeover-check.js';
import type { FakeableSocket, RunnerPublish } from './runner-types.js';
import { onConnectionUpdate as fastLaneOnConnectionUpdate } from '../../modules/pacing/health/fast-lane.js';
import type { FastLaneCtx } from '../../modules/pacing/health/fast-lane.js';
import { runEpochStrandingSweep } from '../../modules/broadcasts/index.js';

/**
 * session-worker-runner-factory.ts (P08 U6b PART 1) - `buildSessionRunnerFor`,
 * the per-instance runner composition `session-worker-composition.ts`'s
 * bootstrap-scan loop calls for every newly-discovered instance.
 */

/**
 * A minimal warn-level, pino-shaped adapter over `@wp/server-kit`'s shared
 * `logger`, because `socket-factory.ts` needs pino's `.child()`/per-level
 * shape that the deliberately narrow `WpLogger` does not provide.
 *
 * Every level routes through `WpLogger`'s sanitizing `warn`/`error` with an
 * ALWAYS-EMPTY fields object: a raw Baileys log object may carry a QR string
 * or auth blob, so nothing from `obj` is ever forwarded.
 */
export function socketFactoryLoggerFrom(base: WpLogger): SocketFactoryLogger {
  function build(): SocketFactoryLogger {
    return {
      level: 'warn',
      child: () => build(),
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => base.warn({}, 'baileys'),
      error: () => base.error({}, 'baileys'),
    };
  }
  return build();
}

const reconnectPort = { nextDelayMs, shouldGiveUp, onOpen };

export interface BuildSessionRunnerForOptions {
  instanceId: string;
  clientId: string;
  env: string;
  workerId: string;
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redisSig: Redis;
  redisCache: Redis;
  provider: KeyProvider;
  encVersion: number;
  signalMetrics: SignalMetricsHandles;
  leaseManager: LeaseManager;
  heartbeat: LeaseHeartbeat;
  registry: SessionRunnerRegistry;
  sessionOwner: SessionOwner;
  connectGate: ConnectGate;
  publish: RunnerPublish;
  socketFactory: (auth: { creds: unknown; keys: unknown }) => FakeableSocket;
  /** Reads the CURRENT fence this worker holds for `instanceId` - engine writes made after `start()` need the live value, not a snapshot at build time. */
  currentFence: (instanceId: string) => bigint;
  /**
   * P10 U5-followup: `config.SIGNAL_KEYSTORE_MAX_RECORDS`, threaded through
   * to `createEncryptedAuthStore`'s `asSignalKeyStore()` bound
   * (`makeBoundedSignalKeyStore`'s `maxEntries`). Optional - `store.ts`'s own
   * deps-absent fallback (the domain-constant default) still applies when
   * omitted, so a caller that predates this option keeps working unchanged
   * (fail-safe: a missing value never crashes the worker boot).
   */
  signalKeystoreMaxRecords?: number;
  /**
   * P10 U5-followup: `config.REDIS_SIG_MAX_FIELDS_PER_INSTANCE`, threaded
   * through to `createSignalRedisRepo`'s per-instance field-cap guard.
   * Optional - `redis-repo.ts`'s own deps-absent fallback (4000, matching
   * config's default) still applies when omitted.
   */
  maxFieldsPerInstance?: number;
  /** P12 U3 - passed straight through to `createSessionRunner`'s `CreateSessionRunnerDeps.onMessagesUpsert`. Optional; omitted means no `messages.upsert` listener is registered (see that field's own doc for the fail-safe default). */
  onMessagesUpsert?: (payload: unknown) => void;
  /** P21 U6b - passed straight through to `CreateSessionRunnerDeps.onMessagesUpdate`. Optional; same fail-safe default. */
  onMessagesUpdate?: (payload: unknown) => void;
  /** P21 U6b - passed straight through to `CreateSessionRunnerDeps.onMessageReceiptUpdate`. Optional; same fail-safe default. */
  onMessageReceiptUpdate?: (payload: unknown) => void;
}

/** Builds ONE runner bound to `(instanceId, clientId)` - a fresh pairing/instances-adapter/authStore closure per session. */
export function buildSessionRunnerFor(options: BuildSessionRunnerForOptions) {
  const {
    instanceId,
    clientId,
    env,
    workerId,
    pool,
    tenantDb,
    redisSig,
    redisCache,
    provider,
    encVersion,
    signalMetrics,
    leaseManager,
    heartbeat,
    registry,
    sessionOwner,
    connectGate,
    publish,
    socketFactory,
    currentFence,
    signalKeystoreMaxRecords,
    maxFieldsPerInstance,
    onMessagesUpsert,
    onMessagesUpdate,
    onMessageReceiptUpdate,
  } = options;

  // 2026-09-14 RLS FIX: these were a BARE POOL, which under the real
  // `wp_scheduler` role reads zero rows and fails audit INSERTs outright.
  const perQueryTenantSql = buildPerQueryTenantSql(tenantDb, clientId);
  const ctx: InstanceCtx = {
    clientId,
    sql: perQueryTenantSql as unknown as InstanceCtx['sql'],
  };
  const auditSql = perQueryTenantSql as unknown as InstanceServiceDeps['auditSql'];
  const serviceDeps: InstanceServiceDeps = { ctx, auditSql };
  const codec = createAuthCodec({ provider, encVersion });
  const redisRepo = createSignalRedisRepo({
    redisSig,
    redisCache,
    env,
    maxFieldsPerInstance,
    fieldCapMetrics: {
      incrementRedisSigFieldEvicted: signalMetrics.incrementRedisSigFieldEvicted,
      incrementRedisSigFieldCapReached: signalMetrics.incrementRedisSigFieldCapReached,
    },
    logger,
  });

  const pairing = createPairingController({
    repoCtx: {
      incrementQrAttempts: async () => {
        const result = await instancesRepo.incrementQrAttempts(ctx, {
          instanceId,
          fence: currentFence(instanceId),
          workerId,
        });
        return {
          qr_attempts: result.qrAttempts,
          pairing_started_at: result.pairingStartedAt,
        };
      },
      markPairingExpired: () =>
        instancesRepo.markPairingExpired(ctx, {
          instanceId,
          fence: currentFence(instanceId),
          workerId,
        }),
    },
    publish,
    clock: { now: () => Date.now() },
    clientId,
    instanceId,
  });

  const instances = buildInstancesAdapter({
    ctx,
    serviceDeps,
    currentFence: () => currentFence(instanceId),
    workerId,
    currentInstanceId: () => instanceId,
  });

  const socketFactoryLogger = socketFactoryLoggerFrom(logger);
  void socketFactoryLogger; // wired into the REAL createBaileysSocket by roles/session-worker.ts's socketFactory closure, not here (this factory takes an already-built socketFactory).

  return createSessionRunner({
    leaseManager,
    heartbeat,
    buildAuthStore: (identity, ports) => {
      const store = createEncryptedAuthStore({
        db: pool as unknown as Parameters<typeof createEncryptedAuthStore>[0]['db'],
        redisRepo,
        codec,
        identity,
        ports,
        metrics: signalMetrics,
        signalKeystoreMaxRecords,
        // P23 Unit U6 (step 7) - the epoch-stranding sweep's primary
        // detector, fired after `purge`'s real epoch-bump COMMIT (never
        // before, never on a benign-replay no-op). Belt-and-braces: the
        // periodic fleet-wide reconciliation sweep (engine/cron/
        // cron-wiring-epoch.ts) catches anything this hook misses to a crash.
        onEpochAdvanced: async (info) => {
          await runEpochStrandingSweep({ tenantDb }, { ...info, currentEpoch: info.sessionEpoch });
        },
      });
      // P26 U6a - one CredsSaveBuffer bound to THIS store instance, real
      // setTimeout (unref'd - never keeps the process alive on its own).
      const credsSaveBuffer = createCredsSaveBuffer({
        // FIX-P26-G (round-2 review CRITICAL A): `store.saveCreds` resolves
        // `{ credVersion }` - passed straight through so the runner can
        // advance `state.credVersion` instead of it being discarded here.
        saveCreds: (args) => store.saveCreds(args),
        isPgUnavailable: isPgUnavailableError,
        now: () => Date.now(),
        schedule: (fn, ms) => {
          const timer = setTimeout(fn, ms);
          timer.unref?.();
          return { cancel: () => clearTimeout(timer) };
        },
        onEvent: (e) => recordCredsSaveBufferEvent(e.kind),
        // FIX-A (P26 C1 review, CRITICAL 1) - the retry timer's scheduled
        // `flush()` has no caller to propagate a rejection to; without this,
        // a fence conflict discovered by the timer becomes an unhandled
        // rejection that kills the whole worker process.
        onError: (err) => ports.onCredsSaveBufferError(err),
        // FIX-P26-G - resolves the LIVE `state.credVersion` at flush time
        // (never the stale value captured when the entry was buffered), and
        // advances it back after a retry-timer-driven flush applies.
        readExpectedVersion: () => ports.readCredVersion(),
        onFlushed: (credVersion) => ports.onCredsSaveBufferFlushed(credVersion),
      });
      return { store, signalKeyStore: store.asSignalKeyStore(), credsSaveBuffer };
    },
    socketFactory,
    instances,
    pairing,
    connectGate,
    publish,
    resolveDisconnect,
    toFsmRow,
    reconnect: reconnectPort,
    rng: { random: () => Math.random() },
    clock: { now: () => Date.now() },
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    logger: {
      info: () => undefined,
      warn: (msg) => logger.warn({}, msg),
      error: (msg) => logger.error({}, msg),
    },
    workerId,
    env,
    // Real predicate (P09 U6 step 9, carried-forward P08 handoff) - backed
    // by `instance_lease_state`; see expected-takeover-check.ts's own doc
    // comment for the exact rule (blueprint [R-13w]). A query error is
    // caught inside buildExpectedTakeoverCheck itself and resolves `false`
    // (fail-safe: never assume a takeover was expected on an unclear read).
    expectedTakeoverCheck: buildExpectedTakeoverCheck({
      withTenant: (cid, fn) => tenantDb.withTenant(cid, fn),
      onError: (err) => {
        logger.warn(
          {},
          `expectedTakeoverCheck query failed, treating as unexpected: ${describeError(err)}`,
        );
      },
    }),
    registry,
    sessionOwner,
    onMessagesUpsert,
    onMessagesUpdate,
    onMessageReceiptUpdate,
    // P16 Unit C - the fast-lane hook (see runner-types.ts's own doc): runs
    // in its OWN tenantDb.withTenant transaction, after the FSM's own write
    // has already committed (runner-disconnect.ts calls this AFTER
    // applyEngineTransition, and catches/logs any rejection itself).
    onConnectionUpdate: ({ instanceId: hookInstanceId, clientId: hookClientId, disconnectCode }) =>
      tenantDb.withTenant(hookClientId, async (tx) => {
        const ctx: FastLaneCtx = {
          sql: tx,
          clientId: hookClientId,
          clock: { now: () => Date.now() },
        };
        await fastLaneOnConnectionUpdate(ctx, { instanceId: hookInstanceId, disconnectCode });
      }),
  });
}
