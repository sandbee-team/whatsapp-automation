import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * auth/service-token.ts (P28 Unit U2, step 3) - the `/internal/v1` staff
 * surface's own auth: an HMAC-signed service token, verified with
 * `crypto.timingSafeEqual` (constant-time). MOVED here byte-for-byte from
 * `app/backend/src/modules/internal/service-token.ts` (P19 Unit U5, step 8)
 * so it is a shared `@wp/server-kit/auth` primitive rather than a
 * backend-local one - `app/backend`'s own file is now a thin re-export shim
 * (see that file's own header) so its existing test stays green unchanged.
 * This is NOT tenant auth (`route-policy.ts`'s `AuthPolicy` has no third
 * option for it) - every `/internal/v1` route registers with
 * `policy: 'public'` and runs this module's own guard FIRST inside the
 * handler, per the P19 phase dispatch's binding correction #11 ('public'
 * here means "not tenant-session-authenticated", not "unauthenticated").
 *
 * SIGNATURE SHAPE (mirrors `modules/webhooks/sign.ts#verifyWebhookSignature`
 * verbatim - same HMAC-SHA256 + 5-minute timestamp-window idiom, so a
 * captured header cannot be replayed forever): header value is
 * `t=<unix>,s=<hex hmac-sha256(secret, "${method}.${path}.${t}")>`. The
 * method+path are bound into the signature so a token minted for one route
 * cannot be replayed against another.
 *
 * `verifyServiceToken` returns `false` on ANY malformed input (missing
 * header, wrong shape, expired timestamp, length mismatch) - it never
 * throws past this function; `timingSafeEqual` itself throws on a length
 * mismatch, so the length check runs BEFORE it, treating a mismatch as a
 * plain verification failure, not a crash.
 */

const TOKEN_WINDOW_SECONDS = 5 * 60;
// `s=` is a hex SHA-256 HMAC, always exactly 64 hex chars - the `{64}` makes
// that intent explicit rather than incidental (it was already safe today:
// the length check at the bottom of `verifyServiceToken` runs BEFORE
// `timingSafeEqual`, which is the thing that actually throws on a length
// mismatch - see this function's own header).
const TOKEN_HEADER_PATTERN = /^t=(\d+),s=([0-9a-f]{64})$/;

export function signServiceToken(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
): string {
  return createHmac('sha256', secret)
    .update(`${method}.${path}.${String(timestamp)}`)
    .digest('hex');
}

export function buildServiceTokenHeader(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
): string {
  const signature = signServiceToken(secret, method, path, timestamp);
  return `t=${String(timestamp)},s=${signature}`;
}

export interface VerifyServiceTokenInput {
  secret: string;
  method: string;
  path: string;
  header: string | undefined;
  now: Date;
}

/** True only when the header parses, its signature matches (constant-time), AND its timestamp is within the 5-minute window of `now`. */
export function verifyServiceToken(input: VerifyServiceTokenInput): boolean {
  if (!input.header) {
    return false;
  }
  const match = TOKEN_HEADER_PATTERN.exec(input.header);
  if (!match) {
    return false;
  }
  const [, timestampRaw, signature] = match;
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > TOKEN_WINDOW_SECONDS) {
    return false;
  }

  const expected = signServiceToken(input.secret, input.method, input.path, timestamp);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature ?? '', 'hex');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}
