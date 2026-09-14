import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * hash.ts (api-keys U2) - pure HMAC-SHA256 hashing/verification of a
 * presented API key SECRET half (see `generate-key.ts`) against a pepper.
 * The pepper is a caller-supplied `Buffer` (sourced from the
 * `api-key-pepper` KEK purpose by U3/U4 - this module does no config
 * reads, no I/O, no logging, so it stays trivially unit-testable and
 * reusable from both the create path and the request-auth path).
 *
 * `verifyApiKeySecret`'s constant-time comparison idiom is copied verbatim
 * from `packages/server-kit/src/auth/service-token.ts#verifyServiceToken`:
 * the length check runs BEFORE `timingSafeEqual`, because that function
 * itself THROWS on a length mismatch rather than returning `false` - so a
 * corrupt/short stored hash must never crash the auth path, it must simply
 * fail verification.
 *
 * `DUMMY_SECRET_HASH` exists so the "no row matched this key_prefix" path
 * can still run one full HMAC + `timingSafeEqual` comparison against a
 * fixed, valid-shaped digest, rather than short-circuiting - this keeps a
 * "prefix not found" response computationally indistinguishable from a
 * "prefix found, secret wrong" response (both do exactly one hash + one
 * constant-time compare before failing).
 */

const HMAC_DIGEST_BYTES = 32;

/** Fixed 32-byte digest for the "no matching row" branch - see this file's own header comment. Never a real secret's hash. */
export const DUMMY_SECRET_HASH: Buffer = Buffer.alloc(HMAC_DIGEST_BYTES, 0xff);

/** HMAC-SHA256(pepper, secret) as a 32-byte digest - what is stored in `api_keys.secret_hash`. */
export function hashApiKeySecret(secret: string, pepper: Buffer): Buffer {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest();
}

/** Constant-time verification: recomputes the HMAC and compares against `storedHash` only after confirming equal lengths (see this file's own header comment on why the length check precedes `timingSafeEqual`). */
export function verifyApiKeySecret(secret: string, pepper: Buffer, storedHash: Buffer): boolean {
  const computed = hashApiKeySecret(secret, pepper);
  if (computed.length !== storedHash.length) {
    return false;
  }
  return timingSafeEqual(computed, storedHash);
}
