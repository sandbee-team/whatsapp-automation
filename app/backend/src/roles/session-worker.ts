import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { logger } from '@wp/server-kit';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { TIMING } from '@wp/domain';
import { loadConfig } from '../platform/config.js';
import {
  createRedis,
  resolveRedisUrl,
  resolveSigRedisUrl,
  resolveCacheRedisUrl,
} from '../platform/redis.js';
import { assertDbPreconditionsOrExit } from '../platform/db/assert-db-preconditions.js';
import { assertSignalKeyspacePolicy } from '../platform/redis-assertions.js';
import { createBaileysSocket } from '../provider/baileys/socket-factory.js';
import { createSessionWorker } from '../engine/session/session-worker-composition.js';
import { socketFactoryLoggerFrom } from '../engine/session/session-worker-runner-factory.js';
import { bootWorkerBudget } from '../engine/fleet/fleet-wiring.js';
import { buildSessionWorkerDrain } from '../engine/session/session-worker-drain-wiring.js';
import { createRedisRealtimePublisher } from '../modules/realtime/redis-bridge.js';
import { writeQrCache } from '../engine/session/qr-cache.js';
import { SessionRssRingBuffer, estimateSessionRssSlopeBytes } from '../engine/fleet/sampler.js';
import { buildSessionCostFeedbackTimer } from '../engine/fleet/session-cost-feedback-timer.js';
import { buildGroupsSyncTimer } from '../engine/session/session-groups-sync-timer.js';
import { bindQueueMetrics } from '../engine/queue/metrics.js';
import { bootSendLoopFleetWiring } from '../engine/queue/send-loop-worker-wiring.js';
import { bootHealthEvaluatorLoop } from '../engine/session/session-worker-health-loop-wiring.js';
import { startMetricsServer, type MetricsServerHandle } from '../platform/metrics/server.js';
import { bootDiscoveryScanScheduler } from './session-worker-discovery-wake-wiring.js';

/**
 * ROLE=session-worker entrypoint - opens Baileys sockets, drives
 * `engine/session/**`, `engine/fleet/**`, the per-instance send loop
 * `engine/queue/**`, the health-evaluator due-scan sweep, and the groups
 * sync/leave timer. NEVER serves HTTP, NEVER imports `platform/http/**`.
 * Boot order (mirrors `roles/api.ts`): loadConfig -> validate DATABASE_URL/
 * REDIS_URL -> createPool -> assertDbPreconditionsOrExit -> connect redis* ->
 * assertSignalKeyspacePolicy -> bootWorkerBudget -> compose `SessionWorker`
 * -> boot the send-loop/health-evaluator/groups-sync wirings -> start the
 * metrics listener (P25 U2) -> start the discovery scan scheduler (5000ms
 * +/- 2000ms jittered poll, PLUS a fleet-wide pub/sub wake as of 2026-09-17 -
 * see `session-worker-discovery-wake-wiring.ts`'s own doc comment) ->
 * register SIGTERM/SIGINT ONCE -> `createDrain`. Composition lives in
 * `engine/session/session-worker-composition.ts`, outside `roles/`.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to boot the session-worker role.');
  }
  if (!config.REDIS_URL) {
    throw new Error('REDIS_URL is required to boot the session-worker role.');
  }

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'wp-session-worker',
    connectionTimeoutMillis: TIMING.pgConnectTimeoutMs,
    statementTimeoutMs: TIMING.pgStatementTimeoutMs,
  });

  // Refuses to boot while any live instance lacks a provisioned instance_pacing_state row.
  const exitOnPreconditionFailure = (code: number): void => {
    process.exitCode = code;
  };
  const ok = await assertDbPreconditionsOrExit(pool, exitOnPreconditionFailure, {
    checkPacingStateProvisioned: true,
  });
  if (!ok) {
    return;
  }

  const redisCtl = createRedis(resolveRedisUrl());
  const redisSig = createRedis(resolveSigRedisUrl());
  const redisCache = createRedis(resolveCacheRedisUrl());

  try {
    await assertSignalKeyspacePolicy(redisSig);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${name}: ${message}`);
    await pool.end();
    redisCtl.disconnect();
    redisSig.disconnect();
    redisCache.disconnect();
    process.exitCode = 1;
    return;
  }

  // Boot-time fleet budget assertion (core invariant 2, fail-safe): refuses
  // to start rather than derive a session cap this process cannot honor.
  const { cap: sessionCap, provisional: sessionCapProvisional } = bootWorkerBudget(
    {
      heapBudgetMb: config.WORKER_HEAP_BUDGET_MB,
      processBaselineMb: config.WORKER_PROCESS_BASELINE_MB,
      plannedSessionMb: config.WORKER_PLANNED_SESSION_MB,
      measuredSessionMb: config.WORKER_MEASURED_SESSION_MB_DM_ONLY,
      safetyFactor: config.WORKER_SESSION_SAFETY_FACTOR,
    },
    process.execArgv,
    process.env.NODE_OPTIONS,
  );
  const budgetBytes = config.WORKER_HEAP_BUDGET_MB * 1024 * 1024;

  const workerId = `${process.env.HOSTNAME ?? 'host'}-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`;

  const keyProvider = new FileKeyProvider({
    ringPath: config.KEY_RING_PATH,
    mountedPurposes: ['session'],
  });

  const socketFactoryLogger = socketFactoryLoggerFrom(logger);

  const publisher = createRedisRealtimePublisher({
    redis: redisCtl,
    env: config.NODE_ENV,
  });

  const worker = createSessionWorker({
    env: config.NODE_ENV,
    workerId,
    pool,
    tenantDb: createTenantDb(pool),
    workerDb: createWorkerDb(pool),
    redisCtl,
    redisSig,
    redisCache,
    keyProvider,
    encVersion: config.ENC_VERSION,
    socketFactory: (auth) =>
      createBaileysSocket({
        auth: auth as never,
        logger: socketFactoryLogger,
        getMessage: async () => undefined,
      }) as never,
    sessionCap,
    budgetBytes,
    signalKeystoreMaxRecords: config.SIGNAL_KEYSTORE_MAX_RECORDS,
    maxFieldsPerInstance: config.REDIS_SIG_MAX_FIELDS_PER_INSTANCE,
    // 2026-09-22 REST QR fallback (Task 1, "first QR lost" fix): every
    // `instance.qr` publish also fires a write-through to `qr-cache.ts`, so
    // a browser that has not subscribed to SSE yet can still retrieve the QR
    // via `GET .../link-status` (see that route's own doc). Purely additive
    // - `publisher.publish` below (the existing SSE/Redis-bridge path) runs
    // exactly as before, unconditionally, regardless of the cache write's
    // outcome or completion order: `void`, fire-and-forget, same idiom as
    // `wake.ts`'s own `publishWake`. `pairing.ts`'s `publish` port is itself
    // synchronous and unawaited by its caller, so this stays a plain sync
    // closure. `writeQrCache` fails open internally (never throws).
    publish: (event) => {
      if (event.type === 'instance.qr') {
        void writeQrCache(redisCtl, {
          env: config.NODE_ENV,
          clientId: event.clientId,
          instanceId: event.instanceId,
          qr: {
            payload: event.payload,
            expiresAt: event.expiresAt,
            attemptsLeft: event.attemptsLeft,
          },
        });
      }
      publisher.publish(event as never);
    },
  });

  // P11 U5 steps 8-9: start/stop a per-instance send loop with the lease - `worker.registry`/`worker.getHeldLease` ARE the acquire/release signal (see send-loop-worker-wiring.ts's own header).
  const sendLoopWiring = bootSendLoopFleetWiring(
    {
      env: config.NODE_ENV,
      workerId,
      pool,
      tenantDb: createTenantDb(pool),
      redisCtl,
      metrics: bindQueueMetrics(),
      safetyPollMs: config.SAFETY_POLL_MS,
      rng: { random: () => Math.random() },
    },
    worker,
  );

  const healthLoop = bootHealthEvaluatorLoop({ pool, tenantDb: createTenantDb(pool) });

  // Discovery scan scheduler (5000ms+/-2000ms jittered poll, unconditional -
  // PLUS the 2026-09-17 fleet-wide pub/sub wake that shortens the average
  // wait for the common case) - see session-worker-discovery-wake-wiring.ts's
  // own doc comment for the full pub/sub-is-a-latency-optimisation rationale.
  const discoveryScanScheduler = bootDiscoveryScanScheduler({
    env: config.NODE_ENV,
    redisCtl,
    worker,
    sendLoopWiring,
    logger,
  });

  // P25 U2 (step 3): a SEPARATE listener, before the scan scheduler starts.
  const metricsServer: MetricsServerHandle = await startMetricsServer({
    bind: config.WP_METRICS_BIND,
    port: config.WP_METRICS_PORT,
    role: 'session-worker',
    env: config.NODE_ENV,
  });
  await discoveryScanScheduler.start();

  console.log(
    `session-worker role started (workerId=${workerId}, sessionCap=${String(sessionCap)}, ` +
      `sessionCapProvisional=${String(sessionCapProvisional)})`,
  );

  // Production feedback loop (P10 U6 step 9, ADR 0018 S3) - see session-cost-feedback-timer.ts.
  let measuredSessionMb = config.WORKER_MEASURED_SESSION_MB_DM_ONLY;
  let currentCapMb = sessionCap;
  const feedbackRing = new SessionRssRingBuffer(60);
  const feedbackTimer = buildSessionCostFeedbackTimer({
    workerId,
    getCurrentMeasuredSessionMb: () => measuredSessionMb,
    getCurrentCapMb: () => currentCapMb,
    budget: {
      heapBudgetMb: config.WORKER_HEAP_BUDGET_MB,
      processBaselineMb: config.WORKER_PROCESS_BASELINE_MB,
      plannedSessionMb: config.WORKER_PLANNED_SESSION_MB,
      safetyFactor: config.WORKER_SESSION_SAFETY_FACTOR,
    },
    readCurrentSessionRssSlopeMb: () => {
      feedbackRing.push({ sessions: worker.registrySize(), rssBytes: process.memoryUsage().rss });
      const slopeBytes = estimateSessionRssSlopeBytes(feedbackRing.snapshot());
      return slopeBytes === null ? undefined : slopeBytes / (1024 * 1024);
    },
    onApplied: (nextMeasuredMb, nextCapMb) => {
      measuredSessionMb = nextMeasuredMb;
      currentCapMb = nextCapMb;
    },
  });

  // Groups sync/leave loop - see session-groups-sync-timer.ts (P24 U3).
  const groupsSyncTimer = buildGroupsSyncTimer({
    tenantDb: createTenantDb(pool),
    registry: worker.registry,
    logger: {
      warn: (obj, msg) => logger.warn(obj, msg),
      info: (obj, msg) => logger.info(obj, msg),
    },
  });

  // SIGTERM/SIGINT -> graceful drain, registered ONCE (never a second, concurrent drain).
  let signalHandlersRegistered = false;
  let drainStarted = false;

  function registerShutdownSignals(): void {
    if (signalHandlersRegistered) return;
    signalHandlersRegistered = true;

    const onSignal = (): void => {
      if (drainStarted) {
        // A second signal during an in-flight drain is a no-op - the first run owns shutdown.
        return;
      }
      drainStarted = true;
      feedbackTimer.stop();
      groupsSyncTimer.stop();
      healthLoop.stop();
      void discoveryScanScheduler.stop(); // best-effort, never blocks the drain below.
      void metricsServer.close(); // best-effort, never blocks the drain below.

      const drain = buildSessionWorkerDrain({
        worker,
        pool,
        tenantDb: createTenantDb(pool),
        redisCtl,
        redisSig,
        redisCache,
        // Stops every send loop's subscriber/safety-poll timer - never fails a queued job (invariant 5).
        stopClaiming: () => sendLoopWiring.shutdown(),
        exit: (code) => process.exit(code),
      });

      void drain.run();
    };

    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  registerShutdownSignals();
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${name}: ${message}`);
  process.exit(1);
});
