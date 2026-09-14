import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { computeLockedUntil, priorLockoutsFor, shouldLock, LOCKOUT_THRESHOLD } from './lockout.js';
import { UsedTotpCodes } from './totp.js';

/**
 * lockout-totp-c2.test.ts (P28 C2 hardening) - the lockout DOUBLING formula
 * (`computeLockedUntil`/`priorLockoutsFor`) has no dedicated unit test today
 * (only exercised indirectly through `staff-auth.integration.test.ts`'s
 * `staff_login_requires_totp_and_an_allow_listed_ip`, which reaches the
 * FIRST lockout only). This asserts the EXACT formula for the first lockout
 * (15 min) and the second (30 min, after a manual/administrative unlock
 * that leaves `failed_login_count` at `2 * LOCKOUT_THRESHOLD`), from the
 * same constants the production code uses - never a wall-clock margin. Also
 * covers `UsedTotpCodes`, the in-memory single-use marker: a code presented
 * twice inside its own window is a replay on the second use.
 *
 * First import is the `@wp/server-kit` env stub: `totp.ts` imports
 * `@wp/server-kit/crypto`, which reaches the config singleton at module
 * load.
 */

describe('lockout arithmetic (P28 C2)', () => {
  it('five_failures_lock_for_fifteen_minutes', () => {
    const failedCount = LOCKOUT_THRESHOLD;
    expect(shouldLock(failedCount)).toBe(true);
    const prior = priorLockoutsFor(failedCount);
    expect(prior).toBe(0);
    const now = new Date('2026-09-08T00:00:00.000Z');
    const lockedUntil = computeLockedUntil(now, prior);
    expect(lockedUntil.getTime() - now.getTime()).toBe(15 * 60_000);
  });

  it('a_second_lockout_after_a_manual_unlock_doubles_the_window_to_thirty_minutes', () => {
    // A manual unlock clears `locked_until` but not `failed_login_count`
    // (see `lockout.ts`'s own doc: the running count is what derives
    // `priorLockoutsFor`) - five MORE failures land at count = 2 *
    // LOCKOUT_THRESHOLD = 10, the second time the threshold is crossed.
    const failedCount = 2 * LOCKOUT_THRESHOLD;
    expect(shouldLock(failedCount)).toBe(true);
    const prior = priorLockoutsFor(failedCount);
    expect(prior).toBe(1);
    const now = new Date('2026-09-08T00:00:00.000Z');
    const lockedUntil = computeLockedUntil(now, prior);
    expect(lockedUntil.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it('a_failure_count_between_lockout_thresholds_never_triggers_a_new_lock', () => {
    // 6, 7, 8, 9 failures (past the first lock at 5, short of the second at
    // 10) must never re-trigger `shouldLock` - a single lockout event per
    // threshold crossing, not one per failed attempt above it.
    for (let count = LOCKOUT_THRESHOLD + 1; count < 2 * LOCKOUT_THRESHOLD; count += 1) {
      expect(shouldLock(count)).toBe(false);
    }
  });
});

describe('UsedTotpCodes replay set (P28 C2)', () => {
  it('the_same_code_presented_twice_within_the_window_is_a_replay_on_the_second_use', () => {
    const used = new UsedTotpCodes();
    const now = new Date('2026-09-08T00:00:00.000Z');
    const windowSeconds = 90;

    const first = used.claim('staff-c2-probe', '123456', now, windowSeconds);
    expect(first).toBe(true);

    // Immediately re-presented, well inside the window.
    const second = used.claim('staff-c2-probe', '123456', now, windowSeconds);
    expect(second).toBe(false);

    // A DIFFERENT staff member presenting the SAME code is not a replay -
    // the marker is keyed `staffId:code`, never `code` alone.
    const otherStaff = used.claim('staff-c2-other', '123456', now, windowSeconds);
    expect(otherStaff).toBe(true);

    // Once the window has fully elapsed, the original code is claimable
    // again (a fresh TOTP period reusing the same six digits is
    // vanishingly unlikely in practice, but the marker itself must not
    // block forever).
    const later = new Date(now.getTime() + (windowSeconds + 1) * 1000);
    const afterWindow = used.claim('staff-c2-probe', '123456', later, windowSeconds);
    expect(afterWindow).toBe(true);
  });
});
