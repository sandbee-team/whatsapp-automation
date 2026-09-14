import type { Rng } from '../ports.js';

/**
 * backoff.ts (P11 send-path-mvp, step 2) - retry backoff for a queued job
 * that failed a retryable send (queue-engineering skill: `delay = min(cap,
 * base * 2^attempt)` with **full** jitter, `sleep = random(0, delay)`).
 *
 * Formula (blueprint, verbatim): `delay = min(15 min, 2s * 2^attempts)`,
 * then full jitter - the RETURNED value is drawn uniformly from `[0,
 * delay]`, not `delay/2 + random(delay/2)` (that is "equal jitter") and
 * never a fixed `delay`. `attempts` is 0-based (the first retry after the
 * first failure passes `attempts=0`).
 *
 * Pure and deterministic per `packages/domain`'s browser-purity contract:
 * the RNG is always injected (`Rng` port, `./ports.js`), never
 * `Math.random()` directly - see `wp/domain-no-wallclock`.
 */

/** Base delay for the exponential term, in milliseconds (2 seconds). */
export const BACKOFF_BASE_MS = 2_000;

/** Hard cap on the backoff ceiling, in milliseconds (15 minutes). */
export const BACKOFF_CAP_MS = 15 * 60 * 1_000;

/**
 * Caps `attempts` before exponentiating: `2 ** attempts` overflows to
 * `Infinity` for a large enough `attempts` (>= 1024), which would otherwise
 * propagate as `NaN`/`Infinity` through the `Math.min` below once multiplied
 * by a finite base. Any `attempts` large enough that `BACKOFF_BASE_MS *
 * 2^attempts` already exceeds the cap can be clamped to the smallest
 * exponent that also exceeds the cap - the exact value beyond that point
 * makes no difference to the `Math.min` result.
 */
function ceilingMs(attempts: number): number {
  const safeAttempts = Math.max(0, Math.floor(attempts));
  // 2 ** 32 * BACKOFF_BASE_MS already vastly exceeds BACKOFF_CAP_MS, and
  // 2 ** 32 is still comfortably a finite, safe-integer-adjacent double -
  // clamping the exponent here keeps the multiplication finite in every
  // case without changing the resulting (capped) ceiling.
  const clampedAttempts = Math.min(safeAttempts, 32);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** clampedAttempts);
}

/**
 * Returns the next retry delay in milliseconds for a job that has failed
 * `attempts` times already (0-based). Full jitter: uniformly drawn from
 * `[0, ceiling]` where `ceiling = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS *
 * 2^attempts)`.
 */
export function backoff(attempts: number, rng: Rng): number {
  const ceiling = ceilingMs(attempts);
  return rng.random() * ceiling;
}
