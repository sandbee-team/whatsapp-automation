import type { Redis } from 'ioredis';

/**
 * platform/redis-assertions.ts (P07 Unit U3, step 5) - the Signal Redis
 * keyspace-policy boot assertion. Modeled on
 * `platform/db/assert-db-preconditions.ts`'s fail-closed shape: any failure
 * to prove the policy (a query error, a non-`noeviction` value, anything)
 * throws rather than passing silently.
 *
 * NOT yet wired into `assertDbPreconditions`'s composed boot assertion -
 * there is no existing Redis precondition slot there today (only Postgres
 * checks). Exported standalone for P08's boot wiring; see this unit's
 * dispatch deviations note.
 */

/**
 * Thrown when `redisSig`'s `maxmemory-policy` is anything other than exactly
 * `noeviction` (core invariant 2, fail-safe: an evictable Signal/session
 * keyspace could silently drop non-rebuildable auth material under memory
 * pressure) - or when the policy cannot be read at all (CONFIG GET errors,
 * connection down, malformed reply). Never resolves as if the policy were
 * safe when it cannot be proven.
 */
export class SignalKeyspacePolicyError extends Error {
  code = 'SIGNAL_KEYSPACE_POLICY_INVALID';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SignalKeyspacePolicyError';
  }
}

/**
 * Asserts `redisSig`'s `maxmemory-policy` is exactly `noeviction`. Throws
 * `SignalKeyspacePolicyError` (fail-closed) otherwise, naming the actual
 * policy value in the message, or wrapping any error encountered while
 * reading it.
 */
export async function assertSignalKeyspacePolicy(redisSig: Redis): Promise<void> {
  let policy: string | undefined;

  try {
    const reply = await redisSig.config('GET', 'maxmemory-policy');
    // ioredis' `config('GET', key)` reply shape is `[key, value]`.
    const value = Array.isArray(reply) ? reply[1] : undefined;
    policy = typeof value === 'string' ? value : undefined;
  } catch (err) {
    throw new SignalKeyspacePolicyError(
      `Failed to read redisSig's maxmemory-policy: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (policy !== 'noeviction') {
    throw new SignalKeyspacePolicyError(
      `redisSig's maxmemory-policy must be "noeviction", got "${policy ?? 'unknown'}" - refusing to boot`,
    );
  }
}
