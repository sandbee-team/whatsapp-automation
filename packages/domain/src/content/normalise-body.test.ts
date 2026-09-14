import { describe, expect, it } from 'vitest';
import { normaliseForFingerprint } from './normalise-body.js';

describe('normaliseForFingerprint', () => {
  it('lowercases', () => {
    expect(normaliseForFingerprint('Hello World')).toBe('hello world');
  });

  it('replaces_urls_with_placeholder', () => {
    expect(normaliseForFingerprint('Visit https://example.com/offer now')).toBe('visit <url> now');
    expect(normaliseForFingerprint('go to www.example.com today')).toBe('go to <url> today');
  });

  it('replaces_digit_runs_with_hash', () => {
    expect(normaliseForFingerprint('Your OTP is 123456')).toBe('your otp is #');
    expect(normaliseForFingerprint('Order 42 of 100 items')).toBe('order # of # items');
  });

  it('strips_emoji', () => {
    expect(normaliseForFingerprint('Hello 🎉🔥 world')).toBe('hello world');
  });

  it('collapses_whitespace', () => {
    expect(normaliseForFingerprint('hello    world\n\nfoo')).toBe('hello world foo');
  });

  it('strips_template_placeholder_syntax_but_keeps_resolved_values', () => {
    expect(normaliseForFingerprint('Hi {{name}}, your order is ready')).toBe(
      'hi , your order is ready',
    );
    // Already-resolved values (e.g. "Hi Rahul,") are ordinary text and are
    // NOT stripped - only the {{...}} placeholder syntax is.
    expect(normaliseForFingerprint('Hi Rahul, your order is ready')).toBe(
      'hi rahul, your order is ready',
    );
  });
});
