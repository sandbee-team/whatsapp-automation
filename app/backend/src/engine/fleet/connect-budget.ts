import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { sysKey } from '../../platform/redis/keys.js';
import type { ConnectGate, ConnectGateTakeOptions } from '../session/connect-gate.js';

export { xxhash32 } from './xxhash32.js';
import { xxhash32 } from './xxhash32.js';

/**
 * connect-budget.ts (P09 Unit U2 step 4) - the fleet-wide connect rate
 * budget: a Redis token bucket at `sysKey(env, 'sys', 'tb', 'connect')`
 * shared by every worker, composed behind the SAME `ConnectGate` interface
 * the per-worker gate already implements (P08's handoff: callers - the
 * session runner - never see the difference), plus the deterministic
 * per-instance connect-offset and the `PROVIDER_OUTAGE` freeze.
 *
 * Fail-safe (core invariant 2): a Redis error/timeout on the fleet-token
 * take is NEVER treated as "proceed anyway" - a stampede is worse than a
 * stall, so the error propagates and the caller retries/backs off, it never
 * bypasses the gate.
 */

const RATE_FLOOR = 8;
const RATE_CEILING = 40;
const RATE_DIVISOR = 300;
const OFFSET_MODULUS = 60_000;

/** `clamp(desiredOnline / 300, 8, 40)`, floored to an integer connects/s. */
export function computeConnectRatePerSec(desiredOnline: number): number {
  const raw = desiredOnline / RATE_DIVISOR;
  const clamped = Math.min(RATE_CEILING, Math.max(RATE_FLOOR, raw));
  return Math.floor(clamped);
}

/** Deterministic per-instance connect stagger offset, in [0, 60_000)ms. Pure xxHash32 - decorrelated from the FNV-1a reconnect stagger on purpose (phase pin). */
export function instanceConnectOffsetMs(instanceId: string): number {
  return xxhash32(instanceId) % OFFSET_MODULUS;
}

// ---------------------------------------------------------------------
// PROVIDER_OUTAGE tracking: 1-minute disconnect-count buckets, 5 live
// buckets (a 5-minute sliding window), freeze flag with TTL.
// ---------------------------------------------------------------------

const OUTAGE_BUCKET_COUNT = 5;
/** TTL a real `OutageRedisPort.incrBucket` implementation should EXPIRE each minute-bucket key with (one bucket-width of slack past the 5-minute window) - exported for that implementation, not consumed by this in-memory-agnostic tracker. */
export const OUTAGE_BUCKET_TTL_SECONDS = 6 * 60;
/** TTL a real `OutageRedisPort.setFreezeFlag` implementation should set/refresh on the freeze flag key. */
export const OUTAGE_FREEZE_TTL_SECONDS = 5 * 60;
const OUTAGE_THRESHOLD_FRACTION = 0.2;
export const FROZEN_RATE_PER_SEC = 2;

export interface OutageRedisPort {
  incrBucket(key: string): Promise<number>;
  sumBuckets(keys: string[]): Promise<number>;
  setFreezeFlag(key: string): Promise<void>;
  isFreezeFlagSet(key: string): Promise<boolean>;
}

export interface CreateOutageTrackerOptions {
  redis: OutageRedisPort;
  env: string;
  getDesiredOnline(): Promise<number>;
  /** Monotonic-ish minute clock - only used to bucket by minute, real wall time in production. */
  now(): number;
}

export interface OutageTracker {
  noteDisconnect(code: number): Promise<void>;
  isProviderOutage(): Promise<boolean>;
}

/**
 * SUGGESTION FIX 11: keyed by the ABSOLUTE minute stamp, never
 * `minuteIndex % OUTAGE_BUCKET_COUNT` - the old modulo scheme reused the
 * SAME Redis key for every minute exactly `OUTAGE_BUCKET_COUNT` (5) apart,
 * so a bucket's `EXPIRE` (`OUTAGE_BUCKET_TTL_SECONDS`, 6 minutes of slack)
 * could still be live when the NEXT 5-minutes-later cycle reused that same
 * key, silently accumulating a stale count from 5 minutes ago into the
 * current disconnect tally (a false-positive-prone outage-freeze trigger).
 * Keying by the raw minute stamp makes every live minute's key unique - the
 * TTL alone now governs expiry, with no key-collision window.
 */
function bucketKey(env: string, minuteIndex: number): string {
  return sysKey(env, 'sys', 'tb', 'connect', 'outage', String(minuteIndex));
}

function freezeKey(env: string): string {
  return sysKey(env, 'sys', 'tb', 'connect', 'outage', 'freeze');
}

export function createOutageTracker(options: CreateOutageTrackerOptions): OutageTracker {
  const { redis, env, getDesiredOnline, now } = options;

  function currentMinuteIndex(): number {
    return Math.floor(now() / 60_000);
  }

  function liveBucketKeys(): string[] {
    const minute = currentMinuteIndex();
    const keys: string[] = [];
    for (let i = 0; i < OUTAGE_BUCKET_COUNT; i++) {
      keys.push(bucketKey(env, minute - i));
    }
    return keys;
  }

  return {
    async noteDisconnect(code: number): Promise<void> {
      if (code !== 503) {
        return;
      }
      await redis.incrBucket(bucketKey(env, currentMinuteIndex()));

      const desiredOnline = await getDesiredOnline();
      const sum = await redis.sumBuckets(liveBucketKeys());
      if (desiredOnline > 0 && sum > desiredOnline * OUTAGE_THRESHOLD_FRACTION) {
        await redis.setFreezeFlag(freezeKey(env));
      }
    },

    async isProviderOutage(): Promise<boolean> {
      return redis.isFreezeFlagSet(freezeKey(env));
    },
  };
}

// ---------------------------------------------------------------------
// Fleet token bucket (real Redis, Lua-backed atomic take).
// ---------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(HERE, 'scripts');
const TAKE_TOKEN_LUA = readFileSync(path.join(SCRIPTS_DIR, 'take-token.lua'), 'utf8');

interface RedisWithFleetConnectCommands extends Redis {
  wpFleetConnectTake?(...args: (string | number)[]): Promise<number>;
}

export interface FleetTokenBucket {
  /** Attempts to take one token; resolves `true`/`false`, NEVER swallows a Redis error (fail-safe: caller decides retry/backoff, the gate never bypasses on error). */
  take(): Promise<boolean>;
}

export interface CreateFleetTokenBucketOptions {
  redis: Redis;
  env: string;
  /** Sustained rate AND bucket capacity, connects/s. Recompute and pass a fresh value each call if `desiredOnline` / outage state can change between takes. */
  getRatePerSec(): Promise<number>;
  ttlMs?: number;
}

/** Bucket capacity == rate (one second of tokens) - observed connects/s can never exceed the configured rate. */
export function createFleetTokenBucket(options: CreateFleetTokenBucketOptions): FleetTokenBucket {
  const { redis, env, getRatePerSec, ttlMs = 60_000 } = options;
  const client = redis as RedisWithFleetConnectCommands;
  if (typeof client.wpFleetConnectTake !== 'function') {
    redis.defineCommand('wpFleetConnectTake', { lua: TAKE_TOKEN_LUA, numberOfKeys: 1 });
  }
  const key = sysKey(env, 'sys', 'tb', 'connect');

  return {
    async take(): Promise<boolean> {
      const rate = await getRatePerSec();
      const result = await client.wpFleetConnectTake!(key, rate, ttlMs);
      return result === 1;
    },
  };
}

// ---------------------------------------------------------------------
// Fleet-wide ConnectGate: composes the per-worker gate AND the fleet
// bucket behind ONE ConnectGate, swappable in for the plain per-worker
// gate everywhere the session runner calls `take()`.
// ---------------------------------------------------------------------

/** Named abort error - CRITICAL 3 fix: `take()` rejects promptly with this when its signal aborts, instead of parking forever. */
export class ConnectGateAbortedError extends Error {
  constructor() {
    super('ConnectGate.take() aborted');
    this.name = 'ConnectGateAbortedError';
  }
}

/**
 * CRITICAL 3 fix - per-attempt deadline for the fleet-bucket retry loop: a
 * `PROVIDER_OUTAGE` freeze (or any sustained empty-bucket condition) plus a
 * SIGTERM used to leave `take()`'s bare `for(;;)` retrying every
 * `retryDelayMs` with NO deadline and NO cancellation, so a parked chain
 * outlived its own lease's release and `onWait` could accumulate one
 * unbounded observation per taker. Deliberately NOT a lease-release-on-
 * expiry design (the reviewer's alternative): releasing leases under a
 * freeze would mass-churn ownership right when the freeze's whole point is
 * to keep ownership stable and connect slowly - so an attempt that hits the
 * deadline below simply closes out its OWN wait observation (bounded, never
 * one giant unbounded sample) and re-queues into a fresh attempt, staying
 * parked until either a token appears or the caller's `signal` aborts.
 */
const FLEET_TAKE_ATTEMPT_DEADLINE_MS = 60_000;

export interface CreateFleetConnectGateOptions {
  perWorkerGate: ConnectGate;
  fleetBucket: Pick<FleetTokenBucket, 'take'>;
  /** Records total seconds spent waiting for a fleet token (wired to a histogram elsewhere - this module never imports metrics). Called once per bounded attempt-deadline rollover in addition to once on final success, so no single observation is unbounded. */
  onWait(seconds: number): void;
  /** Injected sleep for the retry loop - real `setTimeout`-backed promise in production, a no-op/instant resolver in tests. */
  sleepMs(ms: number): Promise<void>;
  /** Delay between fleet-token retry attempts, ms. Defaults to 100ms. */
  retryDelayMs?: number;
  /** Per-attempt wait deadline before an observation is closed out and the loop re-queues - defaults to `FLEET_TAKE_ATTEMPT_DEADLINE_MS` (60s). Exposed for tests only. */
  attemptDeadlineMs?: number;
}

/**
 * `take()` = per-worker token AND fleet token. A fleet-bucket error
 * propagates (never bypasses); an empty bucket retries with a short delay
 * and records the wait. CRITICAL 3 fix: accepts an optional `{signal}` -
 * aborting rejects promptly with `ConnectGateAbortedError` rather than
 * leaving the taker parked forever, and each attempt is capped at
 * `attemptDeadlineMs` so no single `onWait` sample is unbounded (the loop
 * keeps retrying past the deadline, it does not give up - only the
 * observation is closed out early).
 */
export function createFleetConnectGate(options: CreateFleetConnectGateOptions): ConnectGate {
  const {
    perWorkerGate,
    fleetBucket,
    onWait,
    sleepMs,
    retryDelayMs = 100,
    attemptDeadlineMs = FLEET_TAKE_ATTEMPT_DEADLINE_MS,
  } = options;

  return {
    async take(takeOptions?: ConnectGateTakeOptions): Promise<void> {
      const signal = takeOptions?.signal;
      if (signal?.aborted) {
        throw new ConnectGateAbortedError();
      }

      await perWorkerGate.take();

      let waitedMs = 0;
      let attemptStartedMs = 0;

      for (;;) {
        if (signal?.aborted) {
          if (waitedMs > 0) {
            onWait(waitedMs / 1000);
          }
          throw new ConnectGateAbortedError();
        }

        const got = await fleetBucket.take();
        if (got) {
          if (waitedMs > 0) {
            onWait(waitedMs / 1000);
          }
          return;
        }

        await sleepMs(retryDelayMs);
        waitedMs += retryDelayMs;
        attemptStartedMs += retryDelayMs;

        if (attemptStartedMs >= attemptDeadlineMs) {
          // Bounded-observation rollover (CRITICAL 3): close out this
          // attempt's wait sample now rather than let it grow unbounded,
          // then keep waiting - the token is still spent exactly once,
          // still strictly before the caller opens a socket, never bypassed.
          onWait(waitedMs / 1000);
          waitedMs = 0;
          attemptStartedMs = 0;
        }
      }
    },
  };
}
