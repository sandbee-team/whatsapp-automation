import { SignJWT } from 'jose';

/**
 * impersonation-token.ts (P28 Unit U3c) - `signImpersonationToken`, the ONE
 * writer of the `imp` claim (`token-epoch.ts`'s `ImpersonationClaims`).
 * Deliberately a STANDALONE function, never an overload/widening of
 * `session-reuse.ts#signAccessToken` (that function's signature is frozen -
 * see the phase dispatch binding): an impersonation token's TTL is a fixed
 * 2 minutes, never the tenant's own `SessionCtx.accessTokenTtlMin`, and its
 * `sid` is always `'imp:' + grantId` - conflating the two call sites would
 * let a future edit to the ordinary session TTL silently change an
 * impersonation token's lifetime too.
 */

export const IMPERSONATION_TOKEN_TTL_SEC = 120;

export interface SignImpersonationTokenInput {
  jwtSecret: string;
  targetUserId: string;
  grantId: string;
  clientId: string;
  role: string;
  epoch: number;
  scope: string;
  staffId: string;
}

/** Mints a 2-minute HS256 access token for `targetUserId` carrying the standard claims plus `imp`. `mfa` is always `false` (an impersonation session never carries a fresh-MFA claim). */
export async function signImpersonationToken(
  input: SignImpersonationTokenInput,
  issuedAt: Date = new Date(),
): Promise<{ accessToken: string; expiresAt: Date }> {
  const secretKey = new TextEncoder().encode(input.jwtSecret);
  const issuedAtSec = Math.floor(issuedAt.getTime() / 1000);
  const expSec = issuedAtSec + IMPERSONATION_TOKEN_TTL_SEC;

  const accessToken = await new SignJWT({
    sid: `imp:${input.grantId}`,
    clientId: input.clientId,
    role: input.role,
    epoch: input.epoch,
    mfa: false,
    imp: { grantId: input.grantId, scope: input.scope, staffId: input.staffId },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.targetUserId)
    .setIssuedAt(issuedAtSec)
    .setExpirationTime(expSec)
    .sign(secretKey);

  return { accessToken, expiresAt: new Date(expSec * 1000) };
}
