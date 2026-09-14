import type { Redis } from 'ioredis';
import type { createPool } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { TIMING } from '@wp/domain';
import { sysKey } from '../../platform/redis/keys.js';

/**
 * discovery-caps.ts (FIX-P09-B split) - the fleet gauges read + worker-cap
 * publish/read section, mechanically extracted out of `discovery.ts` for
 * the max-lines cap. `discovery.ts` still imports this module (keeping it
 * covered by the placement-neutrality/shutdown-purity guards) and
 * re-exports every symbol so existing import paths keep working unchanged.
 * No logic change.
 */

/** WARNING FIX 7: HDEL prune batch size - a large stale-field set (e.g. after a mass worker restart/redeploy) is deleted in bounded chunks rather than one unbounded HDEL call, keeping any single Redis command's argument count/blocking time bounded. */
const HDEL_PRUNE_CHUNK_SIZE = 256;
/** A published worker cap is only summed into fleet headroom while fresher than this. */
const CAP_FRESHNESS_MS = 30_000;

interface FleetGaugesRow extends Record<string, unknown> {
  unowned_count: number;
  desired_online_count: number;
}

export interface FleetGaugesCounts {
  unownedCount: number;
  desiredOnlineCount: number;
}

/** Runs the registered `fleet-gauges.sql` query. */
export async function readFleetGauges(
  pool: Pick<ReturnType<typeof createPool>, 'query'>,
): Promise<FleetGaugesCounts> {
  const query = await loadQuery('fleet-gauges');
  const params = bindQueryParams(query, {});
  const result = await pool.query<FleetGaugesRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new Error('readFleetGauges: fleet-gauges.sql returned no row (expected exactly one)');
  }
  return { unownedCount: row.unowned_count, desiredOnlineCount: row.desired_online_count };
}

// ---------------------------------------------------------------------
// Worker-cap publish/read (Redis hash, ONE key, no SCAN, no per-key TTL).
// ---------------------------------------------------------------------

export function fleetCapsKey(env: string): string {
  return sysKey(env, 'sys', 'fleet', 'caps');
}

export class DiscoveryRedisTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`discovery: '${command}' timed out after ${String(timeoutMs)}ms`);
    this.name = 'DiscoveryRedisTimeoutError';
  }
}

/** Races `run()` against a hard timeout - same shape as `engine/lease/lease-redis.ts`'s own `withTimeout` (duplicated, not imported, to avoid a cross-module deep import of `engine/lease/**` internals for one helper). */
export function withTimeout<T>(
  run: () => Promise<T>,
  command: string,
  timeoutMs: number,
  setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      reject(new DiscoveryRedisTimeoutError(command, timeoutMs));
    }, timeoutMs);

    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        reject(err as Error);
      },
    );
  });
}

export interface PublishWorkerCapInput {
  redis: Redis;
  env: string;
  workerId: string;
  cap: number;
  /** Defaults to `TIMING.redisCommandTimeoutMs`. */
  timeoutMs?: number;
  now?: () => number;
}

/** Publishes this worker's session cap into the shared `sys:fleet:caps` hash as `workerId -> {cap, at}` JSON. */
export async function publishWorkerCap(input: PublishWorkerCapInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? TIMING.redisCommandTimeoutMs;
  const now = input.now ?? Date.now;
  const key = fleetCapsKey(input.env);
  const value = JSON.stringify({ cap: input.cap, at: now() });
  await withTimeout(() => input.redis.hset(key, input.workerId, value), 'hset', timeoutMs);
}

export interface ReadFleetCapacityHeadroomInput {
  redis: Redis;
  env: string;
  desiredOnlineCount: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Sums fields in the `sys:fleet:caps` hash whose `at` is fresh (<= 30s old),
 * pruning stale fields (HDEL) as it reads - no SCAN, no per-key TTL games
 * (task requirement). Returns `Sigma(fresh caps) - desiredOnlineCount`.
 */
export async function readFleetCapacityHeadroom(
  input: ReadFleetCapacityHeadroomInput,
): Promise<number> {
  const timeoutMs = input.timeoutMs ?? TIMING.redisCommandTimeoutMs;
  const now = input.now ?? Date.now;
  const key = fleetCapsKey(input.env);

  const entries = await withTimeout(() => input.redis.hgetall(key), 'hgetall', timeoutMs);

  let capSum = 0;
  const staleFields: string[] = [];

  for (const [workerId, raw] of Object.entries(entries)) {
    let parsed: { cap?: unknown; at?: unknown };
    try {
      parsed = JSON.parse(raw) as { cap?: unknown; at?: unknown };
    } catch {
      staleFields.push(workerId);
      continue;
    }
    const cap = typeof parsed?.cap === 'number' ? parsed.cap : null;
    const at = typeof parsed?.at === 'number' ? parsed.at : null;
    if (cap === null || at === null || now() - at > CAP_FRESHNESS_MS) {
      staleFields.push(workerId);
      continue;
    }
    capSum += cap;
  }

  for (let i = 0; i < staleFields.length; i += HDEL_PRUNE_CHUNK_SIZE) {
    const chunk = staleFields.slice(i, i + HDEL_PRUNE_CHUNK_SIZE);
    await withTimeout(() => input.redis.hdel(key, ...chunk), 'hdel', timeoutMs);
  }

  return capSum - input.desiredOnlineCount;
}
