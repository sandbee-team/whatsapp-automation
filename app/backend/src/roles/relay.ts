import { createPool } from '@wp/db';
import { createRedis } from '../platform/redis.js';
import { logger } from '@wp/server-kit';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { TIMING } from '@wp/domain';
import { loadConfig } from '../platform/config.js';
import { assertDbPreconditionsOrExit } from '../platform/db/assert-db-preconditions.js';
import { drainOnce, runOutboxCleanup } from '../modules/events/index.js';
import { createRedisRealtimePublisher } from '../modules/realtime/redis-bridge.js';
import { bindRelayMetrics } from '../platform/metrics/relay-metrics.js';
import { createWebhookFanoutPort } from '../modules/webhooks/repo.js';
import { createDispatcherLoop } from '../modules/webhooks/dispatcher.js';
import { safeFetch } from '../platform/http/safe-fetch.js';
import { createRelayEmailFanoutPort } from '../modules/notifications/index.js';
import { startMetricsServer, type MetricsServerHandle } from '../platform/metrics/server.js';

/**
 * ROLE=relay entrypoint (P15 Unit U4, step 5) - runs the outbox drain tick
 * (`RELAY_TICK_MS`, default 500ms - ADR 0010's own literal "Tick 500 ms")
 * and the bounded cleanup sweep (`RELAY_CLEANUP_TICK_MS`, default 60s) as
 * two independent `setInterval` timers, mirroring `roles/cron.ts`'s boot
 * shape exactly: loadConfig -> validate DATABASE_URL -> createPool (same
 * connect/statement timeouts as every other role) -> `assertDbPreconditionsOrExit`
 * BEFORE starting either timer -> start both -> SIGTERM/SIGINT once for a
 * clean stop.
 *
 * PUBLISH TRANSPORT: the relay is a SEPARATE process from `api` (which owns
 * the in-process `RealtimeHub`) - it can never call `hub.publish` directly
 * (see `scripts/check-no-direct-publish.ts`'s own allow-list, which permits
 * `hub.publish(` in this file's PRODUCTION import chain via
 * `createRedisRealtimePublisher`, not by this file calling it itself). Every
 * coalesced batch frame crosses process boundaries through
 * `modules/realtime/redis-bridge.ts`'s `publishBatch` (P15 U4 extension).
 *
 * NOTIFY WAKE (ADR 0010: "correctness never depends on NOTIFY"): a single
 * dedicated `LISTEN wp_outbox_wake` connection is opened as a pure latency
 * optimisation - the 500ms poll floor is what actually keeps draining
 * regardless of whether this LISTEN connection is even alive. If it cannot
 * be established, this process logs ONCE and runs poll-only (fail-safe)
 * rather than refusing to boot.
 *
 * WEBHOOK DISPATCH (P15 U5, step 7): `secondaryLoops` now carries the
 * webhook dispatcher's own tick alongside `drainLoop`/`cleanupLoop` -
 * `modules/webhooks/dispatcher.ts`'s `createDispatcherLoop`, wired here with
 * a `tenant-secrets`-mounted `FileKeyProvider` (SEPARATE from the drain
 * loop's plain publish path - this is the first thing in `roles/relay.ts`
 * that ever opens a KEK; `roles/api.ts` mounts `optout-pepper` for its own,
 * distinct purpose, never `tenant-secrets` - see that file's own comment).
 * `drainOnce`'s own `webhookFanout` port (`createWebhookFanoutPort`) is
 * wired on the SAME `drainOnce` call the drain timer already makes, so the
 * durable `webhook_deliveries` handoff row is written in the SAME
 * transaction as the outbox row's mark-published UPDATE.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to boot the relay role.');
  }

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'wp-relay',
    connectionTimeoutMillis: TIMING.pgConnectTimeoutMs,
    statementTimeoutMs: TIMING.pgStatementTimeoutMs,
  });

  const ok = await assertDbPreconditionsOrExit(pool);
  if (!ok) {
    return;
  }

  const redisCtl = createRedis(config.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const metrics = bindRelayMetrics();
  const publisher = createRedisRealtimePublisher({
    redis: redisCtl,
    env: config.NODE_ENV,
    metrics: { incrementDroppedPublish: metrics.incrementDroppedPublish },
  });
  const webhookFanout = createWebhookFanoutPort();
  // P17 U3 (step 4): see modules/notifications/dispatch/relay-email-fanout.ts's
  // own doc comment (wiring lives with its module, not under roles/).
  const emailFanout = createRelayEmailFanoutPort(redisCtl, config.NODE_ENV);

  // P15 U5 (step 7): the ONLY tenant-secrets KEK mount in this role - the
  // dispatcher unseals `webhook_endpoints.secret_enc` to sign every outbound
  // delivery. `roles/api.ts` mounts `optout-pepper` for its own distinct
  // purpose; NEVER `session` (that KEK is worker-only, auth-state material).
  const webhookKeyProvider = new FileKeyProvider({
    ringPath: config.KEY_RING_PATH,
    mountedPurposes: ['tenant-secrets'],
  });

  const secondaryLoops: { start: () => void; stop: () => void }[] = [
    createDispatcherLoop(
      {
        pool,
        keyProvider: webhookKeyProvider,
        clock: { now: () => new Date() },
        rng: Math.random,
        fetch: safeFetch,
      },
      config.RELAY_TICK_MS,
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({}, `relay dispatch tick failed: ${message}`);
      },
    ),
  ];

  // ONE hoisted deps object shared by BOTH the fixed-interval drain timer
  // AND the NOTIFY-wake drain call below - a second, independently-built
  // deps object here could drift out of parity (e.g. omit webhookFanout/
  // emailFanout) and silently publish rows with no durable handoff ever
  // written - see `relay-drain-deps.test.ts`.
  const drainDeps = {
    pool,
    publisher,
    metrics,
    clock: { now: () => new Date() },
    webhookFanout,
    emailFanout,
  };

  /**
   * BUG FIX (P15 C1 FIX F5 / MAJ-3): runs under a real `SET LOCAL ROLE
   * wp_relay` transaction (`cleanup.ts`'s own documented contract), same
   * `BEGIN`/`SET LOCAL ROLE`/`COMMIT`-or-`ROLLBACK` shape as `relay-loop.ts`'s
   * `withRelayRole`, duplicated here rather than imported ("the shape is the
   * contract, not a shared function"). The health-samples retention sweep
   * does NOT run here (P16 gate-fix pass) - it runs in the session-worker
   * process under `wp_scheduler` (see `session-worker-health-loop-wiring.ts`)
   * so `wp_relay`'s deliberately minimal grant surface
   * (`wp-relay-role.test.ts`) never widens.
   */
  async function runCleanupUnderRelayRole(): Promise<number> {
    const client = await pool.connect();
    let releaseError: unknown;
    try {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE wp_relay');
        const deleted = await runOutboxCleanup({ pool: client });
        await client.query('COMMIT');
        return deleted;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
          releaseError = undefined;
        } catch (rollbackErr) {
          releaseError = rollbackErr;
        }
        throw err;
      }
    } finally {
      if (releaseError !== undefined) {
        client.release(releaseError as Error);
      } else {
        client.release();
      }
    }
  }

  let drainHandle: ReturnType<typeof setInterval> | undefined;
  let cleanupHandle: ReturnType<typeof setInterval> | undefined;

  function startTimers(): void {
    drainHandle = setInterval(() => {
      void drainOnce(drainDeps).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({}, `relay drain tick failed: ${message}`);
      });
    }, config.RELAY_TICK_MS);

    cleanupHandle = setInterval(() => {
      void runCleanupUnderRelayRole().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({}, `relay cleanup tick failed: ${message}`);
      });
    }, config.RELAY_CLEANUP_TICK_MS);
  }

  // LISTEN wake - a hint-only latency optimisation (see module doc). A
  // failure to establish it logs once and leaves the process on poll-only,
  // never a boot refusal.
  // Minimal structural port - never names `pg.PoolClient` directly (this
  // package has no direct `pg` dependency; matches `engine/cron/cron-wiring.ts`'s
  // own "never imported here by name" convention for a `pg.Pool`-shaped value).
  let wakeClient:
    | {
        query: (sql: string) => Promise<unknown>;
        on: (
          event: 'notification' | 'error',
          cb: ((msg: { channel: string; payload?: string }) => void) | ((err: unknown) => void),
        ) => void;
        release: () => void;
      }
    | undefined;
  try {
    const client = await pool.connect();
    wakeClient = client;
    await client.query('LISTEN wp_outbox_wake');
    client.on('notification', (msg) => {
      if (msg.channel !== 'wp_outbox_wake') return;
      // A wake is a hint to drain NOW, in addition to the fixed poll - never
      // a substitute for it, never carries data. Uses the SAME hoisted
      // `drainDeps` the timer above uses (F1 / CRIT-2 fix) - never a second,
      // independently-built deps object that could drift out of parity.
      void drainOnce(drainDeps).catch(() => undefined);
    });
    // BUG FIX (P15 C2, hunt item 8): an unlistened 'error' on this pinned pg
    // client would crash the whole process (incl. unrelated timers) - fail-
    // safe requires this handler so a dropped LISTEN connection degrades to
    // poll-only instead.
    client.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        {},
        `relay: LISTEN wp_outbox_wake connection errored, continuing poll-only: ${message}`,
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      {},
      `relay: could not establish LISTEN wp_outbox_wake, running poll-only: ${message}`,
    );
  }

  startTimers();
  for (const loop of secondaryLoops) {
    loop.start();
  }
  // P25 U2 (step 3): a SEPARATE listener - this role serves no public routes at all.
  const metricsServer: MetricsServerHandle = await startMetricsServer({
    bind: config.WP_METRICS_BIND,
    port: config.WP_METRICS_PORT,
    role: 'relay',
    env: config.NODE_ENV,
  });

  console.log(
    `relay role started (drain ${String(config.RELAY_TICK_MS)}ms, cleanup ${String(config.RELAY_CLEANUP_TICK_MS)}ms)`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Work loops stop FIRST - monitoring is best-effort, never fatal.
      if (drainHandle !== undefined) clearInterval(drainHandle);
      if (cleanupHandle !== undefined) clearInterval(cleanupHandle);
      for (const loop of secondaryLoops) {
        loop.stop();
      }
      await metricsServer.close().catch(() => undefined);
      if (wakeClient !== undefined) {
        // MINOR FIX (P15 C1 hygiene): a still-LISTENing client must never be
        // returned to the shared pool - UNLISTEN first so the connection is
        // clean before `release()` hands it back for reuse by an unrelated
        // future `pool.connect()` caller. `pool.end()` right after makes any
        // residual state moot in practice, but this keeps the release itself
        // correct independent of that ordering.
        try {
          await wakeClient.query('UNLISTEN wp_outbox_wake');
        } catch {
          // Best-effort - the connection may already be broken (see the
          // 'error' handler above); release() below still runs either way.
        }
        wakeClient.release();
      }
    } finally {
      await pool.end();
      await redisCtl.quit().catch(() => undefined);
    }
  };

  process.on('SIGTERM', () => {
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  process.on('SIGINT', () => {
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  logger.error({}, `${name}: ${message}`);
  process.exit(1);
});
