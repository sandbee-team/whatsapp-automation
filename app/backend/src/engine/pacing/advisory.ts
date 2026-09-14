import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { tenantKey } from '../../platform/redis/keys.js';
import { nextLocalMidnightMs } from './retry-at.js';

/**
 * engine/pacing/advisory.ts (P13 Unit U4, step 8) - the Redis pre-filter
 * ahead of the Postgres reserve, mirroring `db/queries/reserve-pacing.sql`'s
 * `consumed_count` with a plain `INCR` + `EXPIREAT` (at the instance's next
 * local midnight) counter per `(instanceId, ledgerDate)`. Follows this
 * repo's established Lua idiom exactly (`readScript()` + `redis.define
 * Command(...)`, mirroring `engine/lease/lease-redis.ts`/`scripts/
 * acquire.lua`) - see `scripts/reserve-advisory.lua`'s own header for the
 * script's full contract.
 *
 * CAN NEVER GRANT (core invariant 2/3): `askAdvisory` returns `false`
 * ("definitely not eligible, skip the Postgres round-trip") ONLY when the
 * mirror has already reached the mirrored cap; every other outcome - key
 * absent, count below cap, or ANY Redis error/timeout - returns `true`
 * ("ask Postgres"), never `false`. Postgres remains the sole authority;
 * this is purely a wasted-round-trip optimisation, and a KILL SWITCH
 * (`enabled: false`, or simply never calling `askAdvisory` at all) disables
 * it without touching correctness - `reserve()` (`engine/pacing/index.ts`)
 * does not depend on this module at all; a caller wires it in front of
 * `reserve()` as a purely additive short-circuit.
 *
 * KEYS go through `tenantKey(env, clientId, ...)` (`platform/redis/keys.ts`)
 * - never a raw `wp:` template literal (the `wp/key-construction` eslint
 * guard rejects that outside `platform/redis/**`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(HERE, 'scripts');

function readScript(name: string): string {
  return readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
}

const RESERVE_ADVISORY_LUA = readScript('reserve-advisory.lua');

interface RedisWithAdvisoryCommand extends Redis {
  wpPacingAdvisory?(...args: (string | number)[]): Promise<number>;
}

export interface PacingAdvisory {
  /** `false` = definitely not eligible, skip Postgres. `true` (the ONLY other outcome, including every error/timeout case) = ask Postgres. NEVER a grant on its own. */
  askAdvisory(input: AskAdvisoryInput): Promise<boolean>;
  /** Mirrors a REAL Postgres grant into the Redis counter - callers invoke this AFTER `reserve()` grants, never speculatively and never for a deny. */
  recordGrant(input: RecordGrantInput): Promise<void>;
}

export interface AskAdvisoryInput {
  env: string;
  clientId: string;
  instanceId: string;
  ledgerDate: string;
  dailyCap: number;
  /** Kill switch - `false` always resolves `true` (ask Postgres) without touching Redis at all. Defaults to `true`. */
  enabled?: boolean;
}

export interface RecordGrantInput {
  env: string;
  clientId: string;
  instanceId: string;
  ledgerDate: string;
  /** The instance's `pacing_timezone` - required to compute the EXPIREAT target (next local midnight), never a fixed TTL (a fixed TTL would drift across timezones/DST, see `retry-at.ts#nextLocalMidnightMs`). */
  timeZone: string;
  clock: { now(): number };
}

function mirrorKey(env: string, clientId: string, instanceId: string, ledgerDate: string): string {
  return tenantKey(env, clientId, 'pacing', 'mirror', 'i', instanceId, 'd', ledgerDate);
}

/** Creates a `PacingAdvisory` backed by `redis`, defining the Lua command once per connection (idempotent, same guard pattern as `createLeaseRedis`). */
export function createPacingAdvisory(redis: Redis): PacingAdvisory {
  const client = redis as RedisWithAdvisoryCommand;
  if (typeof client.wpPacingAdvisory !== 'function') {
    redis.defineCommand('wpPacingAdvisory', { lua: RESERVE_ADVISORY_LUA, numberOfKeys: 1 });
  }

  return {
    async askAdvisory(input: AskAdvisoryInput): Promise<boolean> {
      if (input.enabled === false) {
        return true;
      }
      const key = mirrorKey(input.env, input.clientId, input.instanceId, input.ledgerDate);
      try {
        const result = await client.wpPacingAdvisory!(key, input.dailyCap);
        return result !== 0;
      } catch {
        // Any Redis error/timeout degrades to "ask Postgres" - never to
        // "skip it" (see module doc).
        return true;
      }
    },

    async recordGrant(input: RecordGrantInput): Promise<void> {
      const key = mirrorKey(input.env, input.clientId, input.instanceId, input.ledgerDate);
      const expireAtSeconds = Math.ceil(
        nextLocalMidnightMs(input.clock.now(), input.timeZone) / 1000,
      );
      try {
        await client.incr(key);
        await client.expireat(key, expireAtSeconds);
      } catch {
        // A failed mirror write only degrades future askAdvisory calls
        // toward "ask Postgres more often than strictly necessary" - never
        // toward an incorrect grant. Swallowed by design.
      }
    },
  };
}
