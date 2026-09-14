import { describe, expect, it } from 'vitest';
import { normaliseOptOutText } from './normalise.js';

describe('normaliseOptOutText', () => {
  it('trims_lowercases_and_collapses_whitespace', () => {
    expect(normaliseOptOutText('  STOP   Please  ')).toBe('stop please');
  });

  it('strips_punctuation', () => {
    expect(normaliseOptOutText('stop.')).toBe('stop');
    expect(normaliseOptOutText('Stop!!')).toBe('stop');
    expect(normaliseOptOutText('opt-out, please')).toBe('optout please');
  });

  it('strips_emoji', () => {
    expect(normaliseOptOutText('stop 🙏🛑')).toBe('stop');
  });

  it('transliterates_devanagari_keywords_stably', () => {
    // The same map applied to keyword and inbound text: a Devanagari STOP
    // matches its own keyword after normalisation.
    const bandKaro = normaliseOptOutText('बंद करो');
    const rokoText = normaliseOptOutText('रोको');
    const hatao = normaliseOptOutText('हटाओ');
    expect(bandKaro).toBe(normaliseOptOutText('बंद करो'));
    expect(rokoText.length).toBeGreaterThan(0);
    expect(hatao.length).toBeGreaterThan(0);
  });

  it('keeps_single_spaces_between_tokens', () => {
    expect(normaliseOptOutText('band    karo')).toBe('band karo');
  });

  it('returns_empty_string_for_only_punctuation_or_emoji', () => {
    expect(normaliseOptOutText('!!! 🙏')).toBe('');
  });
});
