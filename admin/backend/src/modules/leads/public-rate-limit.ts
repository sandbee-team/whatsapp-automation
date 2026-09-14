import type { FastifyReply } from 'fastify';

/**
 * modules/leads/public-rate-limit.ts (P29 U4b) - the rate limiter guarding
 * the ONE unauthenticated write route in admin-backend. A token bucket per
 * key, injected time (never `Date.now()` read directly), and a bounded map
 * - the same shape `staff-auth/lockout.ts`'s `IpAttemptWindow` uses, and the
 * same HONEST LIMITATION: this state is PROCESS-LOCAL. That is correct for
 * v1 because admin-api runs as a single process (ADR 0014), so process-local
 * IS global here; if admin-api is ever scaled to more than one replica this
 * must move to Redis, exactly as `lockout.ts`'s own header notes for the
 * per-IP login window.
 *
 * There is deliberately no escape hatch of any kind anywhere in this file -
 * a rate limiter with an inert override is worse than no rate limiter at
 * all, because it reads as protection while providing none.
 *
 * PRIMARY LIMITATION - `req.ip` behind a reverse proxy: both this limiter and
 * `bot-guard.ts#hashIp` key on Fastify's `req.ip`. With `ADMIN_TRUST_PROXY`
 * false (the default), `req.ip` behind any reverse proxy is the PROXY's own
 * address for every visitor - the per-IP bucket collapses into one shared
 * bucket for the whole site, and the stored `ip_hash` is the proxy's, not the
 * visitor's. With `ADMIN_TRUST_PROXY` true and no trusted proxy actually in
 * front of admin-api, `X-Forwarded-For` is caller-supplied and trivially
 * spoofable, defeating the per-IP bucket entirely. Production MUST run
 * behind a reverse proxy that overwrites (never appends to) `X-Forwarded-For`
 * AND set `ADMIN_TRUST_PROXY=true` - only that combination gives a real,
 * unspoofable per-visitor address. Either way, the GLOBAL bucket
 * (`PublicLeadsRateLimiter#global`) is the backstop: it caps total submission
 * volume regardless of whether the per-IP bucket is degraded to a single
 * shared bucket.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  scope: 'ip' | 'global';
}

/** Per-key token bucket with injected time; keys are bounded and fully-refilled entries are evicted so a spray of one-shot IPs cannot grow the map without limit. */
export class PublicTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAtMs: number }>();
  private static readonly MAX_KEYS = 10_000;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
  ) {}

  /** Current key count - test-only visibility into the eviction invariant below. */
  get size(): number {
    return this.buckets.size;
  }

  take(key: string, now: Date): { allowed: boolean; remaining: number; resetSeconds: number } {
    const nowMs = now.getTime();
    const existing = this.buckets.get(key) ?? { tokens: this.capacity, updatedAtMs: nowMs };
    const elapsedSeconds = Math.max(0, (nowMs - existing.updatedAtMs) / 1000);
    const refilled = Math.min(
      this.capacity,
      existing.tokens + elapsedSeconds * this.refillPerSecond,
    );

    const allowed = refilled >= 1;
    const tokensAfter = allowed ? refilled - 1 : refilled;
    this.buckets.set(key, { tokens: tokensAfter, updatedAtMs: nowMs });

    if (this.buckets.size > PublicTokenBucket.MAX_KEYS) {
      for (const [existingKey, bucket] of this.buckets) {
        if (bucket.tokens >= this.capacity) this.buckets.delete(existingKey);
      }
    }

    // A spray of distinct one-shot keys (each taking exactly one token) never
    // reaches full-refill, so the sweep above alone cannot bound the map -
    // fall back to evicting the OLDEST entries by `updatedAtMs` until the map
    // is back at `MAX_KEYS`, so bounded memory holds even under that pattern.
    if (this.buckets.size > PublicTokenBucket.MAX_KEYS) {
      const oldestFirst = [...this.buckets.entries()].sort(
        (a, b) => a[1].updatedAtMs - b[1].updatedAtMs,
      );
      const excess = this.buckets.size - PublicTokenBucket.MAX_KEYS;
      for (let i = 0; i < excess; i += 1) {
        this.buckets.delete(oldestFirst[i]![0]);
      }
    }

    const remaining = Math.floor(tokensAfter);
    const deficit = this.capacity - tokensAfter;
    const resetSeconds =
      this.refillPerSecond > 0 ? Math.max(1, Math.ceil(deficit / this.refillPerSecond)) : 1;
    return { allowed, remaining, resetSeconds };
  }
}

/** Strictest-wins across a per-IP bucket and a global bucket - either one being empty rejects the request. */
export class PublicLeadsRateLimiter {
  constructor(
    private readonly now: () => Date,
    private readonly perIp: PublicTokenBucket = new PublicTokenBucket(5, 5 / 3600),
    private readonly global: PublicTokenBucket = new PublicTokenBucket(120, 120 / 3600),
  ) {}

  check(ip: string): RateLimitDecision {
    const at = this.now();
    const ipResult = this.perIp.take(ip, at);
    const globalResult = this.global.take('global', at);

    if (!ipResult.allowed) {
      return {
        allowed: false,
        limit: this.perIp.capacity,
        remaining: ipResult.remaining,
        resetSeconds: ipResult.resetSeconds,
        scope: 'ip',
      };
    }
    if (!globalResult.allowed) {
      return {
        allowed: false,
        limit: this.global.capacity,
        remaining: globalResult.remaining,
        resetSeconds: globalResult.resetSeconds,
        scope: 'global',
      };
    }
    return {
      allowed: true,
      limit: this.perIp.capacity,
      remaining: ipResult.remaining,
      resetSeconds: ipResult.resetSeconds,
      scope: 'ip',
    };
  }
}

/** Thrown by the route handler when `PublicLeadsRateLimiter#check` refuses the request; `error-mapper.ts` maps `RATE_LIMITED` to HTTP 429. */
export class LeadRateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';

  constructor(readonly decision: RateLimitDecision) {
    super('Too many requests. Please try again later.');
    this.name = 'LeadRateLimitedError';
  }
}

/** Sets the standard rate-limit response headers; `Retry-After` is only present when the request was refused. */
export function applyRateLimitHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  reply.header('RateLimit-Limit', String(decision.limit));
  reply.header('RateLimit-Remaining', String(decision.remaining));
  reply.header('RateLimit-Reset', String(decision.resetSeconds));
  if (!decision.allowed) {
    reply.header('Retry-After', String(Math.max(1, decision.resetSeconds)));
  }
}
