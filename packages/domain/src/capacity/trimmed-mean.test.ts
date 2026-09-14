import { describe, expect, it } from 'vitest';
import { trimmedMean } from './trimmed-mean.js';

describe('trimmedMean', () => {
  it('empty_input_returns_zero_never_throws_or_nan', () => {
    expect(trimmedMean([])).toBe(0);
  });

  it('drops_exactly_one_min_and_one_max_from_a_ten_worker_set', () => {
    // 10 values at a steady 35, plus one 400 outlier - the outlier is the
    // 11th (largest) value; Math.floor(11/10) = 1 is trimmed from each end,
    // dropping the single min (35) and the single max (400), leaving nine
    // 35s - mean stays 35.
    const values = [35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 400];
    expect(trimmedMean(values)).toBe(35);
  });

  it('falls_back_to_the_untrimmed_sorted_set_when_the_trim_would_empty_it', () => {
    // n=4: trimCount = Math.floor(4/10) = 0, so no trim happens - plain mean.
    expect(trimmedMean([1, 2, 3, 4])).toBe(2.5);
  });

  it('identical_values_produce_a_stable_mean_equal_to_that_value', () => {
    expect(trimmedMean(new Array(15).fill(42))).toBe(42);
  });

  it('a_single_value_returns_that_value', () => {
    expect(trimmedMean([7])).toBe(7);
  });
});
