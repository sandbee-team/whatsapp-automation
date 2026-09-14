import { describe, expect, it } from 'vitest';
import { buildServiceTokenHeader, isIpAllowed, verifyServiceToken } from './service-token.js';

/**
 * service-token.test.ts (P19 Unit U5, step 8) - pure unit coverage for the
 * HMAC service-token verify + IP allow-list primitives. No PG/Redis, no
 * `@wp/server-kit` import chain here - this file runs under the ROOT
 * vitest config with no `WP_*` env, and needs none.
 */

const SECRET = 'a-test-service-token-secret-at-least-32-chars-long';

describe('verifyServiceToken', () => {
  it('a_valid_token_is_accepted', () => {
    const timestamp = 1_735_689_600;
    const now = new Date(timestamp * 1000);
    const header = buildServiceTokenHeader(SECRET, 'GET', '/internal/v1/topups', timestamp);
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/topups',
      header,
      now,
    });
    expect(ok).toBe(true);
  });

  it('a_missing_header_is_rejected', () => {
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/topups',
      header: undefined,
      now: new Date(),
    });
    expect(ok).toBe(false);
  });

  it('a_malformed_header_is_rejected', () => {
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/topups',
      header: 'not-a-real-token',
      now: new Date(),
    });
    expect(ok).toBe(false);
  });

  it('a_token_signed_for_a_different_path_is_rejected', () => {
    const now = new Date(1_735_689_600 * 1000);
    const header = buildServiceTokenHeader(SECRET, 'GET', '/internal/v1/topups', 1_735_689_600);
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/clients/x/wallet/credit',
      header,
      now,
    });
    expect(ok).toBe(false);
  });

  it('a_token_signed_with_the_wrong_secret_is_rejected', () => {
    const now = new Date(1_735_689_600 * 1000);
    const header = buildServiceTokenHeader(
      'a-different-secret-also-at-least-32-chars',
      'GET',
      '/internal/v1/topups',
      1_735_689_600,
    );
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/topups',
      header,
      now,
    });
    expect(ok).toBe(false);
  });

  it('a_six_minute_old_token_is_rejected_and_a_four_minute_one_is_accepted', () => {
    const timestamp = 1_735_689_600;
    const header = buildServiceTokenHeader(SECRET, 'GET', '/internal/v1/topups', timestamp);

    const sixMinutesLater = new Date((timestamp + 6 * 60) * 1000);
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'GET',
        path: '/internal/v1/topups',
        header,
        now: sixMinutesLater,
      }),
    ).toBe(false);

    const fourMinutesLater = new Date((timestamp + 4 * 60) * 1000);
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'GET',
        path: '/internal/v1/topups',
        header,
        now: fourMinutesLater,
      }),
    ).toBe(true);
  });

  it('a_signature_of_different_length_never_throws_and_is_rejected', () => {
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/topups',
      header: 't=1735689600,s=ab',
      now: new Date(1_735_689_600 * 1000),
    });
    expect(ok).toBe(false);
  });
});

describe('isIpAllowed', () => {
  it('an_address_inside_the_allow_listed_cidr_is_allowed', () => {
    expect(isIpAllowed('10.0.1.5', '10.0.0.0/8')).toBe(true);
  });

  it('an_address_outside_every_allow_listed_cidr_is_denied', () => {
    expect(isIpAllowed('203.0.113.5', '10.0.0.0/8,192.168.1.0/24')).toBe(false);
  });

  it('an_empty_allow_list_denies_every_address', () => {
    expect(isIpAllowed('10.0.1.5', '')).toBe(false);
  });

  it('an_exact_single_host_entry_with_no_prefix_matches_only_that_address', () => {
    expect(isIpAllowed('192.168.1.42', '192.168.1.42')).toBe(true);
    expect(isIpAllowed('192.168.1.43', '192.168.1.42')).toBe(false);
  });
});
