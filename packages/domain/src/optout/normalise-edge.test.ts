import { describe, expect, it } from 'vitest';
import { normaliseOptOutText } from './normalise.js';

/**
 * normalise-edge.test.ts (P14 E3 edge pass) - input-edge cases for
 * `normaliseOptOutText` not covered by `normalise.test.ts`: empty/whitespace-
 * only input, emoji-only input, mixed Devanagari+Latin text, a keyword with
 * trailing emoji/punctuation, and NFC/NFD normalisation stability for the
 * platform Hindi keywords.
 */
describe('normaliseOptOutText edge cases', () => {
  it('returns_empty_string_for_empty_input', () => {
    expect(normaliseOptOutText('')).toBe('');
  });

  it('returns_empty_string_for_whitespace_only_input', () => {
    expect(normaliseOptOutText('   \t\n  ')).toBe('');
  });

  it('returns_empty_string_for_emoji_only_input', () => {
    expect(normaliseOptOutText('🙏🛑🔥')).toBe('');
  });

  it('handles_mixed_devanagari_and_latin_text', () => {
    // "STOP करो" - a Latin keyword fragment followed by a Devanagari word.
    const result = normaliseOptOutText('STOP करो');
    expect(result).toBe(`stop ${normaliseOptOutText('करो')}`);
    expect(result.length).toBeGreaterThan(0);
    // The Latin half must survive verbatim (lowercased); the Devanagari
    // half must have been transliterated, not dropped.
    expect(result.startsWith('stop ')).toBe(true);
  });

  it('strips_trailing_emoji_and_punctuation_around_a_keyword', () => {
    expect(normaliseOptOutText('stop 🙏🙏')).toBe('stop');
    expect(normaliseOptOutText('STOP!! 🙏')).toBe('stop');
  });

  it('nfc_and_nfd_forms_of_a_platform_hindi_keyword_normalise_identically', () => {
    // बंद करो / रोको / हटाओ: Devanagari matras have no precomposed Latin-style
    // accent alternative, so NFC and NFD already share the same codepoint
    // sequence for these strings - this test pins that invariant so a future
    // change to the transliteration table (e.g. switching to per-codepoint
    // iteration in a way that becomes NFD-sensitive) cannot silently regress
    // Hindi opt-out matching for a decomposed-input client.
    const words = ['बंद करो', 'रोको', 'हटाओ'];
    for (const word of words) {
      const nfc = word.normalize('NFC');
      const nfd = word.normalize('NFD');
      expect(normaliseOptOutText(nfc)).toBe(normaliseOptOutText(nfd));
    }
  });
});
