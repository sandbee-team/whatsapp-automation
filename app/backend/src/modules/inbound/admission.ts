import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import type { TenantDb } from '@wp/db';
import { tenantKey } from '../../platform/redis/keys.js';
import { bindInboundMetrics, type InboundMetricsHandles } from './metrics.js';

/**
 * admission.ts (P21 Unit U5, step 6) - the per-instance inbound admission
 * token bucket on `redis-ctl`. Above the ceiling the event is dropped
 * BEFORE any processing (counted on `wp_inbound_shed_total`), never queued
 * in memory and never retried into a growing backlog - shedding here is a
 * fairness control, not a safety control (core invariant 2 is about SEND
 * safety; this module never touches a send path). Receipts are never shed -
 * the bucket applies to message events only; callers must not route receipt
 * events through `admit()`.
 *
 * Fail-safe DIRECTION here is deliberately the opposite of a send-path
 * degrade: a Redis error/timeout on the bucket take FAILS OPEN (the event is
 * processed anyway, counted on `wp_inbound_admission_fail_open_total`) -
 * losing an inbound receipt/opt-out signal because Redis hiccuped is worse
 * than a temporary loss of fairness shedding.
 *
 * KEY SHAPE: `tenantKey(env, clientId, 'inbound', 'i', instanceId)` - never a
 * raw `wp:` literal (the `wp/key-construction` guard only exempts
 * `platform/redis/**`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUA_DIR = path.join(HERE, '..', '..', 'platform', 'redis', 'lua');
const INBOUND_BUCKET_LUA = readFileSync(path.join(LUA_DIR, 'inbound-bucket.lua'), 'utf8');

export type AdmissionDecision = 'admitted' | 'shed';

export interface InboundBucketPort {
  /** Returns 1 = admit, 0 = shed. Throws on Redis error/timeout. */
  take(
    key: string,
    capacity: number,
    refillPerMinute: number,
    nowMs: number,
    ttlMs: number,
  ): Promise<number>;
}

interface RedisWithInboundAdmitCommand extends Redis {
  wpInboundAdmit?(...args: (string | number)[]): Promise<number>;
}

class InboundBucketTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`inbound admission bucket take timed out after ${String(timeoutMs)}ms`);
    this.name = 'InboundBucketTimeoutError';
  }
}

/**
 * `defineCommand('wpInboundAdmit')` once per client (guarded re-definition,
 * same idempotent pattern as `createLeaseRedis`), wrapping the call in a
 * hard timeout (default 500ms) that REJECTS on expiry - a slow Redis must
 * not stall the inbound socket handler.
 */
export function bindInboundBucketCommand(
  redis: Redis,
  options?: { timeoutMs?: number },
): InboundBucketPort {
  const timeoutMs = options?.timeoutMs ?? 500;
  const client = redis as RedisWithInboundAdmitCommand;
  if (typeof client.wpInboundAdmit !== 'function') {
    redis.defineCommand('wpInboundAdmit', { lua: INBOUND_BUCKET_LUA, numberOfKeys: 1 });
  }

  return {
    async take(
      key: string,
      capacity: number,
      refillPerMinute: number,
      nowMs: number,
      ttlMs: number,
    ): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new InboundBucketTimeoutError(timeoutMs));
        }, timeoutMs);

        client.wpInboundAdmit!(key, capacity, refillPerMinute, nowMs, ttlMs).then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          (err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err as Error);
          },
        );
      });
    },
  };
}

export interface InboundAdmissionDeps {
  env: string;
  bucket: InboundBucketPort;
  /** Reads whatsapp_instances.inbound_max_per_minute for one instance; null when the row is missing or the read fails. */
  readLimit: (clientId: string, instanceId: string) => Promise<number | null>;
  defaults: { maxPerMinute: number; burst: number };
  clock?: () => number;
  limitCacheMs?: number;
  metrics?: InboundMetricsHandles;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

/** A resolved limit must be a real capacity: `0`, negative or non-integer would silently become "shed everything" (or a fractional bucket) if passed through unchecked. */
function isValidLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

export interface InboundAdmission {
  admit(clientId: string, instanceId: string): Promise<AdmissionDecision>;
}

const DEFAULT_LIMIT_CACHE_MS = 60_000;
const BUCKET_TTL_MS = 120_000;

interface CachedLimit {
  limit: number;
  cachedAtMs: number;
}

/**
 * `admit()` resolves the per-instance limit (cached per `client:instance`
 * for `limitCacheMs` using the injected clock; `readLimit` -> a number, or
 * `defaults.maxPerMinute` when null OR when the read value is not a
 * positive integer - `0`/negative/fractional would otherwise become the
 * real capacity via nullish coalescing, i.e. "shed everything"; the
 * fallback is counted on `wp_inbound_limit_fallback_total` and warned with
 * ids only). Capacity: burst is a full minute's
 * worth by default, so capacity = `limit` UNLESS `defaults.burst` is
 * SMALLER than the resolved limit, in which case `defaults.burst` caps it
 * (capacity = `min(defaults.burst, limit)`) - a platform-set burst ceiling
 * always wins over a looser per-instance DB value. Refill = `limit` tokens
 * per minute (the refill rate always tracks the real per-instance limit,
 * never the burst cap). `bucket.take()` result: 1 -> 'admitted'; 0 ->
 * `inboundShedTotal.inc()`, 'shed'; a thrown error (timeout, connection) ->
 * `inboundAdmissionFailOpenTotal.inc()`, warn with `{client_id, instance_id,
 * err: name-only}`, 'admitted'. Nothing is buffered, queued or retried.
 */
export function createInboundAdmission(deps: InboundAdmissionDeps): InboundAdmission {
  const clock = deps.clock ?? Date.now;
  const limitCacheMs = deps.limitCacheMs ?? DEFAULT_LIMIT_CACHE_MS;
  const metrics = deps.metrics ?? bindInboundMetrics();
  const cache = new Map<string, CachedLimit>();

  async function resolveLimit(clientId: string, instanceId: string): Promise<number> {
    const cacheKey = `${clientId}:${instanceId}`;
    const now = clock();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.cachedAtMs < limitCacheMs) {
      return cached.limit;
    }

    const read = await deps.readLimit(clientId, instanceId);
    let limit = read ?? deps.defaults.maxPerMinute;
    if (!isValidLimit(limit)) {
      metrics.inboundLimitFallbackTotal.inc();
      deps.logger?.warn(
        { client_id: clientId, instance_id: instanceId },
        'inbound admission: readLimit returned a non-positive-integer value, falling back to the platform default',
      );
      limit = deps.defaults.maxPerMinute;
    }
    cache.set(cacheKey, { limit, cachedAtMs: now });
    return limit;
  }

  return {
    async admit(clientId: string, instanceId: string): Promise<AdmissionDecision> {
      const limit = await resolveLimit(clientId, instanceId);
      const capacity = Math.min(deps.defaults.burst, limit);
      const key = tenantKey(deps.env, clientId, 'inbound', 'i', instanceId);

      try {
        const result = await deps.bucket.take(key, capacity, limit, clock(), BUCKET_TTL_MS);
        if (result === 1) {
          return 'admitted';
        }
        metrics.inboundShedTotal.inc();
        return 'shed';
      } catch (err) {
        metrics.inboundAdmissionFailOpenTotal.inc();
        const name = err instanceof Error ? err.name : 'unknown';
        deps.logger?.warn(
          { client_id: clientId, instance_id: instanceId, err: name },
          'inbound admission bucket failed open',
        );
        return 'admitted';
      }
    },
  };
}

/** SELECT inbound_max_per_minute FROM whatsapp_instances WHERE client_id = $1 AND id = $2, inside withTenant(clientId). Catches and returns null (missing row, or any read failure). */
export function readInboundLimitFromDb(tenantDb: TenantDb): InboundAdmissionDeps['readLimit'] {
  return async (clientId: string, instanceId: string): Promise<number | null> => {
    try {
      return await tenantDb.withTenant(clientId, async (tx) => {
        const result = await tx.query<{ inbound_max_per_minute: number }>(
          'SELECT inbound_max_per_minute FROM whatsapp_instances WHERE client_id = $1 AND id = $2',
          [clientId, instanceId],
        );
        return result.rows[0]?.inbound_max_per_minute ?? null;
      });
    } catch {
      return null;
    }
  };
}
