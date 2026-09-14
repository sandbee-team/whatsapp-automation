/**
 * Reconnect backoff math (engine design 5.1 / ADR 0013): full-jitter
 * exponential backoff plus a permanent per-instance stagger, so a fleet-wide
 * reconnect storm (many instances dropping at once, e.g. a shared network
 * blip) does not thunder back in lockstep.
 *
 *   ceiling = min(CAP, BASE * baseMultiplier * 2^(attempt-1))
 *   delay   = rng() * ceiling + stagger(instanceId)
 *
 * `attempt` is 1-based. `stagger` is a small, DETERMINISTIC per-instance
 * offset (`deterministicHash(instanceId) % 5_000`) - not randomness, so it is
 * stable across restarts and safe to compute in a browser-pure module
 * (ESLint bans `Date.now`/`Math.random` in `packages/domain/src/**`; this
 * module takes `rng` as a parameter instead).
 *
 * 503 (service unavailable) uses `baseMultiplier=5` - a 5x wider ceiling at
 * every attempt, per the design's "503 uses BASE*5" note.
 *
 * The attempt counter itself resets to 0 only when the PRECEDING open
 * connection lasted longer than 60s - a flapping connection (repeated short
 * opens) must not be able to refill its own retry budget by looking briefly
 * "open" between drops.
 */

export const BASE_DELAY_MS = 2_000;
export const CAP_DELAY_MS = 300_000;
export const MAX_ATTEMPTS = 8;
const STAGGER_MODULUS_MS = 5_000;
const OPEN_RESET_THRESHOLD_MS = 60_000;

/** The FSM-facing reason constant surfaced when the reconnect budget is exhausted. */
export const RECONNECT_GIVE_UP_REASON = 'RECONNECT_FAILED' as const;

export interface NextDelayInput {
  /** 1-based reconnect attempt number. */
  attempt: number;
  instanceId: string;
  rng: { random(): number };
  /** 503 passes 5 here; every other disconnect class defaults to 1. */
  baseMultiplier?: number;
}

/**
 * A small, pure, non-cryptographic string hash (FNV-1a, 32-bit) - no
 * dependency, no `Math.random`, deterministic for a given input string. Used
 * only to derive the per-instance stagger, never for anything security
 * sensitive.
 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiplication done as 32-bit-safe additions/shifts.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

function staggerMs(instanceId: string): number {
  return fnv1aHash(instanceId) % STAGGER_MODULUS_MS;
}

function ceilingMs(attempt: number, baseMultiplier: number): number {
  const raw = BASE_DELAY_MS * baseMultiplier * 2 ** (attempt - 1);
  return Math.min(CAP_DELAY_MS, raw);
}

export function nextDelayMs(input: NextDelayInput): number {
  const { attempt, instanceId, rng, baseMultiplier = 1 } = input;
  const ceiling = ceilingMs(attempt, baseMultiplier);
  const jitter = rng.random() * ceiling;
  return jitter + staggerMs(instanceId);
}

/**
 * `attempt > MAX_ATTEMPTS` => stop: this is never a silent stop - the caller
 * must pause the instance with `needs_user_action = RECONNECT_FAILED`
 * (`RECONNECT_GIVE_UP_REASON`) when this returns `true`.
 */
export function shouldGiveUp(attempt: number): boolean {
  return attempt > MAX_ATTEMPTS;
}

export interface OnOpenInput {
  openedAtMs: number;
  closedAtMs: number;
  attempt: number;
}

/**
 * Returns the new attempt counter after a connection that was open closed
 * again. Resets to 0 ONLY if the open lasted strictly longer than 60s -
 * flapping (many short opens) must not refill its own retry budget.
 */
export function onOpen(input: OnOpenInput): number {
  const openDurationMs = input.closedAtMs - input.openedAtMs;
  if (openDurationMs > OPEN_RESET_THRESHOLD_MS) {
    return 0;
  }
  return input.attempt;
}
