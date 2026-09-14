import { createPool, createTenantDb } from '@wp/db';
import { logger } from '@wp/server-kit';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { TIMING } from '@wp/domain';
import { loadConfig } from '../platform/config.js';
import { assertDbPreconditionsOrExit } from '../platform/db/assert-db-preconditions.js';
import { createRedis } from '../platform/redis.js';
import { createObjectStoreFromConfig } from '../platform/storage/object-store.js';
import { createCronWiring } from '../engine/cron/cron-wiring.js';
import { startMetricsServer, type MetricsServerHandle } from '../platform/metrics/server.js';

/**
 * ROLE=cron entrypoint (P12 Unit U4, step 7; P20 Unit U8 mounts the
 * contacts loops) - runs the reaper (15s), echo-reconciler (30s +/-
 * jitter), wallet, and contacts cadences, each single-flighted across
 * however many `ROLE=cron` replicas are running via a Postgres
 * `pg_try_advisory_xact_lock` (see `engine/cron/single-flight.ts`'s own
 * module doc for why the transaction-scoped variant, not
 * `pg_advisory_lock`). This process owns NO sockets and NO leases - it
 * never imports `provider/**` or `engine/session/**` (structurally asserted
 * by `cron-loop-shape.test.ts`'s dependency-direction check). Boot order
 * mirrors `roles/api.ts`/`roles/session-worker.ts`: loadConfig -> validate
 * DATABASE_URL -> createPool (with the same connect/statement timeouts
 * session-worker uses - a cron process that can hang on a half-open PG
 * connection is exactly the hazard the P06->P09/P11 wiring gate warns
 * about) -> `assertDbPreconditionsOrExit` BEFORE starting any loop -> start
 * every loop -> register SIGTERM/SIGINT ONCE for a clean stop.
 *
 * Bounded-batch, not per-instance (ADR 0018 S4, "no singleton loop may be
 * O(active) faster than 5 minutes"): every sweep this process drives is a
 * single bounded `LIMIT`ed cross-tenant scan per tick, never one iteration
 * per instance - cadence never scales with fleet size.
 *
 * The `optout-pepper` `FileKeyProvider` (same `KEY_RING_PATH` resolution as
 * `roles/api.ts`) and the real `ObjectStore` are mounted here purely to arm
 * the contacts cron loops (import sweep + mirror reconciler + retention
 * purge) - this process still never mounts `tenant-secrets`/`session`
 * material of its own.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to boot the cron role.');
  }

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'wp-cron',
    connectionTimeoutMillis: TIMING.pgConnectTimeoutMs,
    statementTimeoutMs: TIMING.pgStatementTimeoutMs,
  });
  const tenantDb = createTenantDb(pool);

  const ok = await assertDbPreconditionsOrExit(pool);
  if (!ok) {
    return;
  }

  // Fail-safe (core invariant 2): no REDIS_URL means no charger loop is
  // armed at all - never a throw, never a retry-until-connected loop. The
  // hourly wallet reconciler's check B (runs on this same pool either way)
  // remains the only charge path for a repaired send in that case.
  const redis = config.REDIS_URL ? createRedis(config.REDIS_URL) : undefined;
  if (!redis) {
    logger.warn(
      {},
      'REDIS_URL not set: repaired-send charge work items are disabled; the hourly reconciler check B is the only charger',
    );
  }

  const keyProvider = new FileKeyProvider({
    ringPath: config.KEY_RING_PATH,
    mountedPurposes: ['optout-pepper'],
  });
  const objectStore = createObjectStoreFromConfig(config);

  const wiring = createCronWiring({
    pool,
    tenantDb,
    redis,
    env: config.NODE_ENV,
    keyProvider,
    objectStore,
    // P25 U3: fleet rollup collector cadence - config enforces the >= 300 s floor (ADR 0018 S4).
    metricRollupIntervalMs: config.WP_METRIC_ROLLUP_INTERVAL_S * 1000,
  });
  wiring.start();
  // P25 U2 (step 3): a SEPARATE listener - this role serves no public routes at all.
  const metricsServer: MetricsServerHandle = await startMetricsServer({
    bind: config.WP_METRICS_BIND,
    port: config.WP_METRICS_PORT,
    role: 'cron',
    env: config.NODE_ENV,
  });

  console.log(
    'cron role started (reaper 15s, reconciler 30s +/- jitter, wallet rollup/reconcile hourly' +
      (redis ? ', wallet-charger 15s' : '') +
      ', contact-import 2s, optout-mirror-reconcile daily, contact-import-purge hourly' +
      ', media-asset-purge hourly' +
      ', broadcast-snapshot 2s, broadcast-expansion 2s' +
      `, metric-rollup ${String(config.WP_METRIC_ROLLUP_INTERVAL_S)}s, optout-rate hourly)`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Work loops stop FIRST - monitoring is best-effort and must never
      // affect them (Finding 2, P25 C1 fix round: metricsServer.close() used
      // to run first, so a rejection there left the loops running while
      // `finally` closed the pool underneath them).
      wiring.stop();
      await metricsServer.close().catch(() => undefined);
    } finally {
      await redis?.quit();
      await pool.end();
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
