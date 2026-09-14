import { describe, expect, it } from 'vitest';
import { createDwrrSelector, DEFAULT_BAND_WEIGHTS, type Band } from './dwrr.js';

describe('createDwrrSelector', () => {
  it('high_flood_does_not_starve_low', () => {
    const selector = createDwrrSelector();
    const counts: Record<Band, number> = { HIGH: 0, NORMAL: 0, LOW: 0 };
    const totalSelections = 10_000;

    // Continuous HIGH flood, steady NORMAL/LOW supply: all three bands
    // always have an eligible job available on every single call.
    const available = { HIGH: true, NORMAL: true, LOW: true };

    for (let i = 0; i < totalSelections; i += 1) {
      const band = selector.next(available);
      expect(band).not.toBeNull();
      if (band !== null) counts[band] += 1;
    }

    const normalShare = counts.NORMAL / totalSelections;
    const lowShare = counts.LOW / totalSelections;

    // Weights are 60/30/10 (6:3:1) - NORMAL and LOW must clear a throughput
    // floor derived from those weights, with tolerance, even under a
    // continuous HIGH flood.
    expect(normalShare).toBeGreaterThanOrEqual(0.25);
    expect(lowShare).toBeGreaterThanOrEqual(0.07);

    // HIGH must not be starved out entirely either (sanity on the weights).
    expect(counts.HIGH).toBeGreaterThan(0);
    expect(counts.HIGH + counts.NORMAL + counts.LOW).toBe(totalSelections);
  });

  it('never selects a band with nothing available, and returns null when nothing is available', () => {
    const selector = createDwrrSelector();
    expect(selector.next({ HIGH: false, NORMAL: false, LOW: false })).toBeNull();

    const onlyLow = createDwrrSelector();
    for (let i = 0; i < 5; i += 1) {
      expect(onlyLow.next({ HIGH: false, NORMAL: false, LOW: true })).toBe('LOW');
    }
  });

  it('exposes the default 60/30/10 band weights', () => {
    expect(DEFAULT_BAND_WEIGHTS).toEqual({ HIGH: 6, NORMAL: 3, LOW: 1 });
  });

  // --- Edge-case pass (session C2) ----------------------------------------

  it('repeated_calls_with_nothing_available_always_return_null_no_infinite_loop', () => {
    const selector = createDwrrSelector();
    const none = { HIGH: false, NORMAL: false, LOW: false };
    for (let i = 0; i < 100; i += 1) {
      expect(selector.next(none)).toBeNull();
    }
  });

  it('only_normal_available_always_selects_normal', () => {
    const selector = createDwrrSelector();
    for (let i = 0; i < 20; i += 1) {
      expect(selector.next({ HIGH: false, NORMAL: true, LOW: false })).toBe('NORMAL');
    }
  });

  it('only_high_available_always_selects_high', () => {
    const selector = createDwrrSelector();
    for (let i = 0; i < 20; i += 1) {
      expect(selector.next({ HIGH: true, NORMAL: false, LOW: false })).toBe('HIGH');
    }
  });

  it('constructing_with_a_zero_negative_or_fractional_weight_throws', () => {
    // MAJOR 7: weights are integer credit units by design - createDwrrSelector
    // must reject anything that is not a positive integer >= 1 at
    // construction, rather than silently accepting it and letting it never
    // accrue enough deficit to be selected (the old, weaker behavior).
    expect(() => createDwrrSelector({ HIGH: 6, NORMAL: 0, LOW: 1 })).toThrow(RangeError);
    expect(() => createDwrrSelector({ HIGH: 6, NORMAL: -5, LOW: 1 })).toThrow(RangeError);
    expect(() => createDwrrSelector({ HIGH: 6, NORMAL: 1.5, LOW: 1 })).toThrow(RangeError);
  });

  it('a_permanently_absent_band_does_not_accumulate_unbounded_deficit_over_a_long_run', () => {
    const selector = createDwrrSelector();
    // LOW is never available across 10,000 ticks; HIGH/NORMAL alternate
    // availability. The implementation resets an unavailable band's deficit
    // to 0 on every visit (see dwrr.ts), so nothing should ever accumulate
    // there - assert indirectly: once LOW becomes available again, it must
    // be served within one full weighted pass, not instantly monopolize the
    // queue from a huge stashed deficit.
    for (let i = 0; i < 10_000; i += 1) {
      selector.next({ HIGH: true, NORMAL: true, LOW: false });
    }

    const afterCounts: Record<Band, number> = { HIGH: 0, NORMAL: 0, LOW: 0 };
    for (let i = 0; i < 20; i += 1) {
      const band = selector.next({ HIGH: true, NORMAL: true, LOW: true });
      if (band !== null) afterCounts[band] += 1;
    }

    // LOW's weight is 1 out of 10 total - across 20 selections it should be
    // picked a small, bounded number of times (not a huge backlog burst),
    // proving no unbounded deficit was hoarded while it was absent.
    expect(afterCounts.LOW).toBeLessThanOrEqual(4);
  });
});
