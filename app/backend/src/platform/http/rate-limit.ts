import type { Redis } from 'ioredis';

/**
 * platform/http/rate-limit.ts (P04a Unit A4) - a Redis-backed token-bucket
 * limiter for the auth route class (login/signup/password-reset). NO HTTP
 * wiring here (headers/plugin registration are a later unit's job) - this
 * exports the core `consume()` primitive only.
 *
 * One atomic Lua script evaluates EVERY scope and only commits token
 * deductions when ALL scopes allow ("strictest wins, consume-all-or-none" -
 * a denied scope must never cost tokens out of another bucket). `ioredis`'s
 * `defineCommand` is what gives us "EVAL once, EVALSHA thereafter" for free:
 * it registers the script under a command name, tracks its SHA, and
 * transparently falls back to a full `EVAL` only on a `NOSCRIPT` miss (e.g.
 * after a Redis restart flushed the script cache).
 */

export interface RateLimitScope {
  /** Fully-qualified bucket key, e.g. `wp:dev:rl:ip:{ip}:login`. */
  key: string;
  capacity: number;
  refillPerSec: number;
  /**
   * Fail-safe (core invariant 2): when Redis is unreachable/errors, a
   * `failClosed` scope makes the WHOLE `consume()` call deny rather than
   * allow-on-error. Read-route rate limits (fail-open) are out of this
   * unit's scope - callers there simply omit this flag today.
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  limit: number;
  remaining: number;
  resetMs: number;
}

export interface RateLimiter {
  consume(scopes: RateLimitScope[]): Promise<RateLimitResult>;
}

/**
 * KEYS: one per scope (in order). ARGV: capacity_1, refillPerSec_1, ...,
 * capacity_n, refillPerSec_n, nowMs, ttlMs. Each bucket is a Redis hash
 * (`tokens`, `ts`) that lazily initializes to "full" on first sight, refills
 * continuously between calls, and is only ever deducted from when EVERY
 * scope in this call has at least one token available.
 */
const RATE_LIMIT_LUA = `
local n = #KEYS
local now = tonumber(ARGV[2 * n + 1])
local ttl = tonumber(ARGV[2 * n + 2])

local tokens = {}

for i = 1, n do
  local capacity = tonumber(ARGV[2 * i - 1])
  local refillPerSec = tonumber(ARGV[2 * i])
  local data = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tok = tonumber(data[1])
  local ts = tonumber(data[2])
  if tok == nil or ts == nil then
    tok = capacity
    ts = now
  end
  local elapsedSec = (now - ts) / 1000
  if elapsedSec < 0 then
    elapsedSec = 0
  end
  tok = math.min(capacity, tok + elapsedSec * refillPerSec)
  tokens[i] = tok
end

local allowed = true
local maxRetryMs = 0

for i = 1, n do
  if tokens[i] < 1 then
    allowed = false
    local refillPerSec = tonumber(ARGV[2 * i])
    local deficit = 1 - tokens[i]
    local retryMs = math.ceil((deficit / refillPerSec) * 1000)
    if retryMs > maxRetryMs then
      maxRetryMs = retryMs
    end
  end
end

if allowed then
  for i = 1, n do
    tokens[i] = tokens[i] - 1
    redis.call('HMSET', KEYS[i], 'tokens', tokens[i], 'ts', now)
    redis.call('PEXPIRE', KEYS[i], ttl)
  end
end

local result = {}
result[1] = allowed and 1 or 0
result[2] = maxRetryMs
for i = 1, n do
  result[2 + i] = tokens[i]
end
return result
`;

interface RedisWithRateLimitCommand extends Redis {
  wpRateLimitConsume?(...args: (string | number)[]): Promise<number[]>;
}

/** Creates a `RateLimiter` backed by `redis`, defining the Lua command once per connection. */
export function createRateLimiter(redis: Redis): RateLimiter {
  const client = redis as RedisWithRateLimitCommand;
  if (typeof client.wpRateLimitConsume !== 'function') {
    redis.defineCommand('wpRateLimitConsume', { lua: RATE_LIMIT_LUA });
  }

  return {
    async consume(scopes: RateLimitScope[]): Promise<RateLimitResult> {
      if (scopes.length === 0) {
        throw new Error('consume: at least one scope is required');
      }

      const now = Date.now();
      const ttlMs = Math.max(
        60_000,
        ...scopes.map((scope) => Math.ceil((scope.capacity / scope.refillPerSec) * 1000) * 2),
      );
      const keys = scopes.map((scope) => scope.key);
      const argv: (string | number)[] = [];
      for (const scope of scopes) {
        argv.push(scope.capacity, scope.refillPerSec);
      }
      argv.push(now, ttlMs);

      let raw: number[];
      try {
        raw = await client.wpRateLimitConsume!(scopes.length, ...keys, ...argv);
      } catch (err) {
        const failClosedScope = scopes.find((scope) => scope.failClosed);
        if (failClosedScope) {
          return {
            allowed: false,
            retryAfterMs: 1000,
            limit: failClosedScope.capacity,
            remaining: 0,
            resetMs: now + 1000,
          };
        }
        throw err;
      }

      const allowed = raw[0] === 1;
      const retryAfterMs = raw[1] ?? 0;
      const remainders = raw.slice(2);

      // The "strictest" scope (lowest remaining/capacity ratio) is what
      // RateLimit-Limit/Remaining/Reset headers (a later unit's job) should
      // report - the bucket closest to (or already at) empty.
      let primaryIndex = 0;
      let bestRatio = Number.POSITIVE_INFINITY;
      scopes.forEach((scope, i) => {
        const ratio = (remainders[i] ?? 0) / scope.capacity;
        if (ratio < bestRatio) {
          bestRatio = ratio;
          primaryIndex = i;
        }
      });
      const primaryScope = scopes[primaryIndex]!;
      const primaryRemaining = Math.floor(remainders[primaryIndex] ?? 0);
      const resetMs =
        now +
        Math.ceil(
          ((primaryScope.capacity - (remainders[primaryIndex] ?? 0)) / primaryScope.refillPerSec) *
            1000,
        );

      return {
        allowed,
        retryAfterMs,
        limit: primaryScope.capacity,
        remaining: primaryRemaining,
        resetMs,
      };
    },
  };
}
