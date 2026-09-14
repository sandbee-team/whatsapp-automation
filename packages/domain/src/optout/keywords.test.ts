import { describe, expect, it } from 'vitest';
import { PLATFORM_OPTOUT_KEYWORDS, resolveOptOutKeywords } from './keywords.js';

describe('PLATFORM_OPTOUT_KEYWORDS', () => {
  it('matches_the_blueprint_list_verbatim', () => {
    expect(PLATFORM_OPTOUT_KEYWORDS).toEqual([
      'stop',
      'stopall',
      'unsubscribe',
      'opt out',
      'optout',
      'remove me',
      'do not message',
      'dnd',
      'band karo',
      'band karo message',
      'mat bhejo',
      'rok do',
      'बंद करो',
      'रोको',
      'हटाओ',
    ]);
  });

  it('is_frozen', () => {
    expect(Object.isFrozen(PLATFORM_OPTOUT_KEYWORDS)).toBe(true);
  });
});

describe('resolveOptOutKeywords', () => {
  it('platform_keywords_cannot_be_removed_only_added_to', () => {
    // Additive tenant keyword: allowed, and platform keywords still present.
    const resolved = resolveOptOutKeywords(['unroll from list']);
    for (const platformKeyword of PLATFORM_OPTOUT_KEYWORDS) {
      expect(resolved).toContain(platformKeyword);
    }
    expect(resolved).toContain('unroll from list');

    // Shadowing a platform keyword (same normalised form) throws.
    expect(() => resolveOptOutKeywords(['STOP'])).toThrow();
    expect(() => resolveOptOutKeywords(['  Stop.  '])).toThrow();
    expect(() => resolveOptOutKeywords(['Band Karo'])).toThrow();

    // Empty tenant list: platform list returned unchanged (as a set).
    const empty = resolveOptOutKeywords([]);
    expect(empty).toEqual(PLATFORM_OPTOUT_KEYWORDS);
  });

  it('tenant_list_is_additive_and_deduplicated', () => {
    const resolved = resolveOptOutKeywords(['leave me alone', 'leave me alone']);
    const count = resolved.filter((k) => k === 'leave me alone').length;
    expect(count).toBe(1);
  });
});
