/**
 * password-strength.ts (P26b U2) - a pure function driving the signup
 * form's 4-segment strength meter. Never used for validation (the zod
 * `signupInputSchema` owns the real 12-char minimum) - this is a UX hint
 * only, so weakening/strengthening this function can never change whether a
 * password is accepted.
 *
 * Scoring (0-4 filled segments): +1 for length >= 12, +1 for length >= 16,
 * +1 for containing both a letter and a digit, +1 for containing a symbol
 * (any non-alphanumeric character). Capped at 4.
 */
export type PasswordStrengthLabel = 'weak' | 'fair' | 'good' | 'strong';

export interface PasswordStrengthResult {
  /** Filled segment count, 0-4. */
  score: number;
  label: PasswordStrengthLabel;
}

const HAS_LETTER = /[a-zA-Z]/;
const HAS_DIGIT = /\d/;
const HAS_SYMBOL = /[^a-zA-Z0-9]/;

const LABEL_BY_SCORE: Record<number, PasswordStrengthLabel> = {
  0: 'weak',
  1: 'weak',
  2: 'fair',
  3: 'good',
  4: 'strong',
};

export function passwordStrength(password: string): PasswordStrengthResult {
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (HAS_LETTER.test(password) && HAS_DIGIT.test(password)) score += 1;
  if (HAS_SYMBOL.test(password)) score += 1;

  return { score, label: LABEL_BY_SCORE[score] ?? 'weak' };
}
