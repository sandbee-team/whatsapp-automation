import { describe, expect, it, vi } from 'vitest';
import type { RateLimitResult, RateLimiter } from '../../platform/http/rate-limit.js';
import { consumeApiKeyRateLimit } from './rate-limits.js';

/**
 * rate-limits.test.ts (go-live U3) - proves `consumeApiKeyRateLimit` calls
 * the shared limiter with exactly the two documented scopes
 * (`key:<apiKeyId>` at 60/min, `tenant:<clientId>:api` at 300/min) and
 * `failClosed: true` on both (a limiter that fails open is not a limiter -
 * core invariant 2), and passes the limiter's own result straight through.
 */

function limiterReturning(result: RateLimitResult): RateLimiter {
  return { consume: vi.fn(async () => result) };
}

describe('consumeApiKeyRateLimit', () => {
  it('consumes_exactly_the_key_and_tenant_scopes_with_failClosed_true', async () => {
    const result: RateLimitResult = {
      allowed: true,
      retryAfterMs: 0,
      limit: 60,
      remaining: 59,
      resetMs: 1000,
    };
    const limiter = limiterReturning(result);

    const out = await consumeApiKeyRateLimit(limiter, {
      apiKeyId: 'key-1',
      clientId: 'client-1',
    });

    expect(out).toBe(result);
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    expect(limiter.consume).toHaveBeenCalledWith([
      { key: 'key:key-1', capacity: 60, refillPerSec: 1, failClosed: true },
      { key: 'tenant:client-1:api', capacity: 300, refillPerSec: 5, failClosed: true },
    ]);
  });

  it('a_denied_result_still_passes_through_retryAfterMs_for_the_caller_to_set_Retry_After', async () => {
    const result: RateLimitResult = {
      allowed: false,
      retryAfterMs: 4200,
      limit: 60,
      remaining: 0,
      resetMs: 5000,
    };
    const limiter = limiterReturning(result);

    const out = await consumeApiKeyRateLimit(limiter, {
      apiKeyId: 'key-1',
      clientId: 'client-1',
    });

    expect(out.allowed).toBe(false);
    expect(out.retryAfterMs).toBe(4200);
  });
});
