import { createPool, createTenantDb } from '@wp/db';
import { logger } from '@wp/server-kit';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { loadConfig } from '../platform/config.js';
import { createRedis } from '../platform/redis.js';
import { createMailer } from '../platform/mailer.js';
import { createRateLimiter } from '../platform/http/rate-limit.js';
import { assertDbPreconditionsOrExit } from '../platform/db/assert-db-preconditions.js';
import { buildApp } from '../platform/http/server.js';
import type { AuthDeps } from '../platform/http/auth-plugin.js';
import { getUserTotpState } from '../modules/identity/index.js';
import { createInstanceOwnership } from '../modules/instances/index.js';
import { publishWake } from '../engine/queue/wake.js';
import {
  createRealtimeHub,
  bindRealtimeMetrics,
  createAuthzTick,
  type RealtimeCtx,
} from '../modules/realtime/index.js';
import { createRedisRealtimeSubscriber } from '../modules/realtime/redis-bridge.js';
import { createWalletRepairedSendSink, refundSend } from '../modules/wallet/index.js';
import { lookupByKeyPrefix } from '../modules/api-keys/index.js';
import { bindWalletMetrics } from '../platform/metrics/wallet-metrics.js';
import { safeFetch } from '../platform/http/safe-fetch.js';
import { createObjectStoreFromConfig } from '../platform/storage/object-store.js';
import type { InternalRoutesDeps } from '../modules/internal/index.js';
import { startMetricsServer, type MetricsServerHandle } from '../platform/metrics/server.js';

/**
 * ROLE=api entrypoint. NEVER sends messages and NEVER imports provider code
 * (canon). Boot order (canon, binding): load config -> connect pg + redis ->
 * `assertDbPreconditionsOrExit(db)` BEFORE serving any request -> build the
 * Fastify app -> listen. `hasTotpEnrolled` calls `modules/identity/index.ts`'s
 * `getUserTotpState` (never duplicates that query inline). Starts the SSE
 * re-authorisation tick after `listen` and stops it before `closeAll`/
 * `app.close` on shutdown.
 *
 * Also starts the Redis realtime-bridge SUBSCRIBER (own dedicated connection,
 * `realtimeBridgeRedis`) before `buildApp`/`listen` - this is the API-side
 * half of `modules/realtime/redis-bridge.ts` that re-publishes
 * `session-worker`'s cross-process events (e.g. `instance.qr`) into the
 * in-process `realtimeHub` for SSE delivery (see the wiring's own comment
 * below for why this was missing in production). Stopped before
 * `realtimeHub.closeAll` on shutdown, its connection disconnected alongside
 * `redis` in the same `finally`.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to boot the api role.');
  }
  if (!config.REDIS_URL) {
    throw new Error('REDIS_URL is required to boot the api role.');
  }

  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'app-backend-api',
  });
  const tenantDb = createTenantDb(pool);
  const redis = createRedis(config.REDIS_URL);

  const ok = await assertDbPreconditionsOrExit(pool);
  if (!ok) {
    return;
  }

  const mailer = createMailer();

  // The `optout-pepper` KEK - `createMessage`'s enqueue-time opt-out gate
  // (P14 Unit U4) hashes every recipient through it. Mounted alongside no
  // other purpose here (session material stays with session-worker.ts's own,
  // distinct provider).
  const keyProvider = new FileKeyProvider({
    ringPath: config.KEY_RING_PATH,
    mountedPurposes: ['optout-pepper'],
  });

  // P15 U5 (step 8): a SEPARATE `tenant-secrets`-only provider for the
  // webhook endpoint CRUD routes (sealing a freshly-generated secret at
  // create time) - kept distinct from `keyProvider` above rather than adding
  // `tenant-secrets` to its `mountedPurposes`, so each provider's mounted-
  // purpose list stays a precise statement of what that call site actually
  // needs (same discipline `roles/relay.ts`'s own dispatcher-only mount
  // follows for its unseal side of this same purpose).
  const webhookKeyProvider = new FileKeyProvider({
    ringPath: config.KEY_RING_PATH,
    mountedPurposes: ['tenant-secrets'],
  });

  const apiKeyPepperProvider = new FileKeyProvider({
    ringPath: config.KEY_RING_PATH,
    mountedPurposes: ['api-key-pepper'],
  });
  const apiKeyPepper = apiKeyPepperProvider.getActive('api-key-pepper').material;

  const realtimeHub = createRealtimeHub({
    replayRingSize: config.SSE_REPLAY_RING_SIZE,
    maxConnectionsPerUser: config.SSE_MAX_CONNECTIONS_PER_USER,
  });
  const realtimeMetrics = bindRealtimeMetrics(realtimeHub);
  const realtimeCtx: RealtimeCtx = {
    hub: realtimeHub,
    // P08 Unit U4: the real `whatsapp_instances` ownership lookup, replacing
    // the fail-closed stub (`failClosedInstanceOwnership` stays exported from
    // modules/realtime for tests - see ownership.ts's own doc comment).
    instanceOwnership: createInstanceOwnership(pool),
    maxConnectionsPerUser: config.SSE_MAX_CONNECTIONS_PER_USER,
    onSubscriptionRefused: realtimeMetrics.onSubscriptionRefused,
  };

  const authzTick = createAuthzTick({
    hub: realtimeHub,
    db: pool,
    tickMs: config.SSE_AUTHZ_TICK_MS,
    maxConsecutiveFailures: config.SSE_AUTHZ_MAX_CONSECUTIVE_FAILURES,
    metrics: { incrementAuthzTickErrors: realtimeMetrics.incrementAuthzTickErrors },
    logger,
  });

  // FIX (discovered 2026-09-15, first live deployment - QR code never
  // reached the browser): `session-worker.ts` publishes `instance.qr` (and
  // every other cross-process real-time event) onto the Redis bridge channel
  // via `createRedisRealtimePublisher` (pairing.ts:100-107 -> that publisher
  // -> redis-bridge.ts's `publish`). `redis-bridge.ts`'s OWN header comment
  // describes this as a two-sided bridge - "the worker-side publisher writes
  // one validated JSON frame ... the API-side subscriber reads it back and
  // re-publishes into the REAL in-process hub" - but `createRedisRealtimeSubscriber`
  // was never actually called anywhere in this role (or anywhere else in
  // production). Every frame the worker published landed on a Redis Pub/Sub
  // channel with zero subscribers and was silently discarded - confirmed live
  // by `whatsapp_instances.qr_attempts` incrementing on rows whose QR never
  // reached any browser. The frontend side (`useLinkStream.ts`) was already
  // correctly subscribed to the SSE stream; it simply never received
  // anything because nothing fed the hub from the worker process.
  //
  // A SEPARATE Redis connection is required here, never the shared `redis`
  // handle above: `redis-bridge.ts`'s `CreateRedisRealtimeSubscriberOptions`
  // takes a full `Redis` client because `.subscribe()` puts a connection into
  // subscriber mode, after which ioredis can no longer issue ordinary
  // commands on it (see that file's own doc comment on the option) - `redis`
  // above is already shared by the rate limiter, wake publishes, and the
  // card/dashboard deps below and must stay free to issue normal commands.
  // `createRedis` gives this its own bounded connect timeout / single-retry
  // behaviour (platform/redis.ts's own "no reconnect loop" comment), so a
  // Redis that is genuinely unreachable at boot fails `subscriber.start()`
  // below and takes the whole process down with it (fail-closed at boot,
  // same discipline as the `DATABASE_URL`/`REDIS_URL` presence checks above).
  // A connection that drops LATER, mid-life, is the SAME accepted gap
  // `redis-bridge.ts`'s own header already documents for this whole bridge
  // ("fire and forget... a message published while the subscriber is down is
  // simply never delivered... an accepted, documented gap for this phase") -
  // this is the identical connection factory `session-worker.ts`'s and
  // `relay.ts`'s own publisher-side connections already use with the same
  // no-reconnect behaviour, so this wiring is not taking on any new risk
  // beyond what the bridge's design already accepts; it must never be
  // "fixed" here with a bespoke reconnect loop the module itself doesn't
  // have (P15's outbox relay is the documented durable replacement).
  const realtimeBridgeRedis = createRedis(config.REDIS_URL);
  const realtimeBridgeSubscriber = createRedisRealtimeSubscriber({
    redis: realtimeBridgeRedis,
    env: config.NODE_ENV,
    hub: realtimeHub,
    // `RedisRealtimeSubscriberLogger.warn` is `(msg, meta?)` - the OPPOSITE
    // argument order from `@wp/server-kit`'s own `WpLogger.warn`, which is
    // pino-shaped `(fields, msg)` (see `createAuthzTick`'s `logger` above,
    // which takes the shared `logger` export directly because
    // `AuthzTickLoggerPort` already matches that pino order). Passing
    // `logger` straight through here would silently hand a STRING as pino's
    // `fields` object on every call. Same adapter idiom as
    // `engine/fleet/session-cost-feedback-timer.ts`'s own `logger.warn({},
    // ...)` wrapper for this identical port-shape mismatch.
    logger: {
      warn: (msg, meta) => {
        logger.warn({}, meta ? `${msg} ${JSON.stringify(meta)}` : msg);
      },
    },
  });
  await realtimeBridgeSubscriber.start();

  const authDeps: AuthDeps = {
    tokenEpochCtx: {
      redis,
      db: pool,
      jwtSecret: config.AUTH_JWT_SECRET,
      epochCacheTtlSec: config.EPOCH_CACHE_TTL_SEC,
      env: config.NODE_ENV,
    },
    db: pool,
    // P04b FIXB debt (carried into P05 U3b): reuses
    // modules/identity/mfa.repo.ts's own query rather than duplicating it
    // inline here.
    hasTotpEnrolled: async (userId: string) => {
      const state = await getUserTotpState(pool, userId);
      return Boolean(state?.mfaEnabledAt);
    },
    verifyApiKeyDeps: {
      pepper: apiKeyPepper,
      lookupByKeyPrefix: (kp) => lookupByKeyPrefix(pool, kp),
    },
  };

  const walletMetrics = bindWalletMetrics();
  const apiKeyRateLimiter = createRateLimiter(redis);
  // P34 U-upload: ONE object store instance shared by every route that needs
  // it (contactImports/media) - avoids constructing a second MinIO client
  // per boot when OBJECT_STORE_DRIVER=s3.
  const objectStore = createObjectStoreFromConfig(config);

  const app = await buildApp({
    identity: {
      pool,
      tenantDb,
      redis,
      rateLimiter: createRateLimiter(redis),
      config,
      mailer: {
        sendVerificationEmail: mailer.sendVerificationEmail,
        sendLockoutEmail: mailer.sendLockoutEmail,
        sendReuseDetectedEmail: mailer.sendReuseDetectedEmail,
        sendPasswordResetEmail: mailer.sendPasswordResetEmail,
      },
    },
    onboarding: { onboardingCtx: { pool } },
    instances: { entitlementCtx: { pool }, tenantDb },
    // P16 Unit D (step 8): human-only resume - `publishWake` bound to the
    // SAME `redis` control-plane handle every other wake publisher in this
    // role uses (see wake.ts's own header comment on the redis-ctl tier).
    resume: {
      tenantDb,
      publishWake: (clientId, instanceId) =>
        publishWake(redis, config.NODE_ENV, clientId, instanceId),
    },
    messages: { entitlementCtx: { pool }, tenantDb, keyProvider, rateLimiter: apiKeyRateLimiter },
    realtime: {
      realtimeCtx,
      heartbeatMs: config.SSE_HEARTBEAT_MS,
      maxBufferedFrames: config.SSE_MAX_BUFFERED_FRAMES,
    },
    // P18 U4: the real wallet-charging sink (see wallet-sink.ts's own doc
    // comment) - `refundSend` is ALSO wired directly as the PRIMARY,
    // in-transaction refund `retryUnresolved` runs itself (ADR 0038 S5);
    // `sink.onReconciledLost` is the post-commit idempotent fallback.
    unresolved: {
      tenantDb,
      sink: createWalletRepairedSendSink({ tenantDb, metrics: walletMetrics }),
      refundSend: (tx, input) => refundSend(tx, input, { metrics: walletMetrics }),
    },
    // P15 U5 (step 8): endpoint CRUD - `fetchFn` is the real `safeFetch`
    // (SSRF-guarded at configuration time, same function the dispatcher
    // uses at every actual send).
    webhooks: { tenantDb, keyProvider: webhookKeyProvider, fetchFn: safeFetch },
    // Go-live U4: the tenant `api_keys` CRUD API - reuses `apiKeyPepper`.
    apiKeys: { tenantDb, pepper: apiKeyPepper },
    // P34 U-upload (ADR 0052 accepted scope): the outbound media upload API -
    // reuses the SAME `objectStore` instance `contactImports` binds below.
    media: { tenantDb, objectStore },
    // P20 Unit U4 (step 4): the tenant contacts + tags CRUD API - reuses
    // the SAME `keyProvider` instance (mounted `optout-pepper`) `messages`
    // already binds above, per this unit's own "reuse that same instance"
    // instruction (never a second `optout-pepper`-mounted provider).
    contacts: { tenantDb, keyProvider },
    // P20 Unit U6 (step 5): the CSV import upload/create/poll/cancel/errors
    // surface - reuses the SAME `keyProvider` instance `contacts`/`messages`
    // already bind above (never a second `optout-pepper`-mounted provider),
    // plus the config-driven object store (fs in dev, S3-compatible in prod).
    contactImports: { tenantDb, keyProvider, objectStore },
    // P17 close: the four P17 API surfaces. These were dep-gated but never
    // passed here - the integration tests build their own app with the deps,
    // so they were green while the production api served none of them (the
    // P12 "panel exists but no endpoint" class, caught at C-phase).
    notifications: { tenantDb },
    card: { tenantDb, redis, env: config.NODE_ENV },
    healthWhy: { tenantDb },
    dashboard: { tenantDb, redis, env: config.NODE_ENV },
    // P19 Unit U4 (step 7/14): the tenant wallet + top-up API - wired for
    // real here (the P17 close note's own "panel exists but no endpoint"
    // class is exactly what NOT passing this dep would repeat).
    wallet: { tenantDb },
    // P19 Unit U5 (step 9): `GET /v1/queue-status`.
    queueStatus: { tenantDb },
    // P23 Unit U5 (step 6): the tenant broadcast lifecycle API - `publishWake`
    // bound to the SAME redis-ctl handle `resume` above uses (resume's own
    // wake, never a second publisher).
    broadcasts: {
      tenantDb,
      publishWake: (clientId, instanceId) =>
        publishWake(redis, config.NODE_ENV, clientId, instanceId),
    },
    // P24 Unit U3 (step 4/5): the tenant groups API - reuses the SAME
    // `tenantDb` every other API surface above uses.
    groups: { tenantDb },
    // P19 Unit U5 (step 8): the `/internal/v1` staff surface stopgap - ABSENT
    // (not merely disabled) whenever `INTERNAL_API_ENABLED` is off, so the
    // routes 404 rather than 403 (server.ts's own "optional dep" idiom, same
    // as `wallet`/`queueStatus` above; `loadConfig` already fails closed at
    // boot if the flag is on with no `INTERNAL_API_SERVICE_TOKEN_SECRET`).
    // Reuses the SAME `pool` every other role dep above uses - see
    // `modules/internal/staff-audit.ts`'s own header for why no second
    // connection string was introduced.
    internal:
      config.INTERNAL_API_ENABLED && config.INTERNAL_API_SERVICE_TOKEN_SECRET
        ? ({
            tenantDb,
            pool,
            // `loadConfig` already throws at boot when INTERNAL_API_ENABLED
            // is true and this is missing (config.ts's own fail-closed
            // check) - the `&&` above is what narrows the type here, not a
            // second runtime guard.
            serviceTokenSecret: config.INTERNAL_API_SERVICE_TOKEN_SECRET,
            allowedCidrs: config.INTERNAL_API_ALLOWED_CIDRS,
            publishWake: (clientId, instanceId) =>
              publishWake(redis, config.NODE_ENV, clientId, instanceId),
          } satisfies InternalRoutesDeps)
        : undefined,
    authDeps,
  });

  const port = config.PORT;
  await app.listen({ port, host: '0.0.0.0' });
  authzTick.start();
  // P25 U2 (step 3): a SEPARATE listener, never mounted on `app` above - a
  // tenant request must never be able to reach /metrics.
  const metricsServer: MetricsServerHandle = await startMetricsServer({
    bind: config.WP_METRICS_BIND,
    port: config.WP_METRICS_PORT,
    role: 'api',
    env: config.NODE_ENV,
  });
  console.log(`api role listening on :${String(port)}`);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // Work stops FIRST - monitoring is best-effort and must never affect
      // it (Finding 2, P25 C1 fix round: metricsServer.close() used to run
      // first, so a rejection there left the app/realtime hub running while
      // `finally` closed the pool underneath them).
      authzTick.stop();
      // The bridge subscriber stops BEFORE `realtimeHub.closeAll` - it only
      // unsubscribes/detaches its own `message` listener (redis-bridge.ts's
      // `stop()` never closes the connection itself, same "caller owns the
      // handle" discipline every other Redis handle in this file follows),
      // so no in-flight worker-published frame can call `hub.publish` on a
      // hub that is already mid-close.
      await realtimeBridgeSubscriber.stop();
      realtimeHub.closeAll('server_shutdown');
      await app.close();
      await metricsServer.close().catch(() => undefined);
    } finally {
      await pool.end();
      redis.disconnect();
      realtimeBridgeRedis.disconnect();
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
  console.error(`${name}: ${message}`);
  process.exit(1);
});
