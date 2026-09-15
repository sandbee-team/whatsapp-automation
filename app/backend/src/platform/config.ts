import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertMailAuthPairing, mailConfigShape } from './config-mail.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * platform/config.ts (P04a Unit A3) - the ONLY file in app-backend that reads
 * `process.env` (core rule: "No `process.env` outside platform/config.ts").
 * Zod-parsed, fail-closed (a bad value throws at load time - never a silent
 * fallback), and frozen so nothing downstream can mutate a shared value at
 * runtime. `loadConfig(env)` is exported separately from the `config`
 * singleton so tests can construct an isolated config from an arbitrary env
 * object without touching real process.env. Keys are added only as the unit
 * that needs them lands - no speculative keys.
 */

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Resolved by test helpers (see platform/db/db-url.ts) from .secrets/dev.env
  // when unset - optional here so `loadConfig` never requires it directly.
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  // P07 Unit U3: Signal/rebuildable Redis tiering - resolved via platform/redis.ts's
  // resolveSigRedisUrl()/resolveCacheRedisUrl() when unset.
  REDIS_SIG_URL: z.string().min(1).optional(),
  REDIS_CACHE_URL: z.string().min(1).optional(),

  PUBLIC_BASE_URL: z.url().default('http://localhost:5173'),

  ...mailConfigShape, // MAIL_* + the Gmail/Workspace notes live in config-mail.ts.

  // PLACEHOLDER pending founder pricing decision (scope-delta open question 1
  // / ADR 0019) - the signup-credit amount is not yet a real business number,
  // just a value that lets P04a's signup transaction be built and tested.
  SIGNUP_CREDIT_MINOR: z.coerce.number().int().min(0).default(10000),
  WALLET_LOW_BALANCE_THRESHOLD_MINOR: z.coerce.number().int().min(0).default(500),

  // Argon2id cost params (P04a Unit A4, modules/identity/password.ts) - OWASP
  // baseline production defaults. NEVER lower these to make a suite run
  // faster; tests inject their own reduced Argon2Params instead.
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),

  // Login lockout ladder (P04a Unit A4, modules/identity/login.service.ts).
  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_BASE_MINUTES: z.coerce.number().int().positive().default(15),
  AUTH_LOCKOUT_MAX_HOURS: z.coerce.number().int().positive().default(24),

  // Auth-route-class rate limiting (P04a Unit A4, platform/http/rate-limit.ts).
  RATE_LIMIT_AUTH_IP_CAPACITY: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_IP_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: z.coerce.number().int().positive().default(900),

  // Session issuance (P04a Unit A5a, modules/identity/session.service.ts and
  // token-epoch.ts). AUTH_JWT_SECRET is left optional in the schema itself
  // because a dev/test default is permitted ONLY when NODE_ENV !==
  // 'production' - that fork can't be expressed as a static zod default, so
  // it is resolved explicitly in `loadConfig` below (fail-closed: a
  // production process with no real secret throws at load, never falls back
  // to the dev string).
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  EPOCH_CACHE_TTL_SEC: z.coerce.number().int().positive().default(3600),

  // Short-lived MFA challenge token (P04a Unit UA6, modules/identity/identity.routes.ts)
  // - minted by POST /v1/auth/login when mfa_enabled_at is set, consumed by
  // POST /v1/auth/totp/verify. No session is minted until the TOTP code is verified.
  MFA_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(5),

  // TOTP MFA (P04a Unit UA5b, modules/identity/totp.service.ts). KEY_RING_PATH
  // is left optional in the schema itself for the same reason as
  // AUTH_JWT_SECRET above: a dev/test default (the checked-in server-kit
  // fixture ring) is permitted ONLY when NODE_ENV !== 'production' - resolved
  // explicitly in `loadConfig` below (fail-closed: a production process with
  // no real key-ring path throws at load, never falls back to the fixture).
  TOTP_WINDOW: z.coerce.number().int().nonnegative().default(1),
  TOTP_USED_CODE_TTL_SEC: z.coerce.number().int().positive().default(95),
  KEY_RING_PATH: z.string().min(1).optional(),

  // FIX 9 (P04a FIXB): Fastify's `trustProxy` option, config-driven rather
  // than hard-coded `true` (canon: a hard-coded `true` lets any caller spoof
  // `req.ip` via X-Forwarded-For, defeating every IP-scoped rate limit).
  // DEFAULT false (no proxy trusted, `req.ip` is always the real socket
  // address) - only a deployment that actually sits behind a trusted proxy
  // should ever set this. Accepts a boolean, an integer hop-count, or a
  // CIDR/string (Fastify's own `trustProxy` shapes) - env vars are always
  // strings, so this is resolved by hand rather than a zod union of types
  // that can never all match a raw string input.
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value): boolean | number | string => {
      if (value === 'true') return true;
      if (value === 'false') return false;
      if (/^\d+$/.test(value)) return Number(value);
      return value;
    }),

  // M14 (P04a FIXB): no `process.env` outside platform/config.ts.
  PORT: z.coerce.number().int().positive().default(3000),
  ROLE: z.enum(['api', 'migrate', 'session-worker', 'cron', 'relay']).optional(),

  // P25 U2 (step 3): per-role internal-only /metrics listener (loopback
  // default; production refuses all-interfaces - platform/metrics/server.ts).
  // Rollup interval floors at 300s (ADR 0018 S4: no O(active)-faster loop).
  WP_METRICS_BIND: z.string().min(1).default('127.0.0.1'),
  WP_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  WP_METRIC_ROLLUP_INTERVAL_S: z.coerce.number().int().min(300).default(300),

  // P08 Unit U6b: auth-codec envelope version stamped on sealed session blobs.
  ENC_VERSION: z.coerce.number().int().min(1).default(1),

  // M17 (P04a FIXB): was a hard-coded module constant in signup.service.ts.
  DEFAULT_PRICE_LIST_KEY: z.string().min(1).default('default_inr'),

  // Real-time SSE stream (P05 Unit U3a, platform/http/sse.ts + modules/realtime/**).
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15000),
  SSE_MAX_BUFFERED_FRAMES: z.coerce.number().int().positive().default(100),
  SSE_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(5),
  SSE_REPLAY_RING_SIZE: z.coerce.number().int().positive().default(500),
  SSE_AUTHZ_TICK_MS: z.coerce.number().int().positive().default(5000),
  // P05 Unit U3b: consecutive-failure budget before the tick drops everyone
  // with reason 'authz_unverifiable' (fail-safe: unverifiable authorisation
  // must not persist indefinitely).
  SSE_AUTHZ_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(6),

  // P09 Unit U1 (engine/fleet/budget.ts): worker session-cap derivation inputs.
  // WORKER_PLANNED_SESSION_MB=35 is the pessimistic (derived, not measured)
  // bracket figure; WORKER_SESSION_SAFETY_FACTOR keeps the cap conservative.
  WORKER_HEAP_BUDGET_MB: z.coerce.number().int().positive().default(3072),
  WORKER_PROCESS_BASELINE_MB: z.coerce.number().int().positive().default(200),
  WORKER_PLANNED_SESSION_MB: z.coerce.number().int().positive().default(35),
  WORKER_SESSION_SAFETY_FACTOR: z.coerce.number().positive().max(1).default(0.85),

  // P10 Unit U6 (step 7): the MEASURED per-session footprint, split by fleet
  // profile. `.optional()` with NO default - absent means "not yet measured";
  // `budget.ts` treats `measuredSessionMb: undefined` as "fall back to
  // WORKER_PLANNED_SESSION_MB and tag the cap provisional".
  WORKER_MEASURED_SESSION_MB_DM_ONLY: z.coerce.number().positive().optional(),
  WORKER_MEASURED_SESSION_MB_GROUP_ENABLED: z.coerce.number().positive().optional(),

  // P10 Unit U5: in-process bounded Signal key-store LRU cap - provisional
  // until P10a measures M3 for real.
  SIGNAL_KEYSTORE_MAX_RECORDS: z.coerce.number().int().positive().default(4000),
  // Tenant-isolation control (core invariant 4) for the shared `redis-sig`
  // (noeviction) working set: caps fields tracked per instance so one
  // broadcast-heavy tenant cannot blow up memory shared by every tenant.
  REDIS_SIG_MAX_FIELDS_PER_INSTANCE: z.coerce.number().int().positive().default(4000),

  // P11 Unit U5 (step 8, engine/queue/wake.ts): the mandatory per-instance
  // safety-poll interval BASE (jittered +/- 12_000ms by the caller, never
  // here - see wake.ts's own SAFETY_POLL_JITTER_MS). Pub/sub wake is
  // at-most-once, so this poll is correctness, not tuning (delta row 1) -
  // fails CLOSED (throws at config load) rather than clamping a bad value
  // into range: a silent clamp could hide a misconfiguration that starves
  // the queue (> 60s) or hot-spins claims (<= 0).
  SAFETY_POLL_MS: z.coerce.number().int().positive().max(60_000).default(30_000),

  // P15 Unit U4 (step 5, roles/relay.ts): the outbox drain tick's base
  // interval - "Tick 500 ms" (ADR 0010 / phase task, verbatim). This IS the
  // correctness mechanism (NOTIFY is a latency-only wake hint on top of it,
  // never a substitute) - unlike SAFETY_POLL_MS above there is no cross-tenant
  // send-eligibility concern bounding this one at 60s, so no `.max()` ceiling
  // is imposed here; a misconfigured value simply changes relay latency, not
  // correctness (every claim is still a bounded, idempotent SKIP LOCKED scan).
  RELAY_TICK_MS: z.coerce.number().int().positive().default(500),
  // Bounded cleanup sweep cadence - independent of the drain tick's own
  // interval (retention window is a full hour - see modules/events/cleanup.ts).
  RELAY_CLEANUP_TICK_MS: z.coerce.number().int().positive().default(60_000),
  // ADR 0010: "above 50,000 depth the relay drops ephemeral topics". Kept
  // configurable (never hard-coded in relay-loop.ts) so a load test can
  // exercise the backpressure branch without seeding 50,001 real rows.
  OUTBOX_BACKPRESSURE_DEPTH_THRESHOLD: z.coerce.number().int().positive().default(50_000),

  // P19 U5: `/internal/v1` staff surface stopgap (P28 replaces it). Absent
  // routes (404) when off, server.ts's optional-dep idiom; bool-from-string
  // like TRUST_PROXY.
  INTERNAL_API_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  // HMAC-SHA256 service-token secret (service-token.ts); `loadConfig` below
  // throws if the flag is on and this is missing - no dev/test default.
  INTERNAL_API_SERVICE_TOKEN_SECRET: z.string().min(32).optional(),
  // Comma-separated IPv4 CIDR allow-list, e.g. "10.0.0.0/8" - empty denies all.
  INTERNAL_API_ALLOWED_CIDRS: z.string().default(''),

  // P20 Unit U3 (step 5, platform/storage/object-store.ts): the tenant-CSV
  // object store. 'fs' is the dev default (rootDir under REPO_ROOT/.data,
  // outside SCAN_GLOBS so tenant CSVs are never scanned by check-copy); 's3'
  // targets MinIO/any S3-compatible service. Fail-closed in `loadConfig` below.
  OBJECT_STORE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  OBJECT_STORE_FS_ROOT: z
    .string()
    .min(1)
    .default(path.join(REPO_ROOT, '.data', 'object-store')),
  S3_ENDPOINT: z.string().min(1).default('127.0.0.1'),
  S3_PORT: z.coerce.number().int().positive().default(9000),
  S3_USE_SSL: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).default('wp-dev'),
  // Optional: unset for MinIO (dev), REQUIRED for real AWS S3 - see the
  // `region` comment in platform/storage/object-store.ts for what breaks
  // without it, and how silently.
  S3_REGION: z.string().min(1).optional(),

  // Platform floor for the per-instance inbound admission ceiling - the DB column overrides per instance; tenants cannot raise it.
  INBOUND_MAX_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // Token-bucket capacity ceiling; used as-is when smaller than the resolved per-instance limit.
  INBOUND_BURST: z.coerce.number().int().positive().default(120),
  // C1 fix round (inflight-limiter.ts): per-worker socket-handler concurrency and pending-queue ceilings.
  INBOUND_MAX_INFLIGHT: z.coerce.number().int().positive().default(32),
  INBOUND_MAX_PENDING: z.coerce.number().int().positive().default(5000),
});

type ParsedConfig = z.infer<typeof configSchema>;

export type Config = Readonly<
  Omit<ParsedConfig, 'AUTH_JWT_SECRET' | 'KEY_RING_PATH'> & {
    AUTH_JWT_SECRET: string;
    KEY_RING_PATH: string;
  }
>;

/**
 * Dev/test-only fallback for `AUTH_JWT_SECRET` (>= 32 chars, satisfies the
 * schema's own `min(32)`) - NEVER used when `NODE_ENV === 'production'` (see
 * `loadConfig` below).
 */
const DEV_AUTH_JWT_SECRET_DEFAULT = 'dev-only-secret-not-for-production-use!!';

/**
 * Dev/test-only fallback for `KEY_RING_PATH` - the checked-in `@wp/server-kit`
 * fixture ring (carries `user-secrets` among other purposes) - NEVER used
 * when `NODE_ENV === 'production'` (see `loadConfig` below), same guard
 * shape as `DEV_AUTH_JWT_SECRET_DEFAULT`.
 */
const DEV_KEY_RING_PATH_DEFAULT = path.join(
  REPO_ROOT,
  'packages',
  'server-kit',
  'test',
  'fixtures',
  'key-ring.dev.json',
);

/**
 * Parses `env` (defaults to `process.env`) into a frozen `Config`. Throws
 * (fail-closed) on any invalid value - a malformed env var must never fall
 * back to a default or start the process in an unknown state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);

  let authJwtSecret = parsed.AUTH_JWT_SECRET;
  if (!authJwtSecret) {
    if (parsed.NODE_ENV === 'production') {
      throw new Error(
        'AUTH_JWT_SECRET is required in production (min 32 chars) - refusing to start with no secret.',
      );
    }
    authJwtSecret = DEV_AUTH_JWT_SECRET_DEFAULT;
  }

  let keyRingPath = parsed.KEY_RING_PATH;
  if (!keyRingPath) {
    if (parsed.NODE_ENV === 'production') {
      throw new Error(
        'KEY_RING_PATH is required in production - refusing to start with no key ring.',
      );
    }
    keyRingPath = DEV_KEY_RING_PATH_DEFAULT;
  }

  // Fail closed: never boot enabled with no secret.
  if (parsed.INTERNAL_API_ENABLED && !parsed.INTERNAL_API_SERVICE_TOKEN_SECRET) {
    throw new Error(
      'INTERNAL_API_SERVICE_TOKEN_SECRET is required when INTERNAL_API_ENABLED is true.',
    );
  }

  // Fail closed: never boot the s3 object-store driver with no credentials.
  if (parsed.OBJECT_STORE_DRIVER === 's3' && (!parsed.S3_ACCESS_KEY || !parsed.S3_SECRET_KEY)) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY are required when OBJECT_STORE_DRIVER=s3.');
  }

  assertMailAuthPairing(parsed);

  return Object.freeze({ ...parsed, AUTH_JWT_SECRET: authJwtSecret, KEY_RING_PATH: keyRingPath });
}

/** The process-wide config singleton, parsed once from real `process.env`. */
export const config: Config = loadConfig();
