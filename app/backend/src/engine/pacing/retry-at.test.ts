import { describe, expect, it } from 'vitest';
import { nextLocalMidnightMs, nextWindowOpenMs, resolveRetryAt } from './retry-at.js';

/**
 * retry-at.test.ts (P13 C2 hardening) - pure, clock-injected unit tests for
 * `retry-at.ts`'s two Intl-driven boundary functions, neither of which has
 * ANY existing standalone unit test file (`nextLocalMidnightMs` is only
 * exercised incidentally inside `reserve-clock.integration.test.ts`'s DB
 * suite, for a single spring-forward instant; `nextWindowOpenMs` has ZERO
 * coverage anywhere in the pacing suite before this file). No DB, no
 * network, no sleeps - every instant is a fixed epoch millisecond literal.
 */

describe('nextLocalMidnightMs - DST boundaries', () => {
  it('resolves_the_same_next_midnight_from_both_occurrences_of_a_repeated_fall_back_hour', () => {
    // America/New_York, 2018-11-04: clocks fall back from 02:00 EDT to
    // 01:00 EST - local 01:00-02:00 occurs TWICE that day. Both the FIRST
    // occurrence (01:30 EDT, UTC-4) and the SECOND occurrence (01:30 EST,
    // UTC-5) of "01:30 local" must resolve to the exact same next-midnight
    // instant (2018-11-05T00:00:00-05:00) - the algorithm is day-boundary
    // based, never hour-arithmetic based, so the repeated hour (well after
    // midnight) cannot desync it.
    const firstOccurrence = Date.UTC(2018, 10, 4, 5, 30, 0); // 01:30 EDT (UTC-4)
    const secondOccurrence = Date.UTC(2018, 10, 4, 6, 30, 0); // 01:30 EST (UTC-5)
    const expected = Date.UTC(2018, 10, 5, 5, 0, 1); // 2018-11-05T00:00:00-05:00, ceil'd to the next second

    expect(nextLocalMidnightMs(firstOccurrence, 'America/New_York')).toBe(expected);
    expect(nextLocalMidnightMs(secondOccurrence, 'America/New_York')).toBe(expected);
  });

  it('resolves_correctly_when_probed_from_noon_the_day_before_a_spring_forward', () => {
    // America/Sao_Paulo, 2018-11-04: 00:00 local skips to 01:00 (a 23h
    // shortened local day) - probed here from local noon the PRIOR day,
    // the shape reserve-clock.integration.test.ts's own DST test already
    // covers from a slightly different starting instant; kept here too as
    // the two files' coverage is independent and this file's whole point
    // is to be the standalone home for this function's boundary behaviour.
    const noonNov3 = Date.UTC(2018, 10, 3, 15, 0, 0); // 2018-11-03T12:00:00-03:00
    const midnight = nextLocalMidnightMs(noonNov3, 'America/Sao_Paulo');
    expect(midnight).toBe(Date.UTC(2018, 10, 4, 3, 0, 1));
  });

  it('a_timezone_change_between_two_calls_never_desyncs_a_single_calls_own_result', () => {
    // Same instant, two different IANA zones - each call is independently
    // correct (no shared mutable state leaking between calls).
    const instant = Date.UTC(2026, 8, 2, 12, 0, 0);
    const kolkata = nextLocalMidnightMs(instant, 'Asia/Kolkata');
    const utc = nextLocalMidnightMs(instant, 'UTC');
    expect(kolkata).not.toBe(utc);
    expect(kolkata).toBe(Date.UTC(2026, 8, 2, 18, 30, 0)); // next 00:00 IST (UTC+5:30)
    expect(utc).toBe(Date.UTC(2026, 8, 3, 0, 0, 1));
  });
});

describe('nextWindowOpenMs', () => {
  /**
   * FORMERLY A PRODUCTION BUG (pinned as
   * `BUG_never_returns_epochMs_unchanged_even_when_already_inside_the_window`
   * before the fix - see `retry-at.ts`'s own doc comment for
   * `nextWindowOpenMs`, "ALSO-FIX"): the function's doc always promised "if
   * `epochMs` is already inside `[windowStartLocal, windowEndLocal)` on the
   * current local day, returns `epochMs` unchanged", but had no
   * `windowEndLocal` parameter at all, so a caller probing from genuinely
   * INSIDE the window got back TOMORROW's window start instead. Fixed by
   * adding the real `windowEndLocal` parameter and the "already inside"
   * branch - this test now proves the DOCUMENTED behaviour actually holds.
   */
  it('already_inside_todays_window_returns_epochMs_unchanged', () => {
    // 10:00 local Asia/Kolkata (UTC+5:30) = 04:30 UTC on 2026-09-02 -
    // genuinely inside a [09:00, 20:00) window.
    const insideWindow = Date.UTC(2026, 8, 2, 4, 30, 0);
    const result = nextWindowOpenMs(insideWindow, 'Asia/Kolkata', '09:00:00', '20:00:00');
    expect(result).toBe(insideWindow);
  });

  it('past_the_window_end_boundary_is_no_longer_inside_the_window', () => {
    // 20:00:05 local Asia/Kolkata - safely past a [09:00, 20:00) window
    // (kept a few seconds clear of the exact boundary instant, since
    // `nextLocalMidnightMs`'s own deliberate ceil-to-the-second rounding -
    // see its doc comment - means the boundary itself is fuzzy by up to
    // 1s; this test asserts the unambiguous "clearly past close" case).
    // This must resolve to TOMORROW's window start, not "still inside".
    const afterWindowEnd = Date.UTC(2026, 8, 2, 14, 30, 5); // 20:00:05 IST
    const result = nextWindowOpenMs(afterWindowEnd, 'Asia/Kolkata', '09:00:00', '20:00:00');
    expect(result).toBe(Date.UTC(2026, 8, 3, 3, 30, 1)); // tomorrow 09:00 IST
  });

  it('omitting_windowEndLocal_defaults_to_a_zero_width_window_preserving_prior_behaviour', () => {
    // No windowEndLocal bound: defaults to windowStartLocal (zero-width),
    // so "already inside" can never trigger - identical to every existing
    // caller's pre-fix behaviour for a probe strictly inside a window.
    const insideWindow = Date.UTC(2026, 8, 2, 4, 30, 0);
    const result = nextWindowOpenMs(insideWindow, 'Asia/Kolkata', '09:00:00');
    expect(result).not.toBe(insideWindow);
    expect(result).toBe(Date.UTC(2026, 8, 3, 3, 30, 1));
  });

  it('resolves_to_todays_window_start_when_probed_before_it_opens', () => {
    // 05:00 local Asia/Kolkata = 23:30 UTC the prior day.
    const beforeWindow = Date.UTC(2026, 8, 1, 23, 30, 0);
    const result = nextWindowOpenMs(beforeWindow, 'Asia/Kolkata', '09:00:00');
    // 2026-09-02T09:00:00+05:30 = 2026-09-02T03:30:00Z
    expect(result).toBe(Date.UTC(2026, 8, 2, 3, 30, 1));
  });

  it('resolves_to_tomorrows_window_start_when_probed_after_todays_has_passed', () => {
    // 20:00 local Asia/Kolkata = 14:30 UTC.
    const afterWindow = Date.UTC(2026, 8, 2, 14, 30, 0);
    const result = nextWindowOpenMs(afterWindow, 'Asia/Kolkata', '09:00:00');
    // Tomorrow, 2026-09-03T09:00:00+05:30 = 2026-09-03T03:30:00Z
    expect(result).toBe(Date.UTC(2026, 8, 3, 3, 30, 1));
  });

  it('crosses_a_dst_fall_back_boundary_without_drifting_the_resolved_window_start', () => {
    // America/New_York, window opens at 09:00 local. Probed from
    // 2018-11-03T20:30 local (before midnight, before the fall-back), the
    // resolved window start must be 2018-11-04T09:00 EST (the fall-back
    // has ALREADY happened by 09:00 the next morning), not a UTC-naive
    // +9h-from-midnight computation that would drift by an hour across the
    // transition.
    const eveningBefore = Date.UTC(2018, 10, 4, 0, 30, 0); // 2018-11-03T20:30 EDT (UTC-4)
    const result = nextWindowOpenMs(eveningBefore, 'America/New_York', '09:00:00');
    // 2018-11-04T09:00:00-05:00 (EST, post-fall-back) = 2018-11-04T14:00:00Z
    expect(result).toBe(Date.UTC(2018, 10, 4, 13, 0, 1));
  });

  it('accepts_an_HH_MM_window_start_with_no_seconds_component', () => {
    const beforeWindow = Date.UTC(2026, 8, 1, 23, 30, 0);
    const result = nextWindowOpenMs(beforeWindow, 'Asia/Kolkata', '09:00');
    expect(result).toBe(Date.UTC(2026, 8, 2, 3, 30, 1));
  });
});

describe('resolveRetryAt', () => {
  const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

  it('nextWindowOpen_rule_resolves_via_nextWindowOpenMs_using_the_injected_clock', () => {
    const resolved = resolveRetryAt({
      rule: { kind: 'nextWindowOpen' },
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
      nextEligibleAt: new Date(fixedClock.now()),
      windowStartLocal: '18:00:00',
    });
    // 12:00 UTC = 17:30 IST, window opens at 18:00 IST same day.
    expect(resolved.getTime()).toBe(Date.UTC(2026, 8, 2, 12, 30, 1));
  });

  it('nextWindowOpen_rule_defaults_windowStartLocal_to_midnight_when_omitted', () => {
    const resolved = resolveRetryAt({
      rule: { kind: 'nextWindowOpen' },
      clock: fixedClock,
      timeZone: 'UTC',
      nextEligibleAt: new Date(fixedClock.now()),
    });
    expect(resolved.getTime()).toBe(Date.UTC(2026, 8, 3, 0, 0, 1));
  });

  it('none_rule_resolves_to_the_injected_clocks_own_now_never_a_stale_value', () => {
    const resolved = resolveRetryAt({
      rule: { kind: 'none' },
      clock: fixedClock,
      timeZone: 'UTC',
      nextEligibleAt: new Date(0),
    });
    expect(resolved.getTime()).toBe(fixedClock.now());
  });
});
