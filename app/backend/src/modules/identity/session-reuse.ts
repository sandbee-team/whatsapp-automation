import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import * as identityRepoDefault from './identity.repo.js';
import type { SessionCtx, SessionDbClient } from './session.service.js';

/**
 * session-reuse.ts (P04a FIXD, split out of session.service.ts for
 * max-lines) - membership resolution, the reuse-detection sweep/chain
 * revocation `session.service.ts`'s `refresh()` calls on a theft signal,
 * plus the small token-crypto helpers (`refreshTokenHashOf`/
 * `signAccessToken`) `createSession`/`refresh` both need. Pure code motion:
 * no behavior change, no transaction-boundary change from the original
 * session.service.ts (`resolveMembershipOrThrow`/`revokeChainAsReuseDetected`
 * still run entirely within the caller's own open transaction on `client`;
 * neither commits nor rolls back).
 */

type IdentityRepo = typeof identityRepoDefault;

export function refreshTokenHashOf(rawHex: string): Buffer {
  return createHash('sha256').update(Buffer.from(rawHex, 'hex')).digest();
}

export async function signAccessToken(
  ctx: SessionCtx,
  claims: {
    userId: string;
    sessionId: string;
    clientId: string;
    role: string;
    epoch: number;
    /** P04b Unit UB1a: set only when this session was minted right after a TOTP/recovery-code verification. */
    mfa?: boolean;
  },
  issuedAt: Date,
): Promise<string> {
  const secretKey = new TextEncoder().encode(ctx.jwtSecret);
  const issuedAtSec = Math.floor(issuedAt.getTime() / 1000);
  const expSec = issuedAtSec + ctx.accessTokenTtlMin * 60;

  return new SignJWT({
    sid: claims.sessionId,
    clientId: claims.clientId,
    role: claims.role,
    epoch: claims.epoch,
    ...(claims.mfa ? { mfa: true } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt(issuedAtSec)
    .setExpirationTime(expSec)
    .sign(secretKey);
}

/**
 * FIX 1 (P04a FIXA C1 review): `memberships` is RLS-protected - resolve the
 * user's client_id FIRST via `wp_client_id_for_user` (bypasses RLS, no GUC
 * needed) and set `app.client_id` to it BEFORE the role lookup, or the
 * plain client_id/role SELECT off memberships below returns zero rows
 * under wp_app with no GUC set (session issuance/rotation would then fail
 * every membership resolution with the generic no-membership-found error,
 * even for a real member).
 */
export async function resolveMembershipOrThrow(
  identityRepo: IdentityRepo,
  client: SessionDbClient,
  userId: string,
): Promise<{ clientId: string; role: string }> {
  const clientId = await identityRepo.findClientIdForUser(client, userId);
  if (!clientId) {
    throw new Error(`session: no membership found for user ${userId}`);
  }
  await identityRepo.setAppClientId(client, clientId);
  const membership = await identityRepo.findMembershipForUser(client, userId);
  if (!membership) {
    throw new Error(`session: no membership found for user ${userId}`);
  }
  return membership;
}

/**
 * Reuse-detection sweep (theft signal): revokes the WHOLE rotation chain,
 * audits it (FIX 1: under the resolved client's GUC, so the audit_logs
 * WITH CHECK passes under wp_app), and bumps `users.token_epoch` in the
 * SAME transaction (FIX 3, P04a FIXA C1 review) so every access token
 * issued before this point becomes unverifiable the moment the epoch cache
 * next reflects it - never leaving a stolen-but-not-yet-expired access
 * token valid until its own 15-minute TTL. Returns the notification email,
 * the new epoch, and the full revoked chain's session ids for the caller's
 * post-commit steps (email send, cache write, mfa-marker cleanup - all
 * AFTER commit only, run by session.service.ts; the epoch bump above
 * already kills the tokens, so the marker cleanup is best-effort hygiene,
 * not the safety mechanism - see session.service.ts's FIX 2, P04b FIXF).
 */
export async function revokeChainAsReuseDetected(
  identityRepo: IdentityRepo,
  client: SessionDbClient,
  sessionId: string,
  userId: string,
  revokedAt: Date,
): Promise<{ email: string; newEpoch: number; revokedSessionIds: string[] }> {
  const chainIds = await identityRepo.findSessionChainIds(client, sessionId);
  await identityRepo.revokeAuthSessionsBulk(client, chainIds, 'reuse_detected', revokedAt);
  const clientId = await identityRepo.findClientIdForUser(client, userId);
  if (clientId) {
    await identityRepo.setAppClientId(client, clientId);
  }
  await identityRepo.insertReuseDetectedAuditLog(client, { userId, clientId });
  const newEpoch = await identityRepo.bumpTokenEpoch(client, userId);
  const email = await identityRepo.getUserEmailById(client, userId);
  return { email, newEpoch, revokedSessionIds: chainIds };
}
