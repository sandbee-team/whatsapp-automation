import type { Redis } from 'ioredis';
import {
  createFleetConnectGate,
  createFleetTokenBucket,
  createOutageTracker,
  computeConnectRatePerSec,
  OUTAGE_BUCKET_TTL_SECONDS,
  OUTAGE_FREEZE_TTL_SECONDS,
  FROZEN_RATE_PER_SEC,
  type OutageRedisPort,
} from './connect-budget.js';
import type { ConnectGate } from '../session/connect-gate.js';

/**
 * fleet-wiring-connect-gate.ts (FIX-P09-B split) - the real
 * `OutageRedisPort` + fleet `ConnectGate` wiring, mechanically extracted out
 * of `fleet-wiring.ts` for the max-lines cap (sections 2-3 of that file's
 * original numbered comment blocks). `fleet-wiring.ts` re-exports both
 * so every existing import path keeps working unchanged.
 */

// ---------------------------------------------------------------------
// 2. Real OutageRedisPort - INCR/EXPIRE-style bucket counters + a freeze
//    flag, keyed via sysKey per connect-budget.ts's own exported TTL
//    constants.
// ---------------------------------------------------------------------

/**
 * Real Redis-backed `OutageRedisPort` (`connect-budget.ts`'s injected port):
 * `incrBucket` = INCR then EXPIRE the bucket key to `OUTAGE_BUCKET_TTL_SECONDS`
 * (six 1-minute buckets' worth of slack past the tracker's own 5-minute
 * live window - a bucket key must outlive the window it participates in);
 * `sumBuckets` = MGET across the live bucket keys, missing keys count as 0;
 * `setFreezeFlag`/`isFreezeFlagSet` = a plain SET with a TTL (`
 * OUTAGE_FREEZE_TTL_SECONDS`) / EXISTS check - the freeze flag's own TTL is
 * its expiry, never cleared explicitly.
 */
export function createRedisOutagePort(redis: Redis): OutageRedisPort {
  return {
    async incrBucket(key: string): Promise<number> {
      const value = await redis.incr(key);
      await redis.expire(key, OUTAGE_BUCKET_TTL_SECONDS);
      return value;
    },
    async sumBuckets(keys: string[]): Promise<number> {
      if (keys.length === 0) {
        return 0;
      }
      const values = await redis.mget(...keys);
      return values.reduce((sum: number, v) => sum + (v ? Number(v) : 0), 0);
    },
    async setFreezeFlag(key: string): Promise<void> {
      await redis.set(key, '1', 'EX', OUTAGE_FREEZE_TTL_SECONDS);
    },
    async isFreezeFlagSet(key: string): Promise<boolean> {
      const exists = await redis.exists(key);
      return exists === 1;
    },
  };
}

// ---------------------------------------------------------------------
// 3. The fleet ConnectGate: composes the per-worker gate + the fleet
//    token bucket + the outage tracker (freeze -> FROZEN_RATE_PER_SEC)
//    behind the SAME ConnectGate interface.
// ---------------------------------------------------------------------

export interface BuildFleetConnectGateOptions {
  perWorkerGate: ConnectGate;
  redis: Redis;
  env: string;
  getDesiredOnline(): Promise<number>;
  onWait(seconds: number): void;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the fleet-wide `ConnectGate` wiring requirement 1 calls for: real
 * Redis outage tracking, `computeConnectRatePerSec(desiredOnline)` normally,
 * `FROZEN_RATE_PER_SEC` while `isProviderOutage()` is true (checked once per
 * `take()`, fail-safe: a Redis error on either the outage check or the
 * fleet-token take propagates, never bypasses the gate - see
 * `connect-budget.ts`'s own module doc).
 */
export function buildFleetConnectGate(options: BuildFleetConnectGateOptions): ConnectGate {
  const { perWorkerGate, redis, env, getDesiredOnline, onWait } = options;
  const sleepMs = options.sleepMs ?? DEFAULT_SLEEP;
  const now = options.now ?? Date.now;

  const outageTracker = createOutageTracker({
    redis: createRedisOutagePort(redis),
    env,
    getDesiredOnline,
    now,
  });

  const fleetBucket = createFleetTokenBucket({
    redis,
    env,
    getRatePerSec: async () => {
      const outage = await outageTracker.isProviderOutage();
      if (outage) {
        return FROZEN_RATE_PER_SEC;
      }
      const desiredOnline = await getDesiredOnline();
      return computeConnectRatePerSec(desiredOnline);
    },
  });

  return createFleetConnectGate({
    perWorkerGate,
    fleetBucket,
    onWait,
    sleepMs,
  });
}
