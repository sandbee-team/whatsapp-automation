/**
 * Injected ports (P00 step 8).
 *
 * `packages/domain` must run unchanged in a browser and stay deterministic
 * under test, so it never reads the wall clock or system randomness itself
 * (ESLint's `wp/domain-no-wallclock` guard bans `Date.now()`, `Math.random()`
 * and zero-arg `new Date()` inside `packages/domain/src/**`). Every module
 * that needs "now" or "a random number" takes a `Clock`/`Rng` argument
 * instead - the caller (a worker, or a test) injects a real or fake one.
 */

/** A source of the current time, injected so domain code stays pure. */
export interface Clock {
  /** Milliseconds since the Unix epoch, the same contract as `Date.now()`. */
  now(): number;
}

/** A source of randomness, injected so domain code stays pure and testable. */
export interface Rng {
  /** A float in `[0, 1)`, the same contract as `Math.random()`. */
  random(): number;
}
