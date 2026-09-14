import { describe, expect, it } from 'vitest';
import { passwordStrength } from '../password-strength.js';

/**
 * password-strength.test.ts (P26b U2) - exact-value assertions for every
 * scoring branch (test-discipline: never a bound, always the exact number).
 */
describe('passwordStrength', () => {
  it('short_password_scores_zero_and_is_weak', () => {
    expect(passwordStrength('short')).toEqual({ score: 0, label: 'weak' });
  });

  it('exactly_twelve_chars_letters_only_scores_one_and_is_weak', () => {
    expect(passwordStrength('abcdefghijkl')).toEqual({ score: 1, label: 'weak' });
  });

  it('twelve_chars_with_letter_and_digit_scores_two_and_is_fair', () => {
    expect(passwordStrength('abcdefghij12')).toEqual({ score: 2, label: 'fair' });
  });

  it('sixteen_chars_with_letter_and_digit_scores_three_and_is_good', () => {
    expect(passwordStrength('abcdefghijklmn12')).toEqual({ score: 3, label: 'good' });
  });

  it('sixteen_chars_with_letter_digit_and_symbol_scores_four_and_is_strong', () => {
    expect(passwordStrength('abcdefghijklmn1!')).toEqual({ score: 4, label: 'strong' });
  });

  it('short_password_with_letter_digit_and_symbol_scores_two_and_is_fair', () => {
    expect(passwordStrength('ab1!')).toEqual({ score: 2, label: 'fair' });
  });

  it('empty_password_scores_zero_and_is_weak', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: 'weak' });
  });
});
