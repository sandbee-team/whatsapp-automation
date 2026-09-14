import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { AuthenticationError, login, type LoginCtx } from '../login.service.js';
import { totpLockoutDurationMs } from '../identity.routes.js';
import { hashPassword, type Argon2Params } from '../password.js';
import { signup } from '../signup.service.js';

/**
 * lockout-ladder.integration.test.ts (P04a FIXC S1; dedup carried into P04b
 * Unit UB1a) - the doubling lockout ladder formula (`floor(failedCount /
 * threshold) - 1`, capped at `maxHours`) used to be duplicated in two places
 * (login.service.ts's own private helper and routes-shared.ts's
 * `totpLockoutDurationMs`). P04b Unit UB1a made login.service.ts's
 * `lockoutDurationMs` the ONE canonical, exported implementation; routes-
 * shared.ts's `totpLockoutDurationMs` (re-exported unchanged via
 * `identity.routes.ts`, which is what this test still imports) is now just an
 * alias for it - the two can no longer silently diverge because there is only
 * one formula left. This test is kept as a parity/regression guard: it drives
 * a real `login()` lockout write and asserts the OBSERVED `locked_until - now`
 * duration still matches `totpLockoutDurationMs`'s output for the same
 * inputs, for every row in the table below.
 */

const REDUCED_PROFILE: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `lockout-ladder-${label}-${randomUUID()}@example.test`;
}

async function createUser(label: string): Promise<{ userId: string; email: string }> {
  const email = uniqueEmail(label);
  const passwordHash = await hashPassword('CorrectHorse123!', REDUCED_PROFILE);
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async () => {},
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    {
      fullName: `Lockout Ladder ${label}`,
      email,
      companyName: `Lockout Ladder Co ${label}`,
      passwordHash,
    },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);
  return { userId: result.userId, email };
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

describe('lockout ladder formula (P04a FIXC S1, login.service.ts vs identity.routes.ts)', () => {
  it('login_service_observed_lockout_duration_matches_totpLockoutDurationMs_for_every_table_row', async () => {
    const table: {
      failedCount: number;
      threshold: number;
      baseMinutes: number;
      maxHours: number;
    }[] = [
      { failedCount: 5, threshold: 5, baseMinutes: 15, maxHours: 24 },
      { failedCount: 10, threshold: 5, baseMinutes: 15, maxHours: 24 },
      { failedCount: 9, threshold: 3, baseMinutes: 10, maxHours: 1 },
      // Cap case: 30 * 2^3 = 240min would exceed the 1-hour (60min) cap.
      { failedCount: 8, threshold: 2, baseMinutes: 30, maxHours: 1 },
    ];

    for (const row of table) {
      const { userId, email } = await createUser(
        `row-${String(row.failedCount)}-${String(row.threshold)}`,
      );

      await pool.query(
        'UPDATE users SET failed_login_count = $2, locked_until = NULL WHERE id = $1',
        [userId, row.failedCount - 1],
      );

      const ctx: LoginCtx = {
        pool,
        argon2Params: REDUCED_PROFILE,
        lockoutThreshold: row.threshold,
        lockoutBaseMinutes: row.baseMinutes,
        lockoutMaxHours: row.maxHours,
        sendLockoutEmail: async () => {},
        now: () => FIXED_NOW,
      };

      await expect(login(ctx, { email, password: 'TotallyWrongPassword!' })).rejects.toThrow(
        AuthenticationError,
      );

      const lockedRow = await pool.query<{ locked_until: Date | null }>(
        'SELECT locked_until FROM users WHERE id = $1',
        [userId],
      );
      const lockedUntil = lockedRow.rows[0]!.locked_until;
      expect(lockedUntil).not.toBeNull();
      const observedMs = lockedUntil!.getTime() - FIXED_NOW.getTime();

      const expectedMs = totpLockoutDurationMs(
        row.failedCount,
        row.threshold,
        row.baseMinutes,
        row.maxHours,
      );
      expect(observedMs).toBe(expectedMs);
    }
  });
});
