/**
 * backoff.ts (P15 U5, step 7) - the webhook dispatcher's retry policy:
 * `delay = min(6h, 2s * 2^attempt)` with FULL jitter (`random(0, cap)`),
 * `MAX_ATTEMPTS=8` (~24h total, phase canon), and the terminal-status-code
 * set (400/401/403/404/422 - never retried, everything else retries).
 * `rng` is always caller-injected (never `Math.random()` here) - see this
 * module's own test for exact expected values at exact inputs.
 */

export const MAX_ATTEMPTS = 8;

const BASE_DELAY_MS = 2_000;
const CAP_DELAY_MS = 6 * 60 * 60 * 1000; // 6 hours

const TERMINAL_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

/** True for a status code the dispatcher must never retry (phase canon, verbatim). */
export function isTerminalStatusCode(statusCode: number): boolean {
  return TERMINAL_STATUS_CODES.has(statusCode);
}

/**
 * `min(6h, 2s * 2^attempt)` scaled by one `rng()` draw in `[0, 1)` — the
 * "full jitter" shape (`AWS Architecture Blog`'s canonical formula): the cap
 * is the CEILING of the draw, not an additive jitter on top of a base delay.
 * `rng` must return a value in `[0, 1]` inclusive for this function's own
 * test fixtures (a real `Math.random()` never returns exactly 1, but `1.0`
 * is used here as a deterministic "max draw" test fixture to assert the
 * exact ceiling, per the mechanical convention against bounds-only
 * assertions).
 */
export function computeNextAttemptDelayMs(attempt: number, rng: () => number): number {
  const uncapped = BASE_DELAY_MS * 2 ** attempt;
  const cap = Math.min(CAP_DELAY_MS, uncapped);
  return Math.round(cap * rng());
}
