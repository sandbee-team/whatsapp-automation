import { createHmac } from 'node:crypto';

/**
 * modules/leads/bot-guard.ts (P29 U4b) - the two cheap, pure bot defences on
 * the public lead form, plus the IP-hashing primitive the write path uses
 * before a row ever reaches storage.
 *
 * Both guard checks are pure functions of already-parsed input and an
 * injected clock, so they are fully deterministic in tests (no sleeping,
 * no wall-clock reads) - the same discipline `core-invariants.md` requires
 * for every timing-sensitive check in this repo.
 */

export interface BotGuardInput {
  /** The honeypot field's submitted value - a real visitor never fills it in (hidden from sighted users, `aria-hidden`, `tabIndex -1`). */
  honeypot: string;
  /** Client-reported form-render timestamp (epoch ms). */
  startedAtMs: number;
  /** The request's own clock reading (epoch ms) - never `Date.now()` read directly, so this stays testable. */
  nowMs: number;
}

export type BotGuardResult =
  { ok: true } | { ok: false; reason: 'honeypot' | 'too_fast' | 'stale' | 'future' };

const MIN_FORM_TIME_MS = 3_000;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * Rejects a submission that looks automated. Checked in this exact order:
 * a filled honeypot is the strongest signal and is reported first even if
 * the timing would also fail; a `startedAt` set in the future (clock abuse,
 * not a real page load) is checked before "too fast" so a forged, far-future
 * timestamp cannot be misreported as merely quick.
 */
export function evaluateBotGuard(input: BotGuardInput): BotGuardResult {
  if (input.honeypot.length > 0) {
    return { ok: false, reason: 'honeypot' };
  }
  if (input.startedAtMs > input.nowMs + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future' };
  }
  const elapsedMs = input.nowMs - input.startedAtMs;
  if (elapsedMs < MIN_FORM_TIME_MS) {
    return { ok: false, reason: 'too_fast' };
  }
  if (elapsedMs > MAX_FORM_AGE_MS) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true };
}

/**
 * HMAC-SHA256 hex digest of `ip` keyed by `secret` - the ONLY form an IP
 * address takes anywhere past this function: never returned, logged, or
 * stored raw (see `leads` migration 0074's `ip_hash` CHECK, which enforces
 * the same shape at the storage layer). `secret` is
 * `LEADS_IP_HASH_SECRET` - deliberately not `ADMIN_JWT_SECRET`, so a
 * compromise of one secret cannot unmask the other's protected values.
 */
export function hashIp(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}
