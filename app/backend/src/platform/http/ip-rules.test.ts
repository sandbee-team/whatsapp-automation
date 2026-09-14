import { describe, expect, it } from 'vitest';
import {
  classifyHostnameLiteral,
  classifyIpv4,
  classifyIpv6,
  classifyResolvedAddress,
} from './ip-rules.js';

/**
 * ip-rules.test.ts (P15 Unit U3) - every denied range and literal form for
 * both address families, including the mapped/decimal/octal encodings the
 * design canon calls out by name.
 */
describe('ip-rules: IPv4 denied ranges', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link_local'],
    ['169.254.0.1', 'link_local'],
    ['10.0.0.5', 'private_rfc1918'],
    ['10.255.255.255', 'private_rfc1918'],
    ['172.16.0.1', 'private_rfc1918'],
    ['172.31.255.255', 'private_rfc1918'],
    ['192.168.1.1', 'private_rfc1918'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    // MINOR FIX: additional reserved/special-purpose ranges (IANA "Special
    // -Purpose Address Registry") not previously classified.
    ['192.0.0.0', 'reserved'],
    ['192.0.0.255', 'reserved'],
    ['198.18.0.0', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['224.0.0.0', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.0', 'reserved'],
    ['255.255.255.254', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ])('classifyIpv4(%s) denies as %s', (address, reason) => {
    const result = classifyIpv4(address);
    expect(result.denied).toBe(true);
    expect(result.reason).toBe(reason);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['172.32.0.1'],
    ['100.63.255.255'],
    ['100.128.0.0'],
    ['192.0.1.0'], // just past 192.0.0.0/24
    ['198.17.255.255'], // just before 198.18.0.0/15
    ['198.20.0.0'], // just past 198.18.0.0/15
    ['223.255.255.255'], // just before 224.0.0.0/4
  ])('classifyIpv4(%s) is allowed', (address) => {
    expect(classifyIpv4(address)).toEqual({ denied: false });
  });
});

describe('ip-rules: IPv6 denied ranges', () => {
  it('classifyIpv6(::1) denies as ipv6_loopback', () => {
    const result = classifyIpv6('::1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('ipv6_loopback');
  });

  it('classifyIpv6(::) denies as unspecified', () => {
    const result = classifyIpv6('::');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('unspecified');
  });

  it.each([['fd00::1'], ['fc00::1'], ['fdff:ffff:ffff::1']])(
    'classifyIpv6(%s) denies as ipv6_ula',
    (address) => {
      const result = classifyIpv6(address);
      expect(result.denied).toBe(true);
      expect(result.reason).toBe('ipv6_ula');
    },
  );

  it.each([['fe80::1'], ['fe80::abcd:1234']])(
    'classifyIpv6(%s) denies as link_local',
    (address) => {
      const result = classifyIpv6(address);
      expect(result.denied).toBe(true);
      expect(result.reason).toBe('link_local');
    },
  );

  it('classifyIpv6(2001:4860:4860::8888) is allowed (public)', () => {
    expect(classifyIpv6('2001:4860:4860::8888')).toEqual({ denied: false });
  });
});

describe('ip-rules: IPv4-mapped IPv6', () => {
  it('classifyIpv6(::ffff:127.0.0.1) denies as ipv6_mapped_denied', () => {
    const result = classifyIpv6('::ffff:127.0.0.1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('ipv6_mapped_denied');
  });

  it('classifyIpv6(::ffff:7f00:1) (hex-group mapped loopback) denies as ipv6_mapped_denied', () => {
    const result = classifyIpv6('::ffff:7f00:1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('ipv6_mapped_denied');
  });

  it('classifyIpv6(::ffff:8.8.8.8) (mapped public address) is allowed', () => {
    expect(classifyIpv6('::ffff:8.8.8.8')).toEqual({ denied: false });
  });

  it('classifyIpv6(0:0:0:0:0:ffff:127.0.0.1) (non-::-anchored mapped form) denies as ipv6_mapped_denied', () => {
    // MINOR FIX: the fully-expanded (non-`::`-anchored) mapped form was
    // previously invisible to isIpv4MappedIpv6's `^::ffff:` anchor.
    const result = classifyIpv6('0:0:0:0:0:ffff:127.0.0.1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('ipv6_mapped_denied');
  });

  it('classifyIpv6(0:0:0:0:0:ffff:7f00:1) (non-::-anchored hex-group mapped form) denies as ipv6_mapped_denied', () => {
    const result = classifyIpv6('0:0:0:0:0:ffff:7f00:1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('ipv6_mapped_denied');
  });

  it('classifyIpv6(0:0:0:0:0:ffff:8.8.8.8) (non-::-anchored mapped public address) is allowed', () => {
    expect(classifyIpv6('0:0:0:0:0:ffff:8.8.8.8')).toEqual({ denied: false });
  });
});

describe('ip-rules: classifyResolvedAddress dispatches by family', () => {
  it('family 4 uses IPv4 rules', () => {
    expect(classifyResolvedAddress('10.0.0.1', 4).denied).toBe(true);
  });
  it('family 6 uses IPv6 rules', () => {
    expect(classifyResolvedAddress('::1', 6).denied).toBe(true);
  });
});

describe('ip-rules: classifyHostnameLiteral numeric-literal encodings', () => {
  it('decimal 32-bit integer literal 2130706433 (=127.0.0.1) denies as loopback', () => {
    const result = classifyHostnameLiteral('2130706433');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('loopback');
  });

  it('octal dotted-quad literal 0177.0.0.1 (=127.0.0.1) denies as loopback', () => {
    const result = classifyHostnameLiteral('0177.0.0.1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('loopback');
  });

  it('hex octet literal 0x7f.0.0.1 denies as loopback', () => {
    const result = classifyHostnameLiteral('0x7f.0.0.1');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('loopback');
  });

  it('hex 32-bit integer literal 0x7f000001 denies as loopback', () => {
    const result = classifyHostnameLiteral('0x7f000001');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('loopback');
  });

  it('bracketed IPv6 literal [::1] denies as ipv6_loopback', () => {
    const result = classifyHostnameLiteral('[::1]');
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('ipv6_loopback');
  });

  it('an ordinary DNS name is allowed at the hostname-literal stage (judged later by resolved address)', () => {
    expect(classifyHostnameLiteral('example.com')).toEqual({ denied: false });
  });

  it('a public dotted-quad literal is allowed', () => {
    expect(classifyHostnameLiteral('8.8.8.8')).toEqual({ denied: false });
  });
});
