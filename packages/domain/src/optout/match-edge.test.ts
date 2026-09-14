import { describe, expect, it } from 'vitest';
import { matchOptOutKeyword } from './match.js';
import { resolveOptOutKeywords, PLATFORM_OPTOUT_KEYWORDS } from './keywords.js';

/**
 * match-edge.test.ts (P14 E3 edge pass) - the exact 4-token vs 5-token
 * prefix-match boundary (pinned exactly, not just "a long message doesn't
 * match"), plus empty/whitespace/emoji-only input to the matcher itself and
 * a tenant keyword that normalises to empty string via `resolveOptOutKeywords`.
 */
describe('matchOptOutKeyword edge cases', () => {
  it('a_keyword_prefixed_message_of_exactly_four_tokens_matches', () => {
    // "stop sending me messages" is exactly 4 tokens and starts with "stop".
    const fourTokens = 'stop sending me messages';
    expect(matchOptOutKeyword(fourTokens, PLATFORM_OPTOUT_KEYWORDS)).toBe('stop');
  });

  it('a_keyword_prefixed_message_of_exactly_five_tokens_does_not_match', () => {
    // "stop sending me these messages" is exactly 5 tokens.
    const fiveTokens = 'stop sending me these messages';
    expect(matchOptOutKeyword(fiveTokens, PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
  });

  it('empty_string_never_matches', () => {
    expect(matchOptOutKeyword('', PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
  });

  it('whitespace_only_never_matches', () => {
    expect(matchOptOutKeyword('   \t  ', PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
  });

  it('emoji_only_never_matches', () => {
    expect(matchOptOutKeyword('🙏🛑', PLATFORM_OPTOUT_KEYWORDS)).toBeNull();
  });
});

describe('resolveOptOutKeywords: tenant keyword normalising to empty', () => {
  it('a_tenant_keyword_that_normalises_to_empty_string_is_not_matchable_against_every_message', () => {
    // A tenant entry of pure punctuation/emoji normalises to "" - if it were
    // added to the resolved list as-is, `matchOptOutKeyword`'s `tokens()`
    // helper would treat it as a zero-token keyword; `matchOptOutKeyword`
    // explicitly `continue`s past any keyword whose own token list is empty
    // (see match.ts), so this must never cause every message to opt out.
    const resolved = resolveOptOutKeywords(['!!! 🙏']);
    // The empty-normalising tenant keyword should not have shadowed any
    // platform keyword (its normalised form "" is not a platform keyword),
    // so it is appended additively.
    expect(resolved).toContain('!!! 🙏');

    // An unrelated, otherwise-clean message must still NOT match anything -
    // the empty-token keyword must never act as a universal matcher.
    expect(
      matchOptOutKeyword('see you at the meeting tomorrow morning please', resolved),
    ).toBeNull();
    expect(matchOptOutKeyword('thanks for the update', resolved)).toBeNull();
  });
});
