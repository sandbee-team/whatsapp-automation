import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { StaffRole } from '@wp/domain';

/**
 * modules/staff-auth/tokens.ts (P28 Unit U4, step 6) - the staff access
 * token and refresh-token primitives.
 *
 * ACCESS TOKEN: HS256 (`jose`), claims `{sub, role, epoch, typ: 'staff'}`,
 * TTL capped at 120 SECONDS by `platform/config.ts`'s own ceiling. Two
 * minutes, not the tenant panel's 15: a staff token grants cross-tenant read
 * access to every workspace on the platform, so a stolen one must expire
 * before it is useful, and the refresh cookie (rotated on every use, with
 * reuse detection) is what keeps the session usable. `typ: 'staff'` is
 * checked on verify so a TENANT access token can never be presented to an
 * admin route even if the two ever shared a secret.
 *
 * EPOCH: the token carries `staff_users.token_epoch`; every request
 * re-reads that column and rejects a mismatch. That is what makes
 * revocation immediate - disabling an account, or detecting refresh-token
 * reuse, bumps the epoch and every outstanding access token dies at once,
 * without a deny-list to maintain.
 *
 * REFRESH TOKEN: 32 random bytes, base64url. Only its SHA-256 is stored
 * (`staff_sessions.refresh_token_hash`, UNIQUE), so a database read can
 * never yield a usable credential - the same discipline as the tenant side.
 */

export interface StaffAccessClaims {
  staffId: string;
  role: StaffRole;
  epoch: number;
}

const STAFF_TOKEN_TYPE = 'staff';

export class StaffUnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor(message = 'Invalid or expired staff session.') {
    super(message);
    this.name = 'StaffUnauthenticatedError';
  }
}

function secretKeyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Mints a staff access token expiring `ttlSeconds` after `now` (never longer - the caller's TTL is already ceiling-checked by config). */
export async function signStaffAccessToken(input: {
  secret: string;
  claims: StaffAccessClaims;
  ttlSeconds: number;
  now: Date;
}): Promise<string> {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  return new SignJWT({
    role: input.claims.role,
    epoch: input.claims.epoch,
    typ: STAFF_TOKEN_TYPE,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.claims.staffId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + input.ttlSeconds)
    .sign(secretKeyOf(input.secret));
}

/**
 * Verifies signature + expiry + `typ` and returns the claims. The EPOCH
 * comparison is deliberately NOT done here - it needs a database read, and
 * keeping it in the middleware (`authenticateStaff`) means this function
 * stays pure and testable with an injected clock.
 */
export async function verifyStaffAccessToken(input: {
  secret: string;
  token: string;
  now: Date;
}): Promise<StaffAccessClaims> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(input.token, secretKeyOf(input.secret), {
      algorithms: ['HS256'],
      currentDate: input.now,
    });
    payload = verified.payload;
  } catch {
    throw new StaffUnauthenticatedError();
  }

  const { sub, role, epoch, typ } = payload;
  if (
    typ !== STAFF_TOKEN_TYPE ||
    typeof sub !== 'string' ||
    typeof role !== 'string' ||
    typeof epoch !== 'number'
  ) {
    throw new StaffUnauthenticatedError();
  }
  return { staffId: sub, role: role as StaffRole, epoch };
}

export interface RefreshTokenPair {
  /** Sent to the browser in the `wp_admin_rt` cookie - never stored anywhere. */
  raw: string;
  /** SHA-256 of `raw` - the ONLY form that reaches the database. */
  hash: Buffer;
}

/** 32 cryptographically-random bytes plus their SHA-256 - see the module header. */
export function generateRefreshToken(): RefreshTokenPair {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

export function hashRefreshToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** SHA-256 hex of a user-agent string - stored instead of the raw header so a session row carries no fingerprintable client detail. */
export function hashUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  return createHash('sha256').update(userAgent, 'utf8').digest('hex');
}
