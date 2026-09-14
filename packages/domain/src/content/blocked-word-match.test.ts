import { describe, expect, it } from 'vitest';
import {
  matchBlockedWord,
  matchPreparedBlockedWord,
  prepareBlockedWordEntries,
  PLATFORM_BLOCKED_WORDS,
  type BlockedWordEntry,
} from './blocked-word-match.js';

describe('matchBlockedWord', () => {
  it('returns_only_the_category_never_the_matched_word', () => {
    const entries: BlockedWordEntry[] = [
      { word: 'you have won a lottery', category: 'lottery_prize' },
    ];
    const result = matchBlockedWord('congrats, you have won a lottery today', entries);
    expect(result).toEqual({ category: 'lottery_prize' });
    expect(Object.keys(result ?? {})).toEqual(['category']);
    expect(JSON.stringify(result)).not.toContain('won');
    expect(JSON.stringify(result)).not.toContain('lottery"');
  });

  it('returns_null_when_nothing_matches', () => {
    const entries: BlockedWordEntry[] = [{ word: 'lucky draw winner', category: 'lottery_prize' }];
    expect(matchBlockedWord('have a great day', entries)).toBeNull();
  });

  it('matches_leet_variants', () => {
    const entries: BlockedWordEntry[] = [{ word: 'send me the otp', category: 'otp_harvesting' }];
    expect(matchBlockedWord('pls s3nd me the 0tp asap', entries)).toEqual({
      category: 'otp_harvesting',
    });
  });

  it('respects_word_boundaries', () => {
    const entries: BlockedWordEntry[] = [{ word: 'loan', category: 'loan_shark' }];
    // "loaned" contains "loan" as a substring but not as a whole word/phrase.
    expect(matchBlockedWord('I loaned my brother some cash', entries)).toBeNull();
    expect(matchBlockedWord('need a quick loan today', entries)).toEqual({
      category: 'loan_shark',
    });
  });

  it('platform_blocked_words_are_frozen_and_cover_every_category', () => {
    expect(Object.isFrozen(PLATFORM_BLOCKED_WORDS)).toBe(true);
    const categories = new Set(PLATFORM_BLOCKED_WORDS.map((e) => e.category));
    for (const expected of [
      'payment_fraud',
      'otp_harvesting',
      'lottery_prize',
      'loan_shark',
      'adult',
      'illegal_offer',
    ]) {
      expect(categories).toContain(expected);
    }
  });

  it('tenant_entries_use_the_category_the_caller_supplies', () => {
    const entries: BlockedWordEntry[] = [{ word: 'competitor brand x', category: 'tenant' }];
    expect(matchBlockedWord('buy competitor brand x today', entries)).toEqual({
      category: 'tenant',
    });
  });

  describe('prepareBlockedWordEntries / matchPreparedBlockedWord (MINOR 14, P14 review-fix F2)', () => {
    it('prepared_entries_match_identically_to_the_unprepared_path', () => {
      const entries: BlockedWordEntry[] = [
        { word: 'send me the otp', category: 'otp_harvesting' },
        { word: 'loan', category: 'loan_shark' },
      ];
      const prepared = prepareBlockedWordEntries(entries);

      expect(matchPreparedBlockedWord('pls s3nd me the 0tp asap', prepared)).toEqual({
        category: 'otp_harvesting',
      });
      expect(matchPreparedBlockedWord('I loaned my brother some cash', prepared)).toBeNull();
      expect(matchPreparedBlockedWord('need a quick loan today', prepared)).toEqual({
        category: 'loan_shark',
      });
      expect(matchPreparedBlockedWord('have a great day', prepared)).toBeNull();
    });

    it('the_same_prepared_entries_array_is_reusable_across_many_calls_without_recompiling', () => {
      // The whole point of MINOR 14: one prepareBlockedWordEntries() call
      // per claimAndReserve pass, reused across every job in that pass -
      // proves the SAME prepared array works correctly called repeatedly.
      const prepared = prepareBlockedWordEntries(PLATFORM_BLOCKED_WORDS);
      for (let i = 0; i < 5; i += 1) {
        expect(matchPreparedBlockedWord('you have won a lottery today', prepared)).toEqual({
          category: 'lottery_prize',
        });
        expect(matchPreparedBlockedWord('a perfectly ordinary message', prepared)).toBeNull();
      }
    });
  });
});
