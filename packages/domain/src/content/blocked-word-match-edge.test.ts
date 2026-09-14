import { describe, expect, it } from 'vitest';
import { matchBlockedWord, type BlockedWordEntry } from './blocked-word-match.js';

/**
 * blocked-word-match-edge.test.ts (P14 E3 edge pass) - `matchBlockedWord`
 * input edges: empty body, a tenant word containing regex metacharacters
 * (must not blow up the matcher AND must not accidentally match a superset
 * string via the metacharacter's regex meaning), and the leet edge "0" alone
 * (a bare leet digit is not itself a blocked word, so this only matters when
 * "0" is part of a configured word/phrase).
 */
describe('matchBlockedWord edge cases', () => {
  it('empty_body_never_matches_and_never_throws', () => {
    const entries: BlockedWordEntry[] = [{ word: 'loan', category: 'loan_shark' }];
    expect(() => matchBlockedWord('', entries)).not.toThrow();
    expect(matchBlockedWord('', entries)).toBeNull();
  });

  it('empty_entries_list_never_matches', () => {
    expect(matchBlockedWord('anything at all', [])).toBeNull();
  });

  it('a_tenant_word_containing_regex_metacharacters_does_not_throw_and_does_not_match_as_a_pattern', () => {
    // "a+b" as a LITERAL phrase must not be interpreted as the regex
    // quantifier "one-or-more a, then b" - it must only match the literal
    // three-character token "a+b", never "aab" (which "a+b" WOULD match if
    // treated as a live regex).
    const entries: BlockedWordEntry[] = [{ word: 'a+b', category: 'tenant' }];
    expect(() => matchBlockedWord('aab', entries)).not.toThrow();
    expect(matchBlockedWord('aab', entries)).toBeNull();
    expect(matchBlockedWord('the code is a+b today', entries)).toEqual({ category: 'tenant' });
  });

  it('a_metacharacter_word_with_no_leading_or_trailing_punctuation_is_escaped_safely', () => {
    const entries: BlockedWordEntry[] = [{ word: 'a.b*c', category: 'tenant' }];
    expect(() => matchBlockedWord('random unrelated text', entries)).not.toThrow();
    expect(matchBlockedWord('a.b*c is the code', entries)).toEqual({ category: 'tenant' });
    // Metacharacters must not act as wildcards against unrelated text.
    expect(matchBlockedWord('axbyyyc is unrelated', entries)).toBeNull();
  });

  // A phrase whose first/last character is itself punctuation (non-word):
  // `\b` can never match there (it requires a word-char/non-word-char
  // transition), so the matcher uses a lookaround on that edge instead,
  // which is vacuously satisfied next to a non-word boundary. Verbatim
  // occurrences must match even though the phrase's own edges are
  // punctuation.
  it('a_word_with_punctuation_edges_matches_verbatim_occurrences', () => {
    const entries: BlockedWordEntry[] = [{ word: '$100 (free)', category: 'tenant' }];
    expect(() => matchBlockedWord('get $100 (free) now', entries)).not.toThrow();
    expect(matchBlockedWord('get $100 (free) now', entries)).toEqual({ category: 'tenant' });
  });

  it('a_word_with_punctuation_edges_does_not_match_when_the_verbatim_phrase_is_absent', () => {
    // The configured phrase is "$100 (free)"; embedding a different
    // trailing character after "free" (no closing paren) means the
    // verbatim phrase never occurs, so it must not match.
    const entries: BlockedWordEntry[] = [{ word: '$100 (free)', category: 'tenant' }];
    expect(matchBlockedWord('get $100 (free now', entries)).toBeNull();
  });

  it('a_bare_leet_zero_alone_is_not_a_configured_word_and_never_matches', () => {
    const entries: BlockedWordEntry[] = [{ word: 'loan', category: 'loan_shark' }];
    expect(matchBlockedWord('0', entries)).toBeNull();
  });

  it('a_word_containing_a_bare_leet_zero_still_matches_via_deleetification', () => {
    // "0tp" -> deleetified "otp"; the configured word is "otp" itself.
    const entries: BlockedWordEntry[] = [{ word: 'otp', category: 'otp_harvesting' }];
    expect(matchBlockedWord('send the 0tp now', entries)).toEqual({ category: 'otp_harvesting' });
  });
});
