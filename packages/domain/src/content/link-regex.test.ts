import { describe, expect, it } from 'vitest';
import { LINK_RE, containsLink } from './link-regex.js';

describe('containsLink', () => {
  it('matches_http_and_https_urls', () => {
    expect(containsLink('check http://example.com now')).toBe(true);
    expect(containsLink('check https://example.com/offer now')).toBe(true);
  });

  it('matches_www_prefixed_hosts', () => {
    expect(containsLink('go to www.example.com today')).toBe(true);
  });

  it('matches_bare_t_me_and_wa_me', () => {
    expect(containsLink('join t.me/mygroup')).toBe(true);
    expect(containsLink('chat wa.me/919999999999')).toBe(true);
  });

  it('matches_known_shorteners', () => {
    const shorteners = [
      'bit.ly/abc',
      'tinyurl.com/abc',
      'goo.gl/abc',
      't.co/abc',
      'cutt.ly/abc',
      'rb.gy/abc',
      'is.gd/abc',
    ];
    for (const s of shorteners) {
      expect(containsLink(`click ${s} now`)).toBe(true);
    }
  });

  it('matches_bare_host_dot_tld_slash_path', () => {
    expect(containsLink('visit example.com/offer for details')).toBe(true);
  });

  it('does_not_match_plain_sentences_with_dots', () => {
    expect(containsLink('Hi Mr. Sharma. Meet at 5.30')).toBe(false);
  });

  it('does_not_match_version_numbers', () => {
    expect(containsLink('running version 2.5.1 now')).toBe(false);
  });

  it('does_not_match_abbreviations', () => {
    expect(containsLink('e.g. tomorrow we ship')).toBe(false);
  });

  it('does_not_match_plain_words_with_dots_and_no_path', () => {
    expect(containsLink('something.else entirely')).toBe(false);
  });

  it('link_re_is_global_and_reusable', () => {
    expect(LINK_RE.global).toBe(true);
    // Using it directly twice must not carry lastIndex state across calls
    // in a way that breaks containsLink's own internal reset.
    expect(containsLink('visit example.com/a')).toBe(true);
    expect(containsLink('visit example.com/b')).toBe(true);
  });
});
