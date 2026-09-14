import type { RateLimitResult, RateLimiter } from '../../platform/http/rate-limit.js';

/**
 * rate-limits.ts (go-live U3) - the API-key request-auth-path rate limits,
 * built on the EXISTING shared limiter (`platform/http/rate-limit.ts`'s
 * Redis Lua token bucket, already wired in `roles/api.ts`). Two scopes per
 * call, both `failClosed: true` (core invariant 2 - a limiter that fails
 * open is not a limiter):
 *   - `key:<apiKeyId>` - per-key budget, 60/min.
 *   - `tenant:<clientId>:api` - per-tenant budget across all of a tenant's
 *     keys combined, 300/min, so no single key can exceed what the tenant
 *     itself is entitled to regardless of how many keys it has issued.
 *
 * These numbers (60/min, 300/min) are CONSERVATIVE DEFAULTS for the go-live
 * cut, never a product promise - they must not appear in marketing copy
 * (see wp-architecture canon: no delivery-speed/capacity promises).
 */

const KEY_SCOPE_CAPACITY = 60;
const KEY_SCOPE_REFILL_PER_SEC = 1; // 60/min
const TENANT_SCOPE_CAPACITY = 300;
const TENANT_SCOPE_REFILL_PER_SEC = 5; // 300/min

export interface ApiKeyRateLimitInput {
  apiKeyId: string;
  clientId: string;
}

/** Consumes one token from both the per-key and per-tenant buckets in a single atomic call ("strictest wins" - see rate-limit.ts). On deny, the caller maps `result.retryAfterMs` to the response's `Retry-After` header and returns 429. */
export async function consumeApiKeyRateLimit(
  limiter: RateLimiter,
  input: ApiKeyRateLimitInput,
): Promise<RateLimitResult> {
  return limiter.consume([
    {
      key: `key:${input.apiKeyId}`,
      capacity: KEY_SCOPE_CAPACITY,
      refillPerSec: KEY_SCOPE_REFILL_PER_SEC,
      failClosed: true,
    },
    {
      key: `tenant:${input.clientId}:api`,
      capacity: TENANT_SCOPE_CAPACITY,
      refillPerSec: TENANT_SCOPE_REFILL_PER_SEC,
      failClosed: true,
    },
  ]);
}
