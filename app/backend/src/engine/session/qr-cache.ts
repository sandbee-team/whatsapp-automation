import type { Redis } from 'ioredis';
import { tenantKey } from '../../platform/redis.js';

/**
 * qr-cache.ts (2026-09-22 "first QR lost" fix, Task 1) - the REST fallback's
 * write side: persists the CURRENT QR/pairing-code challenge to Redis so
 * `GET /v1/instances/:id/link-status` can serve it even when no SSE
 * connection was subscribed in time to receive the live push.
 *
 * BACKGROUND (see `.memory/lessons` for the two failed prior attempts): the
 * Connect sheet opened showing an empty QR circle because the FIRST
 * `instance.qr` publish (`pairing.ts`'s `handleAttempt`) could race a
 * browser that had not yet finished subscribing to the per-instance SSE
 * channel - true even after fixing the missing Redis bridge subscriber and
 * adding a replay ring, because both fixes only tightened the PUSH path.
 * Every mature Baileys deployment researched (baileys-api, WPPConnect-
 * server, Evolution API) instead caches the current QR server-side and
 * serves it from a plain REST GET, with push as a latency convenience only
 * - never the sole source of truth. This module is that cache.
 *
 * REDIS TIER: `redisCtl` (the "control connection", same tier
 * `engine/queue/wake.ts` uses for its own ephemeral control-plane
 * signalling) - deliberately NOT `redisSig` (durable Signal/auth-material,
 * noeviction) or `redisCache` (rebuildable auth material, allkeys-lru
 * EVICTION-eligible under memory pressure, which is the wrong fit for a
 * short-lived value this fix depends on actually surviving until the next
 * poll/GET). A QR is a BEARER CREDENTIAL like the Signal keys, but it is
 * NOT auth state Baileys itself needs read back - persisting it does not
 * belong in `provider/baileys/auth-state/**`, so it does not ride the sig/
 * cache split those modules exist for.
 *
 * TTL: set to expire at the SAME `expiresAt` the SSE payload already
 * carries (`pairing.ts`'s `qrTtlMs`, 90s) - never longer. A QR is a
 * credential; it must not linger in Redis past the window the panel itself
 * already promises the operator. `PEXPIRE`-equivalent precision (`PX`, not
 * `EX`) because the window is UX-sized (90s), not day-sized, and a
 * key that outlives its own `expiresAt` by up to 999ms is an acceptable
 * rounding error, never a meaningfully stale credential.
 *
 * KEY SHAPE: `tenantKey(env, clientId, 'qr', instanceId)` - client-scoped
 * (core invariant 4: tenant isolation) exactly like `card.service.ts`'s own
 * `instance-card-queue` cache key.
 *
 * FAIL-OPEN ON WRITE, same discipline as `card.service.ts`'s own cache
 * write: a Redis error here must NEVER throw into `handleAttempt`'s publish
 * path (SSE delivery, which is unaffected by Redis being down, must keep
 * working) - it only means the REST fallback has nothing to serve back
 * until the next QR attempt succeeds in writing through.
 */

export interface QrCacheRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface CachedQr {
  payload: string;
  expiresAt: string;
  attemptsLeft: number;
}

function qrCacheKey(env: string, clientId: string, instanceId: string): string {
  return tenantKey(env, clientId, 'qr', instanceId);
}

/**
 * Writes the current QR/pairing-code challenge, TTL'd to expire alongside
 * `expiresAt`. Called once per `instance.qr` publish (see
 * `roles/session-worker.ts`'s `publish` wrapper, the ONLY call site) -
 * never from `pairing.ts` itself, which stays untouched (SSE path is purely
 * additive here, not modified).
 */
export async function writeQrCache(
  redis: QrCacheRedis | Redis,
  input: { env: string; clientId: string; instanceId: string; qr: CachedQr },
): Promise<void> {
  const ttlMs = new Date(input.qr.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    // Already-expired/garbage expiresAt - never write a key that would
    // immediately (or never) expire; PX requires a positive integer.
    return;
  }
  const key = qrCacheKey(input.env, input.clientId, input.instanceId);
  try {
    await redis.set(key, JSON.stringify(input.qr), 'PX', Math.ceil(ttlMs));
  } catch {
    // Fail-open (see module doc): the SSE push already carried this frame
    // independently - a Redis write failure only narrows the REST fallback
    // window, it never blocks or corrupts the primary publish.
  }
}

/**
 * Reads the current QR back, or `null` if absent/expired/unparseable.
 * Called from `GET /v1/instances/:id/link-status` (`instances.routes.ts`).
 * `expiresAt` is re-checked here even though Redis's own TTL should already
 * have evicted an expired key - defence in depth against clock skew between
 * this process and Redis, matching the brief's "never serve an expired QR"
 * rule server-side, not just client-side.
 */
export async function readQrCache(
  redis: QrCacheRedis | Redis,
  input: { env: string; clientId: string; instanceId: string; now: () => number },
): Promise<CachedQr | null> {
  const key = qrCacheKey(input.env, input.clientId, input.instanceId);
  let raw: string | null;
  try {
    raw = await redis.get(key);
  } catch {
    // Redis down/unreachable - fail open to "no cached QR", same discipline
    // as card.service.ts's own read-side try/catch. The route already
    // tolerates an absent QR (SSE may still deliver it).
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = parsed as Partial<CachedQr> | null;
  if (
    !candidate ||
    typeof candidate.payload !== 'string' ||
    typeof candidate.expiresAt !== 'string' ||
    typeof candidate.attemptsLeft !== 'number'
  ) {
    return null;
  }
  const expiresAtMs = new Date(candidate.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.now()) {
    return null;
  }
  return {
    payload: candidate.payload,
    expiresAt: candidate.expiresAt,
    attemptsLeft: candidate.attemptsLeft,
  };
}
