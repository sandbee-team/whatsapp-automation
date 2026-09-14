import { describe, expect, it } from 'vitest';
import { normaliseForFingerprint } from './normalise-body.js';
import { containsLink } from './link-regex.js';

/**
 * normalise-body-edge.test.ts (P14 E3 edge pass) - `normaliseForFingerprint`
 * / `containsLink` input edges: empty body, a body that is only a URL, a
 * 2048-byte max payload body, and a body of only template placeholders
 * (two different all-placeholder messages must not crash the pipeline even
 * if their normalised/fingerprinted forms collide - collision itself is
 * documented as acceptable).
 */
describe('normaliseForFingerprint edge cases', () => {
  it('empty_body_normalises_to_empty_string_and_never_throws', () => {
    expect(() => normaliseForFingerprint('')).not.toThrow();
    expect(normaliseForFingerprint('')).toBe('');
  });

  it('a_body_of_only_a_url_normalises_to_the_url_placeholder', () => {
    expect(normaliseForFingerprint('https://example.com/offer')).toBe('<url>');
    expect(containsLink('https://example.com/offer')).toBe(true);
  });

  it('a_2048_byte_body_normalises_without_throwing', () => {
    const body = `${'a'.repeat(2000)} https://example.com/offer 123456 {{name}}`.slice(0, 2048);
    expect(() => normaliseForFingerprint(body)).not.toThrow();
    const result = normaliseForFingerprint(body);
    expect(typeof result).toBe('string');
  });

  it('a_body_of_only_template_placeholders_normalises_to_empty_string', () => {
    expect(normaliseForFingerprint('{{a}} {{b}}')).toBe('');
  });

  it('two_different_all_placeholder_messages_normalise_to_the_same_empty_string_without_crashing', () => {
    // Documented-acceptable collision: two structurally different
    // all-placeholder templates fingerprint identically. The contract here
    // is "must not crash", not "must not collide".
    const a = normaliseForFingerprint('{{first_name}} {{last_name}} {{order_id}}');
    const b = normaliseForFingerprint('{{x}}{{y}}');
    expect(a).toBe('');
    expect(b).toBe('');
    expect(a).toBe(b);
  });
});

describe('containsLink edge cases', () => {
  it('empty_body_never_matches_and_never_throws', () => {
    expect(() => containsLink('')).not.toThrow();
    expect(containsLink('')).toBe(false);
  });
});
