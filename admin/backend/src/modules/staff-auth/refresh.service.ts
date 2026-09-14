import type { StaffRole } from '@wp/domain';
import {
  withStaffRoleTx,
  writeStaffAuditEvent,
  type PlatformReadDeps,
} from '../../platform/platform-read.js';
import {
  createStaffSession,
  findStaffSessionByHash,
  findStaffUserById,
  revokeAllSessionsAndBumpEpoch,
  revokeStaffSession,
  rotateStaffSession,
} from './sessions.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  hashUserAgent,
  signStaffAccessToken,
  StaffUnauthenticatedError,
} from './tokens.js';

/**
 * modules/staff-auth/refresh.service.ts (P28 Unit U4, step 6) - refresh
 * rotation with REUSE DETECTION, and logout.
 *
 * ROTATION: every refresh mints a brand-new token and revokes the old row,
 * pointing it at its successor (`replaced_by`). So a refresh token is
 * single-use by construction, and the chain is inspectable afterwards.
 *
 * REUSE DETECTION (the reason rotation is worth doing): presenting an
 * ALREADY-ROTATED token means two parties hold the same cookie - the
 * legitimate staff member and someone who copied it. There is no way to
 * tell which one is asking, so the only safe response is to end BOTH
 * sessions: every live session of that staff user is revoked AND
 * `token_epoch` is bumped, which also kills the outstanding 2-minute access
 * tokens (without the epoch bump, a stolen access token would keep working
 * for up to two more minutes after we detected the theft). The event is
 * audited as `staff.refresh.reuse_detected` so an operator sees it.
 *
 * That is deliberately a harsh response for what could be a browser
 * double-submit: an admin panel with cross-tenant read access is exactly
 * where a false negative costs more than a false positive, and the recovery
 * (log in again, with TOTP) takes seconds.
 */

export interface StaffRefreshDeps extends PlatformReadDeps {
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTtlSeconds: number;
  now: () => Date;
}

export interface StaffRefreshResult {
  accessToken: string;
  expiresInSeconds: number;
  refreshTokenRaw: string;
  staff: { staffId: string; fullName: string; role: StaffRole };
}

/** Rotates one refresh token. Throws `StaffUnauthenticatedError` on an unknown, expired, or REUSED token (after the sweep, for the last). */
export async function staffRefresh(
  deps: StaffRefreshDeps,
  input: { refreshTokenRaw: string; ip: string; userAgent?: string; requestId: string },
): Promise<StaffRefreshResult> {
  const now = deps.now();
  const hash = hashRefreshToken(input.refreshTokenRaw);

  const outcome = await withStaffRoleTx(deps.pool, async (db) => {
    const session = await findStaffSessionByHash(db, hash);
    if (!session) {
      return { kind: 'unknown' as const };
    }

    // REUSE: the row exists but was already revoked/rotated - see header.
    if (session.revokedAt !== null) {
      await revokeAllSessionsAndBumpEpoch(db, { staffId: session.staffId, now });
      return { kind: 'reuse' as const, staffId: session.staffId };
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      return { kind: 'expired' as const, staffId: session.staffId };
    }

    const staff = await findStaffUserById(db, session.staffId);
    if (!staff || staff.status !== 'active') {
      // A disabled account's outstanding refresh token is worthless, and we
      // revoke it rather than leaving it to expire on its own schedule.
      await revokeStaffSession(db, { sessionId: session.id, now });
      return { kind: 'unknown' as const };
    }

    const refresh = generateRefreshToken();
    const newSessionId = await createStaffSession(db, {
      staffId: staff.id,
      refreshTokenHash: refresh.hash,
      ip: input.ip,
      userAgentHash: hashUserAgent(input.userAgent),
      expiresAt: new Date(now.getTime() + deps.refreshTtlSeconds * 1000),
    });
    // Conditional on `revoked_at IS NULL` (see `rotateStaffSession`): two
    // concurrent refreshes of the SAME token race here, and exactly one
    // wins the UPDATE - the loser gets zero rows and is treated as a reuse,
    // which is the correct verdict for a token presented twice.
    const rotated = await rotateStaffSession(db, {
      oldSessionId: session.id,
      newSessionId,
      now,
    });
    if (rotated === 0) {
      await revokeAllSessionsAndBumpEpoch(db, { staffId: staff.id, now });
      return { kind: 'reuse' as const, staffId: staff.id };
    }

    return { kind: 'ok' as const, staff, refreshRaw: refresh.raw };
  });

  if (outcome.kind === 'reuse') {
    await writeStaffAuditEvent(deps, {
      action: 'staff.refresh.reuse_detected',
      staffId: outcome.staffId,
      requestId: input.requestId,
      ip: input.ip,
      metadata: { cause: 'refresh_token_reuse' },
    });
    throw new StaffUnauthenticatedError();
  }
  if (outcome.kind !== 'ok') {
    throw new StaffUnauthenticatedError();
  }

  return {
    accessToken: await signStaffAccessToken({
      secret: deps.jwtSecret,
      claims: {
        staffId: outcome.staff.id,
        role: outcome.staff.role,
        // Re-read from the row inside the same transaction, so a refresh
        // that races an epoch bump mints a token for the CURRENT epoch
        // rather than a stale one that would 401 on its first use.
        epoch: outcome.staff.tokenEpoch,
      },
      ttlSeconds: deps.accessTokenTtlSeconds,
      now,
    }),
    expiresInSeconds: deps.accessTokenTtlSeconds,
    refreshTokenRaw: outcome.refreshRaw,
    staff: {
      staffId: outcome.staff.id,
      fullName: outcome.staff.fullName,
      role: outcome.staff.role,
    },
  };
}

/**
 * Logout: revokes the presented session only (not every session of that
 * staff member - a staff member logging out of one browser should not be
 * signed out of another). Idempotent: an unknown or already-revoked token
 * is a successful logout, never an error, so a double-submit or a stale
 * cookie cannot leave the panel stuck.
 */
export async function staffLogout(
  deps: StaffRefreshDeps,
  input: { refreshTokenRaw: string | undefined; ip: string; requestId: string },
): Promise<void> {
  const now = deps.now();
  if (!input.refreshTokenRaw) return;
  const hash = hashRefreshToken(input.refreshTokenRaw);

  const staffId = await withStaffRoleTx(deps.pool, async (db) => {
    const session = await findStaffSessionByHash(db, hash);
    if (!session || session.revokedAt !== null) return null;
    await revokeStaffSession(db, { sessionId: session.id, now });
    return session.staffId;
  });

  if (staffId) {
    await writeStaffAuditEvent(deps, {
      action: 'staff.logout',
      staffId,
      requestId: input.requestId,
      ip: input.ip,
    });
  }
}
