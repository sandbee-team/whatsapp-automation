import { describe, expect, it } from 'vitest';
import { buildServiceTokenHeader, verifyServiceToken } from '../src/auth/service-token.js';

/**
 * service-token.test.ts (P28 Unit U2, step 3) - `@wp/server-kit/auth`'s own
 * coverage of the HMAC service-token primitives, MOVED here byte-for-byte
 * from `app/backend/src/modules/internal/service-token.ts` (P19 Unit U5).
 * `app/backend`'s own `service-token.test.ts` stays in place unchanged,
 * importing from the thin re-export shim - this file is the package-local
 * copy so `@wp/server-kit` is tested standalone. Extra cases beyond the
 * moved suite: a replayed header for a DIFFERENT path fails (mirrored from
 * the original "signed for a different path" case, restated to satisfy this
 * dispatch's own "replayed header for another path fails" wording), a
 * header 301s old fails, and a wrong-value 64-hex signature fails without
 * throwing.
 */

const SECRET = 'a-test-service-token-secret-at-least-32-chars-long';

describe('verifyServiceToken', () => {
  it('a_valid_token_is_accepted', () => {
    const timestamp = 1_735_689_600;
    const now = new Date(timestamp * 1000);
    const header = buildServiceTokenHeader(SECRET, 'GET', '/internal/v1/topups', timestamp);
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'GET',
        path: '/internal/v1/topups',
        header,
        now,
      }),
    ).toBe(true);
  });

  it('a_header_signed_for_one_path_replayed_against_another_path_is_rejected', () => {
    const timestamp = 1_735_689_600;
    const now = new Date(timestamp * 1000);
    const header = buildServiceTokenHeader(
      SECRET,
      'POST',
      '/internal/v1/topups/1/approve',
      timestamp,
    );
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'POST',
      path: '/internal/v1/topups/1/reject',
      header,
      now,
    });
    expect(ok).toBe(false);
  });

  it('a_header_301_seconds_old_is_rejected', () => {
    const timestamp = 1_735_689_600;
    const header = buildServiceTokenHeader(SECRET, 'GET', '/internal/v1/topups', timestamp);
    const now = new Date((timestamp + 301) * 1000);
    const ok = verifyServiceToken({
      secret: SECRET,
      method: 'GET',
      path: '/internal/v1/topups',
      header,
      now,
    });
    expect(ok).toBe(false);
  });

  it('a_wrong_value_64_hex_signature_is_rejected_without_throwing', () => {
    const timestamp = 1_735_689_600;
    const now = new Date(timestamp * 1000);
    const wrongSignature = 'a'.repeat(64);
    expect(() =>
      verifyServiceToken({
        secret: SECRET,
        method: 'GET',
        path: '/internal/v1/topups',
        header: `t=${String(timestamp)},s=${wrongSignature}`,
        now,
      }),
    ).not.toThrow();
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'GET',
        path: '/internal/v1/topups',
        header: `t=${String(timestamp)},s=${wrongSignature}`,
        now,
      }),
    ).toBe(false);
  });

  it('a_missing_header_is_rejected', () => {
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'GET',
        path: '/internal/v1/topups',
        header: undefined,
        now: new Date(),
      }),
    ).toBe(false);
  });
});
