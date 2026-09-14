import { describe, expect, it } from 'vitest';
import { decideBand, type BandChangeRecord } from './bands.js';

/**
 * bands.test.ts (P16 Unit B, step 5) - named tests exactly per the phase
 * file. All timestamps are plain epoch-ms numbers - no live clock anywhere.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

describe('bands', () => {
  it('tightening_applies_on_the_first_crossing_tick', () => {
    // HEALTHY -> WATCH (70 -> 69): first tick, no dwell required.
    const healthyToWatch = decideBand({
      currentBand: 'healthy',
      score: 69,
      nowMs: NOW,
      bandSinceMs: NOW,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(healthyToWatch).toEqual({
      band: 'watch',
      changed: true,
      direction: 'tighten',
      reason: 'threshold_crossed_down',
    });

    // WATCH -> DEGRADED.
    const watchToDegraded = decideBand({
      currentBand: 'watch',
      score: 54,
      nowMs: NOW,
      bandSinceMs: NOW,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(watchToDegraded.band).toBe('degraded');
    expect(watchToDegraded.changed).toBe(true);
    expect(watchToDegraded.direction).toBe('tighten');

    // DEGRADED -> CRITICAL.
    const degradedToCritical = decideBand({
      currentBand: 'degraded',
      score: 34,
      nowMs: NOW,
      bandSinceMs: NOW,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(degradedToCritical.band).toBe('critical');
    expect(degradedToCritical.changed).toBe(true);
    expect(degradedToCritical.direction).toBe('tighten');
  });

  it('loosening_requires_hysteresis_dwell_and_no_hard_signal_in_24h', () => {
    // WATCH -> HEALTHY needs score >= 78, dwell >= 2h.
    const belowHysteresis = decideBand({
      currentBand: 'watch',
      score: 77,
      nowMs: NOW,
      bandSinceMs: NOW - 3 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(belowHysteresis.changed).toBe(false);

    const insufficientDwell = decideBand({
      currentBand: 'watch',
      score: 78,
      nowMs: NOW,
      bandSinceMs: NOW - 1 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(insufficientDwell.changed).toBe(false);

    const satisfied = decideBand({
      currentBand: 'watch',
      score: 78,
      nowMs: NOW,
      bandSinceMs: NOW - 2 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(satisfied).toEqual({
      band: 'healthy',
      changed: true,
      direction: 'loosen',
      reason: 'hysteresis_dwell_satisfied',
    });

    // A hard signal 23h ago blocks WATCH -> HEALTHY even with score/dwell satisfied.
    const blockedByHardSignal = decideBand({
      currentBand: 'watch',
      score: 78,
      nowMs: NOW,
      bandSinceMs: NOW - 2 * HOUR,
      lastHardSignalAtMs: NOW - 23 * HOUR,
      recentBandChanges: [],
    });
    expect(blockedByHardSignal.changed).toBe(false);

    // DEGRADED -> WATCH needs score >= 63, dwell >= 6h.
    const degradedSatisfied = decideBand({
      currentBand: 'degraded',
      score: 63,
      nowMs: NOW,
      bandSinceMs: NOW - 6 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: [],
    });
    expect(degradedSatisfied.band).toBe('watch');
    expect(degradedSatisfied.changed).toBe(true);

    const degradedBlockedByHardSignal = decideBand({
      currentBand: 'degraded',
      score: 63,
      nowMs: NOW,
      bandSinceMs: NOW - 6 * HOUR,
      lastHardSignalAtMs: NOW - 23 * HOUR,
      recentBandChanges: [],
    });
    expect(degradedBlockedByHardSignal.changed).toBe(false);
  });

  it('at_most_one_improvement_per_6h_and_two_per_24h', () => {
    const baseInput = {
      currentBand: 'watch' as const,
      score: 78,
      nowMs: NOW,
      bandSinceMs: NOW - 2 * HOUR,
      lastHardSignalAtMs: null,
    };

    // One prior improvement 3h ago (within the 6h window) blocks a second.
    const oneRecentImprovement: BandChangeRecord[] = [
      { atMs: NOW - 3 * HOUR, from: 'degraded', to: 'watch' },
    ];
    const blockedBy6h = decideBand({ ...baseInput, recentBandChanges: oneRecentImprovement });
    expect(blockedBy6h.changed).toBe(false);

    // No improvement in the last 6h, but two improvements in the last 24h
    // already - the second cap blocks a third.
    const twoIn24h: BandChangeRecord[] = [
      { atMs: NOW - 20 * HOUR, from: 'critical', to: 'degraded' },
      { atMs: NOW - 10 * HOUR, from: 'degraded', to: 'watch' },
    ];
    const blockedBy24h = decideBand({ ...baseInput, recentBandChanges: twoIn24h });
    expect(blockedBy24h.changed).toBe(false);

    // Only one improvement in the last 24h (outside 6h) - allowed.
    const oneIn24h: BandChangeRecord[] = [{ atMs: NOW - 20 * HOUR, from: 'degraded', to: 'watch' }];
    const allowed = decideBand({ ...baseInput, recentBandChanges: oneIn24h });
    expect(allowed.changed).toBe(true);
    expect(allowed.direction).toBe('loosen');
  });

  it('hysteresis_and_dwell_prevent_flapping', () => {
    // Design-suite test 13 (SM-13): score oscillating across a threshold for 6h. Two prior
    // band changes within the last hour force flap-lock on a third
    // (loosening) attempt - reported via suppressedByFlap - while a
    // tightening attempt in the same window is still allowed immediately.
    const twoChangesLastHour: BandChangeRecord[] = [
      { atMs: NOW - 10 * 60 * 1000, from: 'degraded', to: 'watch' },
      { atMs: NOW - 40 * 60 * 1000, from: 'critical', to: 'degraded' },
    ];

    const loosenAttempt = decideBand({
      currentBand: 'watch',
      score: 78,
      nowMs: NOW,
      bandSinceMs: NOW - 2 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: twoChangesLastHour,
    });
    expect(loosenAttempt).toEqual({
      band: 'watch',
      changed: false,
      direction: 'none',
      suppressedByFlap: true,
      reason: 'flap_lock_1h',
    });

    const tightenAttempt = decideBand({
      currentBand: 'watch',
      score: 54,
      nowMs: NOW,
      bandSinceMs: NOW - 2 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: twoChangesLastHour,
    });
    expect(tightenAttempt.changed).toBe(true);
    expect(tightenAttempt.direction).toBe('tighten');
  });

  it('the_flap_lock_also_engages_on_a_tighten_tighten_then_loosen_sequence_within_an_hour', () => {
    // WARNING 4 fix (P16 fix round): the flap lock must count ANY band
    // change in the last hour, not just improvements - a
    // tighten-tighten-then-loosen sequence is exactly as flappy as
    // loosen-loosen-then-loosen, and must also engage the 1h lock.
    const oneTightenLastHour: BandChangeRecord[] = [
      { atMs: NOW - 10 * 60 * 1000, from: 'watch', to: 'degraded' },
      { atMs: NOW - 40 * 60 * 1000, from: 'healthy', to: 'watch' },
    ];

    const loosenAfterTwoTightens = decideBand({
      currentBand: 'degraded',
      score: 63, // DEGRADED -> WATCH hysteresis/dwell inputs below are satisfied.
      nowMs: NOW,
      bandSinceMs: NOW - 6 * HOUR,
      lastHardSignalAtMs: null,
      recentBandChanges: oneTightenLastHour,
    });
    expect(loosenAfterTwoTightens).toEqual({
      band: 'degraded',
      changed: false,
      direction: 'none',
      suppressedByFlap: true,
      reason: 'flap_lock_1h',
    });
  });
});
