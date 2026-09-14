import { describe, expect, it } from 'vitest';
import {
  PublicTokenBucket,
  PublicLeadsRateLimiter,
  applyRateLimitHeaders,
  LeadRateLimitedError,
} from './public-rate-limit.js';

/**
 * public-rate-limit.test.ts (P29 session 1, E3 hardening) - pure token
 * bucket arithmetic and concurrency invariants for the public lead
 * endpoint's rate limiter. Complements the route-level test in
 * `leads.routes.test.ts` (which proves the 429 status/headers over HTTP);
 * this file proves the underlying bucket math at exact boundaries and under
 * synchronous concurrent callers, per SESSION-PROTOCOL C2.
 */

const START = new Date('2026-09-08T12:00:00.000Z');

describe('public_token_bucket_concurrency', () => {
  it('200_synchronous_calls_from_one_ip_at_the_same_instant_allow_exactly_5', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 200; i += 1) {
      const result = bucket.take('same-ip', START);
      if (result.allowed) allowed += 1;
      else denied += 1;
    }
    expect(allowed).toBe(5);
    expect(denied).toBe(195);
  });

  it('two_ips_interleaved_never_steal_each_others_tokens', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    const allowedByIp: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 20; i += 1) {
      const ip = i % 2 === 0 ? 'a' : 'b';
      const result = bucket.take(ip, START);
      if (result.allowed) allowedByIp[ip] = (allowedByIp[ip] ?? 0) + 1;
    }
    expect(allowedByIp.a).toBe(5);
    expect(allowedByIp.b).toBe(5);
  });

  it('the_global_bucket_denies_the_121st_call_across_121_distinct_ips_at_the_same_instant', () => {
    const limiter = new PublicLeadsRateLimiter(() => START);
    let allowed = 0;
    let deniedGlobal = 0;
    for (let i = 0; i < 121; i += 1) {
      const decision = limiter.check(`198.51.100.${i}`);
      if (decision.allowed) {
        allowed += 1;
      } else {
        expect(decision.scope).toBe('global');
        deniedGlobal += 1;
      }
    }
    expect(allowed).toBe(120);
    expect(deniedGlobal).toBe(1);
  });

  it('remaining_is_never_negative_under_a_flood_of_calls_past_capacity', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    for (let i = 0; i < 50; i += 1) {
      const result = bucket.take('flooded', START);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('resetSeconds_is_never_0_when_a_call_is_denied', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    for (let i = 0; i < 10; i += 1) {
      const result = bucket.take('boundary-ip', START);
      if (!result.allowed) {
        expect(result.resetSeconds).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('public_token_bucket_refill_boundaries', () => {
  it('exactly_719_seconds_after_exhaustion_no_token_is_back', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    for (let i = 0; i < 5; i += 1) {
      expect(bucket.take('boundary', START).allowed).toBe(true);
    }
    const at719 = new Date(START.getTime() + 719 * 1000);
    const result = bucket.take('boundary', at719);
    expect(result.allowed).toBe(false);
  });

  it('exactly_720_seconds_after_exhaustion_exactly_1_token_is_back', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    for (let i = 0; i < 5; i += 1) {
      expect(bucket.take('boundary2', START).allowed).toBe(true);
    }
    const at720 = new Date(START.getTime() + 720 * 1000);
    const first = bucket.take('boundary2', at720);
    expect(first.allowed).toBe(true);
    const second = bucket.take('boundary2', at720);
    expect(second.allowed).toBe(false);
  });

  it('a_new_key_starts_at_full_capacity', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    const result = bucket.take('brand-new-ip', START);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });
});

describe('public_token_bucket_max_keys_eviction', () => {
  it('10500_distinct_one_shot_keys_at_the_same_instant_never_exceed_max_keys_and_keep_the_most_recent', () => {
    const bucket = new PublicTokenBucket(5, 5 / 3600);
    const MAX_KEYS = 10_000;
    const total = 10_500;
    for (let i = 0; i < total; i += 1) {
      bucket.take(`one-shot-${i}`, START);
    }
    expect(bucket.size).toBeLessThanOrEqual(MAX_KEYS);

    // The most recent key was already taken from once in the loop above (4
    // of 5 tokens remain there) - if it had instead been evicted, this call
    // would be that key's first-ever `take`, reporting a fresh bucket's
    // `remaining: 4`. It reports `3` (one less than a fresh key would),
    // proving the entry survived eviction rather than being recreated.
    const mostRecentKey = `one-shot-${total - 1}`;
    const afterLoop = bucket.take(mostRecentKey, START);
    expect(afterLoop.remaining).toBe(3);
  });
});

describe('rate_limit_error_and_headers', () => {
  it('LeadRateLimitedError_carries_the_denying_decision_for_the_route_to_map', () => {
    const decision = {
      allowed: false as const,
      limit: 5,
      remaining: 0,
      resetSeconds: 42,
      scope: 'ip' as const,
    };
    const err = new LeadRateLimitedError(decision);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.decision).toBe(decision);
  });

  it('applyRateLimitHeaders_omits_retry_after_when_allowed', () => {
    const headers: Record<string, string> = {};
    const fakeReply = {
      header: (name: string, value: string) => {
        headers[name] = value;
      },
    };
    applyRateLimitHeaders(fakeReply as never, {
      allowed: true,
      limit: 5,
      remaining: 3,
      resetSeconds: 1,
      scope: 'ip',
    });
    expect(headers['Retry-After']).toBeUndefined();
    expect(headers['RateLimit-Limit']).toBe('5');
  });

  it('applyRateLimitHeaders_floors_retry_after_at_1_even_if_resetSeconds_were_0', () => {
    const headers: Record<string, string> = {};
    const fakeReply = {
      header: (name: string, value: string) => {
        headers[name] = value;
      },
    };
    applyRateLimitHeaders(fakeReply as never, {
      allowed: false,
      limit: 5,
      remaining: 0,
      resetSeconds: 0,
      scope: 'ip',
    });
    expect(headers['Retry-After']).toBe('1');
  });
});
