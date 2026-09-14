import { randomUUID } from 'node:crypto';
import { generate as otpGenerate } from 'otplib';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { loadConfig } from '../../../platform/config.js';
import { signup } from '../signup.service.js';
import { AccountLockedError, AuthenticationError, login, type LoginCtx } from '../login.service.js';
import {
  createSession,
  refresh,
  UnauthenticatedError,
  type SessionCtx,
} from '../session.service.js';
import { verifyEmail, type VerifyEmailCtx } from '../verify-email.service.js';
import { hashPassword, type Argon2Params } from '../password.js';
import { getMeForUser } from '../identity.repo.js';
import { enrolStart, verifyRecoveryCode, type TotpCtx } from '../totp.service.js';
import { runEnrolConfirmAsWpApp, wrapAsRole } from './wp-app-role-test-support.js';

/**
 * identity-under-wp-app-role.integration.test.ts (P04a FIXA C1 review, FIX 1
 * - THE PROOF). Every other identity integration test in this module
 * connects as the dev superuser (BYPASSRLS), which is exactly why the
 * reviewer finding held: login/session/verify-email/lockout code reads and
 * writes TENANT tables (`memberships`, `clients`, `audit_logs`) with no
 * `app.client_id` GUC set, and the superuser connection never notices
 * because it bypasses `FORCE ROW LEVEL SECURITY` entirely.
 *
 * This file runs the SAME service functions against a connection that
 * actually operates AS `wp_app` (NOLOGIN, migration 0005 - `SET LOCAL ROLE
 * wp_app` inside each transaction, transaction-scoped, is the sanctioned
 * substitute; same precedent as db/tests/tenant-db.test.ts's `SET LOCAL
 * ROLE wp_app` and P03's `wp_scheduler` claim-under-role tests). The user is
 * seeded via `signup()` on the ordinary superuser pool first (this file's
 * own scope is login/session/verify-email, not signup-under-wp_app), then
 * every subsequent operation switches to `wp_app`.
 *
 * P04b Unit UB1a: extended with client-activation and the recovery-code
 * login continuation as steps 5/7 of the SAME end-to-end flow below - one
 * continuous chain, not independently splittable into separate `it()`s.
 * `wrapAsRole` moved to wp-app-role-test-support.ts (split for max-lines).
 * Unit UB1c: step 7's `enrolConfirm` now also runs as wp_app via
 * `runEnrolConfirmAsWpApp` (same file), since migration 0016 grants wp_app
 * DELETE on `mfa_recovery_codes` - closing this file's own former gap flag.
 */

const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
const ENV = 'test';
const REDUCED_PROFILE: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `wp-app-role-${label}-${randomUUID()}@example.test`;
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = ANY($1)', [createdUserIds]);
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
    for (const userId of createdUserIds) {
      await redis.del(sysKey(ENV, 'epoch', 'u', userId));
    }
  }
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [createdClientIds]);
  }
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  redis.disconnect();
  await pool.end();
});

describe('identity under wp_app + FORCE RLS (P04a FIXA C1 review, FIX 1 proof)', () => {
  it('login_session_lockout_reuse_and_verify_email_all_work_as_wp_app', async () => {
    const email = uniqueEmail('proof');
    const password = 'ProofPassword1!';
    const passwordHash = await hashPassword(password, REDUCED_PROFILE);

    let capturedUrl = '';
    const seeded = await signup(
      {
        // Seeded via the superuser tenantDb (this unit's scope is
        // login/session/verify-email under wp_app, not signup-under-wp_app).
        tenantDb,
        sendVerificationEmail: async (_to, verifyUrl) => {
          capturedUrl = verifyUrl;
        },
        publicBaseUrl: 'http://localhost:5173',
        signupCreditMinor: 10000,
        lowBalanceThresholdMinor: 500,
      },
      { fullName: 'WP App Role Proof', email, companyName: 'WP App Role Co', passwordHash },
    );
    createdUserIds.push(seeded.userId);
    createdClientIds.push(seeded.clientId);

    const loginCtx: LoginCtx = {
      pool: wrapAsRole(pool, 'wp_app'),
      argon2Params: REDUCED_PROFILE,
      lockoutThreshold: 5,
      lockoutBaseMinutes: 15,
      lockoutMaxHours: 24,
      sendLockoutEmail: async () => {},
    };
    const sessionCtx: SessionCtx = {
      pool: wrapAsRole(pool, 'wp_app'),
      redis,
      jwtSecret: JWT_SECRET,
      accessTokenTtlMin: 15,
      refreshTokenTtlDays: 30,
      env: ENV,
      sendReuseDetectedEmail: async () => {},
    };

    // 1. LOGIN succeeds as wp_app - membership resolution under RLS must
    // not silently return zero rows.
    const loginResult = await login(loginCtx, { email, password });
    expect(loginResult.id).toBe(seeded.userId);

    // 2. SESSION mint succeeds as wp_app - membership resolution again, for
    // the access token's clientId/role claims.
    const session0 = await createSession(sessionCtx, { userId: seeded.userId });
    expect(typeof session0.accessToken).toBe('string');

    // 3. LOCKOUT persists as wp_app - the audit_logs INSERT must not
    // violate the tenant_isolation WITH CHECK and roll back the whole
    // 5th-failure transaction (which would silently lose the lockout too).
    for (let i = 0; i < 5; i += 1) {
      await expect(login(loginCtx, { email, password: 'WrongPassword!' })).rejects.toThrow(
        AuthenticationError,
      );
    }
    const lockedRow = await pool.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM users WHERE id = $1',
      [seeded.userId],
    );
    expect(lockedRow.rows[0]!.locked_until).not.toBeNull();

    const lockoutAudit = await pool.query(
      "SELECT id FROM audit_logs WHERE target_id = $1 AND action = 'auth.lockout'",
      [seeded.userId],
    );
    expect(lockoutAudit.rows).toHaveLength(1);

    await expect(login(loginCtx, { email, password })).rejects.toThrow(AccountLockedError);

    // Clear the lockout (superuser, direct) so it doesn't interfere with
    // the refresh-reuse proof below - a different concern than this test.
    await pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [
      seeded.userId,
    ]);

    // 4. REFRESH REUSE as wp_app - the whole rotation chain must be revoked
    // (the chain-revoke + audit-insert transaction must not fail OPEN under RLS).
    const session1 = await refresh(sessionCtx, { refreshToken: session0.refreshToken });
    await expect(refresh(sessionCtx, { refreshToken: session0.refreshToken })).rejects.toThrow(
      UnauthenticatedError,
    );

    const chainRows = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM auth_sessions WHERE id = ANY($1)',
      [[session0.sessionId, session1.sessionId]],
    );
    expect(chainRows.rows).toHaveLength(2);
    expect(chainRows.rows.every((row) => row.revoked_at !== null)).toBe(true);

    const reuseAudit = await pool.query(
      "SELECT id FROM audit_logs WHERE target_id = $1 AND action = 'auth.refresh_reuse_detected'",
      [seeded.userId],
    );
    expect(reuseAudit.rows).toHaveLength(1);

    // 5. VERIFY EMAIL as wp_app - onboarding_step must actually advance
    // (not a silent zero-rows-updated no-op).
    const rawToken = new URL(capturedUrl).searchParams.get('token');
    if (!rawToken) throw new Error('signup did not produce a verification token URL');

    const verifyCtx: VerifyEmailCtx = { pool: wrapAsRole(pool, 'wp_app') };
    const verifyResult = await verifyEmail(verifyCtx, rawToken);
    expect(verifyResult.userId).toBe(seeded.userId);

    const clientRow = await pool.query<{ onboarding_step: string; status: string }>(
      'SELECT onboarding_step, status FROM clients WHERE id = $1',
      [seeded.clientId],
    );
    expect(clientRow.rows[0]!.onboarding_step).toBe('choose_timezone');
    // P04b Unit UB1a, task 5/6: the client-activation UPDATE (same
    // transaction as the onboarding-step advance) must also actually commit
    // under wp_app + FORCE RLS - not silently no-op the way the pre-FIX-1
    // onboarding-step UPDATE used to.
    expect(clientRow.rows[0]!.status).toBe('active');

    // 6. GET /v1/auth/me's data path as wp_app - FIX 13 (P04a FIXC, THE
    // remaining critical). `fetchMeRow` joins memberships+clients (both
    // FORCE RLS) - called on a bare connection with no `app.client_id` GUC
    // set (what `identity.routes.ts` used to do directly), that join comes
    // back EMPTY under wp_app and every real user's `/me` 401s.
    // `getMeForUser` is the self-scoping wrapper (resolve client_id -> set
    // the GUC -> `fetchMeRow`, one transaction) - this is the assertion that
    // was missing from this proof file; it fails against the old
    // `identityRepo.fetchMeRow(wrapAsRole(pool, 'wp_app'), ...)` call path
    // (zero rows -> `null`) and passes only through `getMeForUser`.
    const meRow = await getMeForUser(wrapAsRole(pool, 'wp_app'), seeded.userId);
    expect(meRow).not.toBeNull();
    expect(meRow!.user.id).toBe(seeded.userId);
    expect(meRow!.client.id).toBe(seeded.clientId);
    expect(meRow!.membership.role).toBe('owner');

    // 7. P04b UB1a/UB1c: recovery-code LOGIN as wp_app (enrolConfirm,
    // verifyRecoveryCode, createSession); enrolStart stays superuser-only.
    const totpSeedCtx: TotpCtx = {
      db: pool,
      pool,
      redis,
      keyRingPath: loadConfig({ NODE_ENV: 'test' }).KEY_RING_PATH,
      totpWindow: 1,
      totpUsedCodeTtlSec: 95,
      env: ENV,
    };
    const { secretShownOnce } = await enrolStart(totpSeedCtx, seeded.userId, email);
    const enrolCode = await otpGenerate({ secret: secretShownOnce });

    const { userId } = seeded;
    const { recoveryCodes } = await runEnrolConfirmAsWpApp(pool, totpSeedCtx, userId, enrolCode);

    // `verifyRecoveryCode` calls `ctx.db.query` directly - open one
    // wp_app-scoped transaction here, the same shape totp-recovery.routes.ts
    // itself opens. `ctx.pool` is never actually called by
    // `verifyRecoveryCode` (only `enrolConfirm` uses it), so `wpAppClient`
    // itself satisfies `TotpDbPool`'s shape well enough to type-check.
    const wpAppPool = wrapAsRole(pool, 'wp_app');
    const wpAppClient = await wpAppPool.connect();
    await wpAppClient.query('BEGIN');
    try {
      await verifyRecoveryCode(
        {
          db: wpAppClient,
          pool: { ...wpAppClient, connect: async () => wpAppClient },
          redis,
          keyRingPath: loadConfig({ NODE_ENV: 'test' }).KEY_RING_PATH,
          totpWindow: 1,
          totpUsedCodeTtlSec: 95,
          env: ENV,
        },
        seeded.userId,
        recoveryCodes[0]!,
      );
      await wpAppClient.query('COMMIT');
    } catch (err) {
      await wpAppClient.query('ROLLBACK');
      throw err;
    } finally {
      wpAppClient.release();
    }

    const recoverySession = await createSession(sessionCtx, {
      userId: seeded.userId,
      mfa: true,
    });
    expect(typeof recoverySession.accessToken).toBe('string');

    const claimedRow = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
      [seeded.userId],
    );
    expect(claimedRow.rows).toHaveLength(1);
  });
});
