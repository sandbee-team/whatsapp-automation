/**
 * onceForKey - shares ONE in-flight promise per key across all callers.
 *
 * Why this exists: React 19 StrictMode double-invokes effects in dev
 * (mount -> cleanup -> remount). A `cancelled` flag guarding a `setState`
 * call only stops the STALE render, it does nothing to stop the underlying
 * async call itself - so an effect that calls a single-use server endpoint
 * (e.g. POST /v1/auth/verify-email, whose token is consumed by a
 * conditional UPDATE ... RETURNING at the storage layer) fires the call
 * TWICE for one real page visit. The first attempt consumes the token and
 * succeeds; the second is rejected as already-used, and whichever settles
 * last wins the rendered state - so a genuine first-time click can render
 * as invalid.
 *
 * The fix: key the in-flight (and settled) promise by the resource being
 * consumed (the token) in MODULE-level state, not component state. Module
 * state survives a StrictMode remount (refs and state do not - they are
 * torn down and recreated on remount), so every effect invocation for the
 * same key - whether from StrictMode's extra pass or a genuine remount -
 * shares the exact same promise and therefore the exact same outcome.
 * Only one real network call is ever made per key for the process
 * lifetime.
 *
 * The map is intentionally UNBOUNDED (P04b FIXF, C1 MINOR-1): keys are
 * per-page-visit in a single browser tab (a handful of single-use tokens
 * over the tab's lifetime, never a long-running high-cardinality stream),
 * so no eviction/cap is needed here. This module is browser-only client
 * state - it must NEVER be reused for server/SSR request de-duplication,
 * where an unbounded per-process map would be a real memory-growth and
 * cross-request leak.
 */
const inFlight = new Map<string, Promise<unknown>>();

export interface OnceForKeyOptions {
  /**
   * When true, a REJECTED attempt evicts its map entry instead of being
   * cached, so the next call for the same key retries with a real network
   * call. Default false (share/cache the rejection too) - correct for a
   * single-use token consume (e.g. verify-email) where a second attempt
   * would only ever re-observe the same "already used" outcome, never a
   * fresh success.
   *
   * Set true for an action that seals a NEW server-side resource on every
   * successful call and is safe/expected to be retried after a transient
   * failure (e.g. TOTP enrolment start, which is gated by a Bearer session
   * that a StrictMode double-invoke or unrelated 401/refresh race can
   * legitimately cause to fail once) - caching that rejection would
   * permanently break the key for the rest of the process lifetime.
   */
  evictOnRejection?: boolean;
}

export function onceForKey<T>(
  key: string,
  run: () => Promise<T>,
  options: OnceForKeyOptions = {},
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = run();
  inFlight.set(key, promise);

  if (options.evictOnRejection) {
    promise.catch(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  }

  return promise;
}
