import type { RetryAtRule } from '@wp/domain';

/**
 * engine/pacing/retry-at.ts (P13 Unit U4) - resolves a `RetryAtRule`
 * (`@wp/domain`'s pure, clock-free rule) into a concrete `Date` a caller
 * can write to `message_jobs.next_attempt_at`. `packages/domain` has no
 * clock and no timezone library (browser-purity contract) - `db/queries/
 * pacing-deny-reason.sql`'s own `retry_at` column only ever returns
 * `next_eligible_at` or `now()` (see that file's final SELECT), so
 * `nextLocalMidnight`/`nextWindowOpen` are resolved HERE, in the engine
 * layer that owns both a clock and `instance_pacing_state.pacing_timezone`.
 *
 * Uses native `Intl.DateTimeFormat` with an explicit IANA `timeZone` -
 * deliberately no timezone library dependency (luxon/date-fns-tz are not
 * used anywhere in this repo yet): `Intl` handles DST transitions correctly
 * (verified by the `America/Sao_Paulo` DST test) because it always asks the
 * ICU tz database for the wall-clock fields at a given instant, never doing
 * fixed-offset arithmetic itself.
 */

/** Minimal clock port - injected, never `Date.now()` directly. */
export interface Clock {
  now(): number;
}

/** Reads the wall-clock Y/M/D (in `timeZone`) for the instant `epochMs`. */
function localDateParts(
  epochMs: number,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * The UTC instant of the NEXT local midnight (00:00:00 in `timeZone`)
 * strictly after `epochMs`. Computed by probing candidate UTC instants
 * around next-day-local-midnight and binary-searching the exact boundary
 * via the `Intl` formatter's own local-date reading - never fixed ±offset
 * arithmetic (a fixed offset breaks across a DST transition, exactly the
 * `America/Sao_Paulo` test's point).
 */
export function nextLocalMidnightMs(epochMs: number, timeZone: string): number {
  const today = localDateParts(epochMs, timeZone);
  // Seed candidate: epochMs plus up to 26h (covers a 23h DST-shortened
  // local day) is guaranteed to land on-or-after the next local calendar
  // day for every IANA zone's largest published DST jump (Lord Howe Island
  // is the extreme outlier at 30 minutes; every mainstream zone's spring-
  // forward is <= 1h) - then binary-search backward to the first instant
  // whose local date differs from `today`.
  let lo = epochMs; // last known instant still on `today`'s local date
  let hi = epochMs + 26 * 60 * 60 * 1000; // known to be on a later local date
  const hiParts = localDateParts(hi, timeZone);
  if (hiParts.year === today.year && hiParts.month === today.month && hiParts.day === today.day) {
    // Defensive widening - should not happen for any real IANA zone, but
    // never silently return a same-day instant.
    hi += 24 * 60 * 60 * 1000;
  }
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const midParts = localDateParts(mid, timeZone);
    const sameDay =
      midParts.year === today.year && midParts.month === today.month && midParts.day === today.day;
    if (sameDay) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // `hi` is now within 1s of the true midnight boundary, rounded up to the
  // nearest whole second (retry timestamps do not need sub-second
  // precision, and rounding UP never returns a time before real midnight).
  return Math.ceil(hi / 1000) * 1000;
}

/** Parses "HH:MM:SS" or "HH:MM" into milliseconds-since-local-midnight. */
function localTimeOfDayMs(hhmmss: string): number {
  const [hh, mm, ss] = hhmmss.split(':').map((v) => Number(v));
  return ((hh ?? 0) * 3600 + (mm ?? 0) * 60 + (ss ?? 0)) * 1000;
}

/**
 * The UTC instant of the next `windowStartLocal` ("HH:MM:SS" or "HH:MM", in
 * `timeZone`) at-or-after `epochMs`. ALSO-FIX (P13 C2, formerly pinned as
 * `retry-at.test.ts`'s `BUG_never_returns_epochMs_unchanged_even_when_
 * already_inside_the_window`): the documented "already inside the window"
 * branch now actually exists - `windowEndLocal` is a real parameter,
 * threaded from `instance_pacing_state.eff_window_end_local`
 * (`send-loop-pacing-claim.ts`'s own `readPacingState`). When `epochMs`
 * falls inside `[windowStartLocal, windowEndLocal)` on the current local
 * day, this returns `epochMs` UNCHANGED (no wait needed) - callers only
 * invoke this for a genuine `OUTSIDE_WINDOW`/`PER_RECIPIENT_FREQ` deny, so
 * in steady state this branch should be rare (those denials fire because
 * the caller is OUTSIDE the window), but a caller probing from inside the
 * window (e.g. a race between the deny check and this resolution, or a
 * future caller of this function for a different reason) must never be
 * told to wait until TOMORROW when no wait is actually needed.
 *
 * `windowEndLocal` defaults to `windowStartLocal` (a zero-width window,
 * i.e. the "already inside" branch can never trigger) so every existing
 * caller that has not been updated to pass it keeps its EXACT prior
 * behaviour - never a silent behaviour change for an omitted parameter.
 */
export function nextWindowOpenMs(
  epochMs: number,
  timeZone: string,
  windowStartLocal: string,
  windowEndLocal: string = windowStartLocal,
): number {
  const startOfDayMs = localTimeOfDayMs(windowStartLocal);
  const endOfDayMs = localTimeOfDayMs(windowEndLocal);
  const midnight = nextLocalMidnightMs(epochMs - 1, timeZone); // today's own local midnight boundary (start of the day containing epochMs)
  const todayWindowStart = midnight - 24 * 60 * 60 * 1000 + startOfDayMs;
  const todayWindowEnd = midnight - 24 * 60 * 60 * 1000 + endOfDayMs;

  if (todayWindowStart <= epochMs && epochMs < todayWindowEnd) {
    // Already inside today's window - no wait needed.
    return epochMs;
  }
  if (todayWindowStart > epochMs) {
    return todayWindowStart;
  }
  // Window start already passed today (and epochMs is not before today's
  // close either, per the "already inside" check above) - resolve to
  // tomorrow's.
  return midnight + startOfDayMs;
}

export interface ResolveRetryAtInput {
  rule: RetryAtRule;
  clock: Clock;
  timeZone: string;
  /** `pacing-deny-reason.sql`'s own `retry_at` (== `next_eligible_at`, or `now()` as a fallback) - used only for `{kind: 'nextEligibleAt'}`. */
  nextEligibleAt: Date;
  /** `instance_pacing_state.eff_window_start_local` - used only for `{kind: 'nextWindowOpen'}`. */
  windowStartLocal?: string;
  /** `instance_pacing_state.eff_window_end_local` - used only for `{kind: 'nextWindowOpen'}`, to detect "already inside today's window" (see `nextWindowOpenMs`'s own doc comment). Defaults to `windowStartLocal` (zero-width window) when omitted, matching `nextWindowOpenMs`'s own default. */
  windowEndLocal?: string;
}

/** Resolves `input.rule` to a concrete `Date` - the one function that turns a pure domain rule into a real timestamp (clock + timezone both live in this engine layer, never in `packages/domain`). */
export function resolveRetryAt(input: ResolveRetryAtInput): Date {
  switch (input.rule.kind) {
    case 'nextEligibleAt':
      return input.nextEligibleAt;
    case 'nextLocalMidnight':
      return new Date(nextLocalMidnightMs(input.clock.now(), input.timeZone));
    case 'nextWindowOpen': {
      const windowStartLocal = input.windowStartLocal ?? '00:00:00';
      return new Date(
        nextWindowOpenMs(
          input.clock.now(),
          input.timeZone,
          windowStartLocal,
          input.windowEndLocal ?? windowStartLocal,
        ),
      );
    }
    case 'fixedHoldMs':
      return new Date(input.clock.now() + input.rule.ms);
    case 'none':
      return new Date(input.clock.now());
  }
}
