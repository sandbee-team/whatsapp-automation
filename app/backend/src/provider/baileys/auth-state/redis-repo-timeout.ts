import { TIMING } from '@wp/domain';

/**
 * redis-repo-timeout.ts (P07 FIX-A C2-F2) - the bounded-timeout wrapper and
 * typed error classes `redis-repo.ts` uses for EVERY Redis command (reads
 * and writes, both tiers), split out purely to stay under the repo's
 * `max-lines` guard (same reasoning as `pg-repo.ts`/`pg-repo-keys.ts`'s own
 * split). Mirrors `engine/lease/lease-redis.ts`'s own `withTimeout` shape
 * exactly - a command that neither resolves nor rejects within
 * `TIMING.redisCommandTimeoutMs` is treated as failed (the underlying
 * ioredis call is left to settle on its own; the wrapper never waits for it).
 */

export interface WithTimeoutOptions {
  /** Hard per-command timeout in ms. Defaults to `TIMING.redisCommandTimeoutMs`. */
  timeoutMs?: number;
  /** Injectable for tests - defaults to the real `setTimeout`/`clearTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Thrown when any WRITE command (HSET/HDEL/PEXPIRE/DEL/the fence-gate EVAL)
 * against Redis rejects OR times out. NEVER swallowed and NEVER retried here
 * (core invariant 2, fail-safe) - the caller is expected to degrade the
 * instance (stop claiming, keep the socket, jobs preserved) rather than
 * retry blindly.
 */
export class SignalStateWriteError extends Error {
  code = 'SIGNAL_STATE_WRITE_FAILED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SignalStateWriteError';
  }
}

/** Thrown when a READ command (HMGET) times out (C2-F2) - distinct from a write failure/timeout. */
export class SignalStateReadTimeoutError extends Error {
  code = 'SIGNAL_STATE_READ_TIMEOUT';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SignalStateReadTimeoutError';
  }
}

/**
 * Thrown when the fence-gate Lua script rejects a write (WARNING-3): a newer
 * fence has already gated a write through for this (tier, instance) since
 * this caller last checked - the caller must treat this exactly like a
 * fence conflict (self-fence, never retry blindly).
 */
export class RedisFenceGateError extends Error {
  code = 'REDIS_FENCE_GATE_REJECTED';

  constructor(instanceId: string) {
    super(
      `redis-repo: fence gate rejected a write for instance ${instanceId} - a newer fence has ` +
        'already been gated through',
    );
    this.name = 'RedisFenceGateError';
  }
}

export class RedisCommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`redis-repo: '${command}' timed out after ${String(timeoutMs)}ms`);
    this.name = 'RedisCommandTimeoutError';
  }
}

/**
 * Races `run()` against a hard timeout - same shape as `lease-redis.ts`'s
 * own `withTimeout` (C2-F2 applies the identical bound here). The timer is
 * always cleared (success, failure, or timeout) so no dangling timer keeps
 * the process alive or fires after the fact.
 */
export function withTimeout<T>(
  run: () => Promise<T>,
  command: string,
  options: WithTimeoutOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? TIMING.redisCommandTimeoutMs;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeoutFn(() => {
      if (settled) return;
      settled = true;
      reject(new RedisCommandTimeoutError(command, timeoutMs));
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

/** Wraps a write-command error/timeout into the one typed `SignalStateWriteError`. */
export async function runWrite<T>(
  run: () => Promise<T>,
  command: string,
  options: WithTimeoutOptions,
  contextMessage: string,
): Promise<T> {
  try {
    return await withTimeout(run, command, options);
  } catch (err) {
    throw new SignalStateWriteError(
      `${contextMessage}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
