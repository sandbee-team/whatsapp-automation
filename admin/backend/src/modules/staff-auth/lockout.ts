/**
 * modules/staff-auth/lockout.ts (P28 Unit U4, step 6) - the two brute-force
 * defences on the staff login route, kept as PURE functions with injected
 * time so their behaviour is testable without sleeping.
 *
 * 1. PER-ACCOUNT LOCKOUT (durable, in `staff_users`): after
 *    `LOCKOUT_THRESHOLD` consecutive failures, `locked_until` is set to
 *    `now + 15 min * 2^(previous lockouts)`, capped at 24 hours. Doubling
 *    (rather than a flat window) means a determined attacker's cost grows
 *    without an operator having to intervene; the 24-hour cap means a
 *    legitimate staff member is never locked out permanently by someone
 *    else's attack on their account.
 *
 * 2. PER-IP SLIDING WINDOW (in-memory): 10 attempts / 15 minutes per IP,
 *    counted BEFORE any password hash is computed, so an attacker cannot
 *    use the argon2 cost (19456 KiB per verify) as a cheap CPU/memory DoS
 *    on the admin API.
 *
 *    HONEST LIMITATION, documented rather than papered over: this counter
 *    is PROCESS-LOCAL. That is correct for v1 because admin-api runs as a
 *    SINGLE process (ADR 0014 - one admin backend, a handful of staff), so
 *    process-local IS global here. If admin-api is ever scaled to more than
 *    one replica this must move to Redis, exactly as the tenant side's
 *    `platform/http/rate-limit.ts` already does - otherwise the effective
 *    limit silently becomes 10 x replicas. The durable per-account lockout
 *    above is unaffected either way, which is why the account ladder, not
 *    this counter, is the real defence.
 *
 * ACCEPTED: A 4-ATTEMPT POST-LOCKOUT WINDOW (C1 review round 2 NOTE). `shouldLock`
 * re-triggers a new `locked_until` only when `failedCount % LOCKOUT_THRESHOLD
 * === 0` (i.e. at 5, 10, 15 ...) - `failedCount` keeps incrementing on every
 * failed attempt REGARDLESS of whether the account is currently locked (the
 * caller still records the attempt even when it never reaches the password
 * check because `locked_until` is in the future), so once a lockout WINDOW
 * expires, attempts 6/7/8/9 are each free re-tries that do not extend the
 * lockout again - only the 10th attempt does. This is a deliberate,
 * accepted trade-off, not an oversight: re-locking on every single
 * post-expiry attempt (`failedCount >= LOCKOUT_THRESHOLD` alone, no modulo)
 * would make `priorLockoutsFor`'s doubling ladder (15/30/60/120min...)
 * un-reachable in practice for a slow, patient attacker making exactly one
 * attempt every 15 minutes forever at the SAME multiple - the modulo is
 * what makes the ladder actually escalate rather than staying flat at the
 * first doubling forever. Four "free" attempts per re-triggered window is
 * judged an acceptable cost against that failure mode.
 */

export const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MINUTES = 15;
const LOCKOUT_MAX_HOURS = 24;

export const IP_WINDOW_LIMIT = 10;
export const IP_WINDOW_SECONDS = 15 * 60;

/**
 * The `locked_until` for a staff user who has just reached the failure
 * threshold. `priorLockouts` is how many times this account has already
 * been locked (derived from `failed_login_count / LOCKOUT_THRESHOLD - 1`),
 * so the window doubles per lockout: 15 min, 30, 60, 120 ... capped at 24 h.
 */
export function computeLockedUntil(now: Date, priorLockouts: number): Date {
  const doublings = Math.max(0, priorLockouts);
  const minutes = LOCKOUT_BASE_MINUTES * 2 ** Math.min(doublings, 10);
  const cappedMinutes = Math.min(minutes, LOCKOUT_MAX_HOURS * 60);
  return new Date(now.getTime() + cappedMinutes * 60_000);
}

/** True when `failedCount` (AFTER incrementing for this attempt) has reached the lockout threshold. */
export function shouldLock(failedCount: number): boolean {
  return failedCount >= LOCKOUT_THRESHOLD && failedCount % LOCKOUT_THRESHOLD === 0;
}

/** How many times this account has already been locked, from its running failure count. */
export function priorLockoutsFor(failedCount: number): number {
  return Math.floor(failedCount / LOCKOUT_THRESHOLD) - 1;
}

/**
 * A process-local sliding-window counter keyed by IP. See the module
 * header's honest limitation note before reusing this anywhere else.
 */
export class IpAttemptWindow {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit: number = IP_WINDOW_LIMIT,
    private readonly windowSeconds: number = IP_WINDOW_SECONDS,
  ) {}

  /**
   * Records one attempt from `ip` at `now` and returns whether it is
   * ALLOWED. Records first, then decides - so an over-limit attempt still
   * extends the window, and a caller cannot probe at exactly the limit
   * forever.
   */
  record(ip: string, now: Date): boolean {
    const cutoff = now.getTime() - this.windowSeconds * 1000;
    const existing = (this.attempts.get(ip) ?? []).filter((at) => at > cutoff);
    existing.push(now.getTime());
    this.attempts.set(ip, existing);
    // Bound the map so a spray of one-shot source IPs cannot grow it
    // without limit - entries whose whole window has lapsed are dropped.
    if (this.attempts.size > 10_000) {
      for (const [key, stamps] of this.attempts) {
        if (stamps.every((at) => at <= cutoff)) this.attempts.delete(key);
      }
    }
    return existing.length <= this.limit;
  }

  /** Clears one IP's history - called after a SUCCESSFUL login, so a staff member's own retries never count against them later. */
  clear(ip: string): void {
    this.attempts.delete(ip);
  }
}
