import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withStaffRoleTx } from '../../platform/platform-read.js';
import {
  buildTestAdminApp,
  seedStaffUser,
  totpCodeFor,
  type SeededStaff,
  type TestAppHandles,
} from '../../platform/__test-support__/admin-test-support.js';

/**
 * staff-auth.integration.test.ts (P28 Unit U4, step 6) - the two binding
 * claims about staff sessions, against a real Postgres.
 *
 * Everything here is scoped to THIS suite's own seeded staff ids: another
 * unit's integration suite runs against the same `wp_test2` database
 * concurrently, so no assertion counts rows fleet-wide.
 *
 * Time is INJECTED (`handles.clock.current`), never slept on. The
 * two-minute expiry claim is asserted at exactly +119 s and +121 s, which a
 * wall-clock test could only approximate and which ambient load could
 * perturb (core-invariants.md forbids asserting on ambient state).
 */

let handles: TestAppHandles;
const seededStaffIds: string[] = [];

async function seed(input: { emailPrefix: string; mfaEnabled?: boolean }): Promise<SeededStaff> {
  const staff = await seedStaffUser(handles.pool, {
    role: 'superadmin',
    emailPrefix: input.emailPrefix,
    mfaEnabled: input.mfaEnabled,
  });
  seededStaffIds.push(staff.staffId);
  return staff;
}

async function readStaffRow(
  staffId: string,
): Promise<{ failed_login_count: number; locked_until: Date | null; token_epoch: string }> {
  return withStaffRoleTx(handles.pool, async (db) => {
    const result = await db.query<{
      failed_login_count: number;
      locked_until: Date | null;
      token_epoch: string;
    }>(
      `SELECT failed_login_count, locked_until, token_epoch::text AS token_epoch
         FROM staff_users WHERE id = $1`,
      [staffId],
    );
    return result.rows[0]!;
  });
}

async function countAuditEvents(staffId: string, action: string): Promise<number> {
  return withStaffRoleTx(handles.pool, async (db) => {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE actor_staff_id = $1 AND action = $2`,
      [staffId, action],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

function login(body: Record<string, unknown>, headers?: Record<string, string>) {
  return handles.app.inject({
    method: 'POST',
    url: '/admin/v1/auth/login',
    payload: body,
    headers,
  });
}

beforeAll(async () => {
  handles = await buildTestAdminApp();
});

afterAll(async () => {
  // Scoped cleanup: ONLY this suite's own probe rows, by id - another unit's
  // integration suite shares this database.
  //
  // Deliberately NOT inside `withStaffRoleTx`: `wp_admin_app` has no DELETE
  // grant on staff_sessions/staff_users at all (migration 0070 gives it
  // SELECT/INSERT/UPDATE only), so a cleanup under that role fails with
  // `permission denied` - which is the grant surface working exactly as
  // designed. Cleanup therefore runs as the POOL OWNER, a privilege the
  // shipped admin API never has at any point.
  const client = await handles.pool.connect();
  try {
    if (seededStaffIds.length > 0) {
      await client.query(`DELETE FROM staff_sessions WHERE staff_id = ANY($1::uuid[])`, [
        seededStaffIds,
      ]);
      await client.query(`DELETE FROM audit_logs WHERE actor_staff_id = ANY($1::uuid[])`, [
        seededStaffIds,
      ]);
      await client.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [seededStaffIds]);
    }
  } finally {
    client.release();
  }
  await handles.close();
});

describe('staff login', () => {
  it('staff_login_requires_totp_and_an_allow_listed_ip', async () => {
    const staff = await seed({ emailPrefix: 'login' });
    const now = handles.clock.current;

    // (a) A missing totpCode is a 400 raised BEFORE any lookup - there is no
    // password-only staff login, so the field is not optional.
    const noCode = await login({ email: staff.email, password: staff.password });
    expect(noCode.statusCode).toBe(400);
    expect(JSON.parse(noCode.body).error.code).toBe('VALIDATION_ERROR');
    expect((await readStaffRow(staff.staffId)).failed_login_count).toBe(0);

    // (b) A WRONG code fails and increments the durable counter by exactly 1.
    const wrong = await login({
      email: staff.email,
      password: staff.password,
      totpCode: '000000',
    });
    expect(wrong.statusCode).toBe(401);
    expect(JSON.parse(wrong.body).error.code).toBe('UNAUTHENTICATED');
    expect((await readStaffRow(staff.staffId)).failed_login_count).toBe(1);

    // (c) An OFF-LIST ip is 403 FORBIDDEN, and (crucially) never reaches the
    // account at all - the counter is untouched. `trustProxy` is on for this
    // app so `x-forwarded-for` actually sets req.ip; with the default
    // trustProxy:false, spoofing the header would be ignored entirely,
    // which is the whole point of that default.
    const proxied = await buildTestAdminApp({ trustProxy: true, allowedCidrs: '10.0.0.0/8' });
    try {
      const offList = await proxied.app.inject({
        method: 'POST',
        url: '/admin/v1/auth/login',
        payload: {
          email: staff.email,
          password: staff.password,
          totpCode: await totpCodeFor(staff.totpSecret, now),
        },
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(offList.statusCode).toBe(403);
      expect(JSON.parse(offList.body).error.code).toBe('FORBIDDEN');
      expect((await readStaffRow(staff.staffId)).failed_login_count).toBe(1);
    } finally {
      await proxied.close();
    }

    // (d) Five wrong codes lock the account; the CORRECT code then still
    // fails, with ACCOUNT_LOCKED - the lock is checked before the password.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await login({
        email: staff.email,
        password: staff.password,
        totpCode: '000000',
      });
      expect(failed.statusCode).toBe(attempt === 3 ? 423 : 401);
    }
    const locked = await readStaffRow(staff.staffId);
    expect(locked.failed_login_count).toBe(5);
    expect(locked.locked_until).not.toBeNull();

    const correctButLocked = await login({
      email: staff.email,
      password: staff.password,
      totpCode: await totpCodeFor(staff.totpSecret, now),
    });
    expect(correctButLocked.statusCode).toBe(423);
    expect(JSON.parse(correctButLocked.body).error.code).toBe('ACCOUNT_LOCKED');

    // (e) EVERY attempt above left an audit row - failures included.
    expect(await countAuditEvents(staff.staffId, 'staff.login.failure')).toBeGreaterThanOrEqual(4);
    expect(await countAuditEvents(staff.staffId, 'staff.login.locked')).toBeGreaterThanOrEqual(2);

    // (f) An account that never completed TOTP enrolment gets 403
    // MFA_ENROLL_REQUIRED - never a session, and never a lockout increment
    // (locking it would only obstruct the operator who must enrol it).
    const unenrolled = await seed({ emailPrefix: 'unenrolled', mfaEnabled: false });
    const enrolNeeded = await login({
      email: unenrolled.email,
      password: unenrolled.password,
      totpCode: '000000',
    });
    expect(enrolNeeded.statusCode).toBe(403);
    expect(JSON.parse(enrolNeeded.body).error.code).toBe('MFA_ENROLL_REQUIRED');
    expect((await readStaffRow(unenrolled.staffId)).failed_login_count).toBe(0);
  });

  it('a_staff_access_token_expires_in_two_minutes', async () => {
    const staff = await seed({ emailPrefix: 'expiry' });
    const start = handles.clock.current;

    const loggedIn = await login({
      email: staff.email,
      password: staff.password,
      totpCode: await totpCodeFor(staff.totpSecret, start),
    });
    expect(loggedIn.statusCode).toBe(200);
    const accessToken = JSON.parse(loggedIn.body).data.accessToken as string;
    expect(JSON.parse(loggedIn.body).data.expiresInSeconds).toBe(120);
    const refreshCookie = loggedIn.cookies.find((cookie) => cookie.name === 'wp_admin_rt');
    expect(refreshCookie).toBeDefined();
    // The cookie's own attributes are part of the contract, not incidental.
    expect(refreshCookie!.httpOnly).toBe(true);
    expect(refreshCookie!.sameSite?.toLowerCase()).toBe('strict');
    expect(refreshCookie!.path).toBe('/admin/v1/auth');

    const callMe = () =>
      handles.app.inject({
        method: 'GET',
        url: '/admin/v1/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

    // +119 s: still inside the 120-second window.
    handles.clock.current = new Date(start.getTime() + 119_000);
    expect((await callMe()).statusCode).toBe(200);

    // +121 s: expired. Exact values, not a bound - see the suite header.
    handles.clock.current = new Date(start.getTime() + 121_000);
    const expired = await callMe();
    expect(expired.statusCode).toBe(401);
    expect(JSON.parse(expired.body).error.code).toBe('UNAUTHENTICATED');

    // Refresh mints a NEW usable token from the still-valid cookie.
    const refreshed = await handles.app.inject({
      method: 'POST',
      url: '/admin/v1/auth/refresh',
      headers: { cookie: `wp_admin_rt=${refreshCookie!.value}` },
    });
    expect(refreshed.statusCode).toBe(200);
    const secondToken = JSON.parse(refreshed.body).data.accessToken as string;
    expect(secondToken).not.toBe(accessToken);
    const withSecond = await handles.app.inject({
      method: 'GET',
      url: '/admin/v1/auth/me',
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(withSecond.statusCode).toBe(200);

    const epochBefore = (await readStaffRow(staff.staffId)).token_epoch;

    // REUSING the now-rotated cookie is 401 AND triggers the sweep: every
    // session revoked and token_epoch bumped, so the second (still
    // time-valid) access token dies immediately too.
    const reused = await handles.app.inject({
      method: 'POST',
      url: '/admin/v1/auth/refresh',
      headers: { cookie: `wp_admin_rt=${refreshCookie!.value}` },
    });
    expect(reused.statusCode).toBe(401);

    const after = await readStaffRow(staff.staffId);
    expect(Number(after.token_epoch)).toBe(Number(epochBefore) + 1);

    const liveSessions = await withStaffRoleTx(handles.pool, async (db) => {
      const result = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM staff_sessions
          WHERE staff_id = $1 AND revoked_at IS NULL`,
        [staff.staffId],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    expect(liveSessions).toBe(0);

    const afterSweep = await handles.app.inject({
      method: 'GET',
      url: '/admin/v1/auth/me',
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(afterSweep.statusCode).toBe(401);

    expect(
      await countAuditEvents(staff.staffId, 'staff.refresh.reuse_detected'),
    ).toBeGreaterThanOrEqual(1);
  });
});
