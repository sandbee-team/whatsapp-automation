import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { AuthenticationError, login, type LoginCtx } from '../login.service.js';
import { hashPassword, type Argon2Params } from '../password.js';
import { signup } from '../signup.service.js';

/**
 * login.integration.test.ts (P04a Unit A4; lockout-ladder cases split out
 * to login-lockout.integration.test.ts, P04a FIXD, for max-lines) - the
 * login use-case's core behavior (timing-safe unknown-email, the exact-now
 * lockout boundary, success/reset, disabled-user denial, transparent
 * rehash), proven against a real Postgres. Users are created via the
 * existing `signup` service with a password hashed by password.ts under a
 * REDUCED cost profile - only
 * `production_argon2_parameters_hash_and_verify_round_trip` (password.test.ts)
 * pays the full production cost. Pure move: no test case dropped, weakened
 * or merged, no assertion changed.
 */

const REDUCED_PROFILE: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };
const WEAKEST_PROFILE: Argon2Params = { memoryCost: 4096, timeCost: 1, parallelism: 1 };

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

async function createUserWithHash(
  label: string,
  passwordHash: string | null,
): Promise<{ userId: string; clientId: string; email: string }> {
  const email = uniqueEmail(label);
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

async function createUser(
  label: string,
  password: string,
): Promise<{ userId: string; clientId: string; email: string }> {
  const passwordHash = await hashPassword(password, REDUCED_PROFILE);
  return createUserWithHash(label, passwordHash);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
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

describe('login (P04a Unit A4, login use-case)', () => {
  it('unknown_email_login_does_a_dummy_verify_and_returns_the_same_error', async () => {
    const { email } = await createUser('timing', 'CorrectHorse123!');
    // Never let lockout trip during the timing loop below.
    const ctx = baseLoginCtx({ lockoutThreshold: 1000 });

    async function timeAttempt(
      attemptEmail: string,
      password: string,
    ): Promise<{ ms: number; error: unknown }> {
      const start = performance.now();
      let error: unknown;
      try {
        await login(ctx, { email: attemptEmail, password });
      } catch (err) {
        error = err;
      }
      return { ms: performance.now() - start, error };
    }

    const unknownTimes: number[] = [];
    const wrongTimes: number[] = [];
    let unknownError: unknown;
    let wrongError: unknown;

    for (let i = 0; i < 10; i += 1) {
      const unknown = await timeAttempt(uniqueEmail(`unknown-${String(i)}`), 'irrelevant-password');
      unknownTimes.push(unknown.ms);
      unknownError = unknown.error;

      const wrong = await timeAttempt(email, 'TotallyWrongPassword!');
      wrongTimes.push(wrong.ms);
      wrongError = wrong.error;
    }

    expect(unknownError).toBeInstanceOf(AuthenticationError);
    expect(wrongError).toBeInstanceOf(AuthenticationError);
    expect((unknownError as AuthenticationError).code).toBe('UNAUTHENTICATED');
    expect((wrongError as AuthenticationError).code).toBe('UNAUTHENTICATED');
    expect((unknownError as Error).message).toBe((wrongError as Error).message);

    const unknownMedian = median(unknownTimes);
    const wrongMedian = median(wrongTimes);
    expect(unknownMedian).toBeGreaterThanOrEqual(wrongMedian * 0.5);
  });

  it('a_lockout_expiring_exactly_at_now_is_treated_as_expired_not_locked', async () => {
    // Boundary case: `lockedUntil.getTime() > now().getTime()` (strict
    // greater-than, login.service.ts) - at the exact instant `locked_until`
    // equals `now`, the account must be treated as already unlocked, not
    // still locked. Sets `locked_until` directly (bypassing the ladder) so
    // the boundary instant is exact and deterministic.
    const { userId, email } = await createUser('boundary', 'BoundaryPassword1!');
    const boundary = new Date('2026-01-01T00:00:00.000Z');
    await pool.query('UPDATE users SET locked_until = $2 WHERE id = $1', [userId, boundary]);
    const ctx = baseLoginCtx({ now: () => boundary });

    // A right password at the exact boundary instant must succeed (not
    // AccountLockedError) - the lock has already expired at this instant.
    const result = await login(ctx, { email, password: 'BoundaryPassword1!' });
    expect(result.id).toBe(userId);
  });

  it('successful_login_resets_the_counter_and_sets_last_login_at', async () => {
    const { userId, email } = await createUser('success', 'GoodPassword1!');
    const ctx = baseLoginCtx();

    await expect(login(ctx, { email, password: 'wrong-once' })).rejects.toThrow(
      AuthenticationError,
    );

    const result = await login(ctx, { email, password: 'GoodPassword1!' });
    expect(result.id).toBe(userId);

    const row = await pool.query<{
      failed_login_count: number;
      locked_until: Date | null;
      last_login_at: Date | null;
    }>('SELECT failed_login_count, locked_until, last_login_at FROM users WHERE id = $1', [userId]);
    expect(row.rows[0]!.failed_login_count).toBe(0);
    expect(row.rows[0]!.locked_until).toBeNull();
    expect(row.rows[0]!.last_login_at).not.toBeNull();
  });

  it('a_disabled_user_with_the_correct_password_is_denied_with_the_generic_error', async () => {
    // FIX 6 (P04a FIXA C1 review): login ignoring `users.status` let a
    // disabled account still authenticate. Status is checked AFTER the real
    // password verify (never before), so the timing/error shape stay
    // identical to a genuine wrong-password attempt - no status oracle.
    const { userId, email } = await createUser('disabled', 'CorrectPassword1!');
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
    const ctx = baseLoginCtx();

    await expect(login(ctx, { email, password: 'CorrectPassword1!' })).rejects.toThrow(
      AuthenticationError,
    );

    const row = await pool.query<{ last_login_at: Date | null }>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [userId],
    );
    expect(row.rows[0]!.last_login_at).toBeNull();
  });

  it('a_weaker_hash_is_transparently_rehashed_on_login', async () => {
    const password = 'RehashMe123!';
    const weakHash = await hashPassword(password, WEAKEST_PROFILE);
    const { userId, email } = await createUserWithHash('rehash', weakHash);
    const ctx = baseLoginCtx();

    await login(ctx, { email, password });

    const row = await pool.query<{ password_hash: string; password_updated_at: Date | null }>(
      'SELECT password_hash, password_updated_at FROM users WHERE id = $1',
      [userId],
    );
    expect(row.rows[0]!.password_hash).not.toBe(weakHash);
    expect(row.rows[0]!.password_updated_at).not.toBeNull();
  });
});
