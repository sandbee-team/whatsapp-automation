import { describe, expect, it } from 'vitest';
import { isIpAllowed } from '../src/auth/cidr.js';

/**
 * cidr.test.ts (P28 Unit U2, step 3) - `@wp/server-kit/auth`'s own coverage
 * of `isIpAllowed`, MOVED byte-for-byte from
 * `app/backend/src/modules/internal/service-token.ts` (P19 Unit U5).
 */

describe('isIpAllowed', () => {
  it('a_zero_zero_zero_zero_slash_zero_cidr_matches_any_ipv4_address', () => {
    expect(isIpAllowed('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(isIpAllowed('255.255.255.255', '0.0.0.0/0')).toBe(true);
  });

  it('an_empty_allow_list_matches_nothing', () => {
    expect(isIpAllowed('10.0.1.5', '')).toBe(false);
  });

  it('an_ipv6_literal_never_matches', () => {
    expect(isIpAllowed('::1', '0.0.0.0/0')).toBe(false);
    expect(isIpAllowed('2001:db8::1', '2001:db8::/32')).toBe(false);
  });

  it('an_address_inside_the_allow_listed_cidr_is_allowed', () => {
    expect(isIpAllowed('10.0.1.5', '10.0.0.0/8')).toBe(true);
  });

  it('an_address_outside_every_allow_listed_cidr_is_denied', () => {
    expect(isIpAllowed('203.0.113.5', '10.0.0.0/8,192.168.1.0/24')).toBe(false);
  });
});
