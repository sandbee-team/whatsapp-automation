import { describe, expect, it } from 'vitest';
import { matchOptOutKeyword } from './match.js';
import { PLATFORM_OPTOUT_KEYWORDS } from './keywords.js';

describe('matchOptOutKeyword', () => {
  it('optout_keyword_matching_precision', () => {
    const matches: string[] = ['STOP', 'stop.', 'band karo', 'बंद करो', 'रोको'];
    for (const text of matches) {
      expect(matchOptOutKeyword(text, PLATFORM_OPTOUT_KEYWORDS)).not.toBeNull();
    }

    const nonMatches: string[] = [
      "please don't stop sending updates",
      'stopwatch order',
      'stop by tomorrow if you can',
    ];
    for (const text of nonMatches) {
      expect(matchOptOutKeyword(text, PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
    }
  });

  it('a_keyword_prefixed_message_over_four_tokens_does_not_match', () => {
    const fiveTokens = 'stop sending me these messages please';
    expect(matchOptOutKeyword(fiveTokens, PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
  });

  it('exact_keyword_match_returns_the_keyword', () => {
    expect(matchOptOutKeyword('stop', PLATFORM_OPTOUT_KEYWORDS)).toBe('stop');
    expect(matchOptOutKeyword('  STOP  ', PLATFORM_OPTOUT_KEYWORDS)).toBe('stop');
  });

  it('prefix_match_within_four_tokens_returns_the_keyword', () => {
    // "stop please" is <= 4 tokens and starts with the keyword "stop".
    expect(matchOptOutKeyword('stop please', PLATFORM_OPTOUT_KEYWORDS)).toBe('stop');
  });

  it('token_prefix_not_substring_stopwatch_does_not_match_stop', () => {
    expect(matchOptOutKeyword('stopwatch', PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
  });
});
