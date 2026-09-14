import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { AccountLockedError, AuthenticationError, login, type LoginCtx } from '../login.service.js';
import { hashPassword, type Argon2Params } from '../password.js';
import { signup } from '../signup.service.js';

/**
 * login-lockout.integration.test.ts (P04a Unit A4 / FIX 7; split out of
 * login.integration.test.ts, P04a FIXD, for max-lines) - the lockout
 * ladder's doubling, 24h cap, audit write, and while-locked non-increment
 * behavior, proven against a real Postgres. Pure move: no test case
 * dropped, weakened or merged, no assertion changed. Own fixtures
 * (independent of the sibling login.integration.test.ts).
 */

const REDUCED_PROFILE: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function baseLoginCtx(overrides: Partial<LoginCtx> = {}): LoginCtx {
  return {
    pool,
    argon2Params: REDUCED_PROFILE,
    lockoutThreshold: 5,
    lockoutBaseMinutes: 15,
    lockoutMaxHours: 24,
    sendLockoutEmail: async () => {},
    ...overrides,
  };
}

function uniqueEmail(label: string): string {
  return `login-${label}-${randomUUID()}@example.test`;
}

async function createUser(
  label: string,
  password: string,
): Promise<{ userId: string; clientId: string; email: string }> {
  const email = uniqueEmail(label);
  const passwordHash = await hashPassword(password, REDUCED_PROFILE);
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async () => {},
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    { fullName: `Login Test ${label}`, email, companyName: `Login Co ${label}`, passwordHash },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);
  return { userId: result.userId, clientId: result.clientId, email };
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
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
  await pool.end();
});

describe('login (P04a Unit A4, lockout ladder)', () => {
  it('five_failures_lock_the_account_for_fifteen_minutes_and_audit_it', async () => {
    const { userId, email } = await createUser('lockout', 'RightPassword1!');
    const ctx = baseLoginCtx();
    const before = Date.now();

    for (let i = 0; i < 5; i += 1) {
      await expect(login(ctx, { email, password: 'WrongPassword!' })).rejects.toThrow(
        AuthenticationError,
      );
    }

    const userRow = await pool.query<{ locked_until: Date }>(
      'SELECT locked_until FROM users WHERE id = $1',
      [userId],
    );
    const lockedUntil = new Date(userRow.rows[0]!.locked_until).getTime();
    const expected = before + 15 * 60_000;
    expect(Math.abs(lockedUntil - expected)).toBeLessThanOrEqual(60_000);

    await expect(login(ctx, { email, password: 'RightPassword1!' })).rejects.toThrow(
      AccountLockedError,
    );

    const auditRows = await pool.query(
      "SELECT id FROM audit_logs WHERE target_id = $1 AND action = 'auth.lockout'",
      [userId],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('the_tenth_failure_locks_for_thirty_minutes_doubling_the_base', async () => {
    // FIX 7 (P04a FIXA C1 review): lockout ladder coverage - the doubling.
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { userId, email } = await createUser('ladder-ten', 'RightPassword1!');
    const ctx = baseLoginCtx({ now: () => current });

    for (let i = 0; i < 5; i += 1) {
      await expect(login(ctx, { email, password: 'WrongPassword!' })).rejects.toThrow(
        AuthenticationError,
      );
    }
    // Jump past the first (15-minute) lockout so the next 5 wrong attempts
    // actually increment the counter instead of short-circuiting on
    // AccountLockedError.
    current = new Date(current.getTime() + 16 * 60_000);
    for (let i = 0; i < 5; i += 1) {
      await expect(login(ctx, { email, password: 'WrongPassword!' })).rejects.toThrow(
        AuthenticationError,
      );
    }

    const row = await pool.query<{ locked_until: Date }>(
      'SELECT locked_until FROM users WHERE id = $1',
      [userId],
    );
    const lockedUntil = new Date(row.rows[0]!.locked_until).getTime();
    const expected = current.getTime() + 30 * 60_000;
    expect(Math.abs(lockedUntil - expected)).toBeLessThanOrEqual(1000);
  });

  it('the_lockout_ladder_caps_at_twenty_four_hours', async () => {
    // FIX 7 (P04a FIXA C1 review): lockout ladder coverage - the 24h cap.
    // 8 cycles of 5 failures = 40 total; the 8th cycle's index (7) is the
    // first where 15 * 2^index (1920 min) exceeds the 1440-minute cap.
    let current = new Date('2026-01-01T00:00:00.000Z');
    const { userId, email } = await createUser('ladder-cap', 'RightPassword1!');
    const ctx = baseLoginCtx({ now: () => current });

    for (let cycle = 0; cycle < 8; cycle += 1) {
      for (let i = 0; i < 5; i += 1) {
        await expect(login(ctx, { email, password: 'WrongPassword!' })).rejects.toThrow(
          AuthenticationError,
        );
      }
      if (cycle < 7) {
        const minutes = Math.min(15 * 2 ** cycle, 24 * 60);
        current = new Date(current.getTime() + (minutes + 1) * 60_000);
      }
    }

    const row = await pool.query<{ locked_until: Date }>(
      'SELECT locked_until FROM users WHERE id = $1',
      [userId],
    );
    const lockedUntil = new Date(row.rows[0]!.locked_until).getTime();
    const expected = current.getTime() + 24 * 60 * 60_000;
    expect(Math.abs(lockedUntil - expected)).toBeLessThanOrEqual(1000);
  });

  it('attempts_while_locked_do_not_increment_the_failed_login_count', async () => {
    // FIX 7 (P04a FIXA C1 review): lockout ladder coverage.
    const { userId, email } = await createUser('locked-no-increment', 'RightPassword1!');
    const ctx = baseLoginCtx();

    for (let i = 0; i < 5; i += 1) {
      await expect(login(ctx, { email, password: 'WrongPassword!' })).rejects.toThrow(
        AuthenticationError,
      );
    }
    const before = await pool.query<{ failed_login_count: number }>(
      'SELECT failed_login_count FROM users WHERE id = $1',
      [userId],
    );
    expect(before.rows[0]!.failed_login_count).toBe(5);

    await expect(login(ctx, { email, password: 'WrongPassword!' })).rejects.toThrow(
      AccountLockedError,
    );
    await expect(login(ctx, { email, password: 'RightPassword1!' })).rejects.toThrow(
      AccountLockedError,
    );

    const after = await pool.query<{ failed_login_count: number }>(
      'SELECT failed_login_count FROM users WHERE id = $1',
      [userId],
    );
    expect(after.rows[0]!.failed_login_count).toBe(5);
  });
});
