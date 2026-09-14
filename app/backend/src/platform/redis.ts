import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

/**
 * platform/redis.ts (P04a Unit A4) - the Redis connection port. Queueing,
 * pacing/rate-limit state and locks all live behind this one factory (see
 * `.claude/skills/queue-engineering/SKILL.md` S9: "Redis state is
 * rebuildable; PostgreSQL is the source of truth").
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    // A short connectTimeout plus a single retry (then give up - no
    // reconnect loop) is what lets a command against a genuinely
    // unreachable Redis fail in well under a second instead of hanging or
    // retrying forever - callers that need fail-closed behavior on an
    // unreachable Redis (platform/http/rate-limit.ts's auth scopes) depend
    // on this bound. Commands still queue normally (`enableOfflineQueue`
    // default true) while the FIRST connection attempt is in flight, so a
    // real, merely-not-yet-connected Redis never spuriously errors.
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 300,
    retryStrategy: () => null,
  });
}

// Re-exported so every caller can `import { sysKey, tenantKey } from
// '.../platform/redis.js'` - the actual literal `wp:` construction lives in
// `platform/redis/keys.ts`, the one path the `wp/key-construction` lint rule
// (packages/config/eslint.config.js's KEY_ENTRIES) exempts from the
// raw-`wp:`-literal ban (see scripts/guards/eslint-guards.test.ts's
// `a_raw_wp_key_literal_outside_platform_redis_is_rejected`, which asserts
// the exemption against exactly `platform/redis/keys.ts`) - this flat
// `platform/redis.ts` file itself is NOT exempt (the guard's `ignores` glob
// is directory-shaped), so it never constructs a `wp:` literal directly.
export { sysKey, tenantKey } from './redis/keys.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DEV_ENV_PATH = path.join(REPO_ROOT, '.secrets', 'dev.env');

/**
 * Resolves the Redis URL app-backend integration tests connect with -
 * mirrors `platform/db/db-url.ts` exactly: a real `REDIS_URL` env var wins
 * if set, else this reads `REDIS_PORT` out of `.secrets/dev.env` (the dev
 * stack maps Redis to a non-default localhost port there - see
 * `.memory/auto/dev-stack-ports-this-machine.md`) and builds
 * `redis://127.0.0.1:<port>`. Test-only, like `resolveDatabaseUrl` - never
 * imported by production code.
 */
export function resolveRedisUrl(): string {
  const fromEnv = process.env.REDIS_URL;
  if (fromEnv) {
    return fromEnv;
  }

  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    throw new Error(
      `No REDIS_URL available: set the REDIS_URL env var, or ensure it exists at ${DEV_ENV_PATH}.`,
    );
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (key === 'REDIS_PORT') {
      const port = trimmed.slice(eq + 1).trim();
      return `redis://127.0.0.1:${port}`;
    }
  }

  throw new Error(
    `No REDIS_URL available: set the REDIS_URL env var, or add a REDIS_PORT=... line to ${DEV_ENV_PATH}.`,
  );
}

/**
 * Reads a single `KEY=value` line out of `.secrets/dev.env`, mirroring
 * `resolveRedisUrl`'s own inline parse. Returns `undefined` (never throws) when
 * the line is absent - callers fall back to the base Redis URL.
 */
function readDevEnvPort(key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(DEV_ENV_PATH, 'utf8');
  } catch {
    return undefined;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    if (trimmed.slice(0, eq).trim() === key) {
      return trimmed.slice(eq + 1).trim();
    }
  }

  return undefined;
}

/**
 * Resolves the Redis URL for the SIGNAL tier (noeviction - session,
 * sender-key, identity-key auth material; see `@wp/domain`'s
 * `SIGNAL_KEY_TYPES`). A real `REDIS_SIG_URL` env var wins if set; else a
 * `REDIS_SIG_PORT` line in `.secrets/dev.env`; else this FALLS BACK to
 * `resolveRedisUrl()` - the sig/cache/base split is config, not a rewrite, so
 * a dev box with only one Redis server still boots correctly (all three
 * handles just point at the same server).
 */
export function resolveSigRedisUrl(): string {
  const fromEnv = process.env.REDIS_SIG_URL;
  if (fromEnv) {
    return fromEnv;
  }

  const port = readDevEnvPort('REDIS_SIG_PORT');
  if (port) {
    return `redis://127.0.0.1:${port}`;
  }

  return resolveRedisUrl();
}

/**
 * Resolves the Redis URL for the CACHE tier (allkeys-lru-eligible -
 * rebuildable auth material; see `@wp/domain`'s `REBUILDABLE_KEY_TYPES`). Same
 * resolution order/fallback shape as `resolveSigRedisUrl`.
 */
export function resolveCacheRedisUrl(): string {
  const fromEnv = process.env.REDIS_CACHE_URL;
  if (fromEnv) {
    return fromEnv;
  }

  const port = readDevEnvPort('REDIS_CACHE_PORT');
  if (port) {
    return `redis://127.0.0.1:${port}`;
  }

  return resolveRedisUrl();
}
