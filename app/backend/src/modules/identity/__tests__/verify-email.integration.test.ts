import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { signup } from '../signup.service.js';
import {
  InvalidVerificationTokenError,
  verifyEmail,
  type VerifyEmailCtx,
} from '../verify-email.service.js';

/**
 * verify-email.integration.test.ts (P04a Unit A5a) - the email-verification
 * consume use-case, proven against a real Postgres. Users/clients are
 * created via the existing `signup` service; the raw verification token is
 * captured off the injected `sendVerificationEmail` stub (never persisted in
 * plaintext - see signup.service.ts).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `verify-email-${label}-${randomUUID()}@example.test`;
}

function baseCtx(overrides: Partial<VerifyEmailCtx> = {}): VerifyEmailCtx {
  return {
    pool,
    ...overrides,
  };
}

async function signupAndCaptureRawToken(
  label: string,
): Promise<{ userId: string; clientId: string; email: string; rawToken: string }> {
  const email = uniqueEmail(label);
  let capturedUrl = '';
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async (_to, verifyUrl) => {
        capturedUrl = verifyUrl;
      },
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    { fullName: `Verify Email Test ${label}`, email, companyName: `Verify Email Co ${label}` },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);

  const rawToken = new URL(capturedUrl).searchParams.get('token');
  if (!rawToken) throw new Error('signup did not produce a verification token URL');

  return { userId: result.userId, clientId: result.clientId, email, rawToken };
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

describe('verifyEmail (P04a Unit A5a, verify-email use-case)', () => {
  it('a_valid_token_verifies_email_and_advances_onboarding', async () => {
    const { userId, clientId, rawToken } = await signupAndCaptureRawToken('happy-path');

    const result = await verifyEmail(baseCtx(), rawToken);
    expect(result.userId).toBe(userId);

    const tokenRow = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM email_verification_tokens WHERE user_id = $1',
      [userId],
    );
    expect(tokenRow.rows[0]!.consumed_at).not.toBeNull();

    const userRow = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    expect(userRow.rows[0]!.email_verified_at).not.toBeNull();

    const clientRow = await pool.query<{ onboarding_step: string }>(
      'SELECT onboarding_step FROM clients WHERE id = $1',
      [clientId],
    );
    expect(clientRow.rows[0]!.onboarding_step).toBe('choose_timezone');
  });

  it('a_consumed_or_expired_token_is_rejected_with_a_generic_error', async () => {
    const replayed = await signupAndCaptureRawToken('replay');
    await verifyEmail(baseCtx(), replayed.rawToken);

    await expect(verifyEmail(baseCtx(), replayed.rawToken)).rejects.toThrow(
      InvalidVerificationTokenError,
    );
    const replayedUserRow = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [replayed.userId],
    );
    // Already set by the first (successful) call above - a replay must not change it further.
    expect(replayedUserRow.rows[0]!.email_verified_at).not.toBeNull();

    const expired = await signupAndCaptureRawToken('expired');
    await pool.query(
      "UPDATE email_verification_tokens SET expires_at = now() - interval '1 day' WHERE user_id = $1",
      [expired.userId],
    );

    await expect(verifyEmail(baseCtx(), expired.rawToken)).rejects.toThrow(
      InvalidVerificationTokenError,
    );
    const expiredUserRow = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [expired.userId],
    );
    expect(expiredUserRow.rows[0]!.email_verified_at).toBeNull();
  });

  it('two_concurrent_consumes_of_the_same_token_only_one_wins', async () => {
    // `consumeEmailVerificationToken` is a single conditional
    // `UPDATE ... WHERE consumed_at IS NULL ... RETURNING` (core invariant
    // 3) - Postgres's own row lock is the arbiter for two callers racing on
    // the SAME token, not an in-memory check.
    const { userId, rawToken } = await signupAndCaptureRawToken('concurrent-replay');

    const results = await Promise.allSettled([
      verifyEmail(baseCtx(), rawToken),
      verifyEmail(baseCtx(), rawToken),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InvalidVerificationTokenError,
    );

    const tokenRow = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM email_verification_tokens WHERE user_id = $1',
      [userId],
    );
    expect(tokenRow.rows[0]!.consumed_at).not.toBeNull();

    const userRow = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    expect(userRow.rows[0]!.email_verified_at).not.toBeNull();
  });

  // P04b Unit UB1a, task 5: verify-email now activates the client
  // (pending_verification -> active) - required by the entitlement gate -
  // but must NEVER resurrect a suspended/closed client (fail-safe).
  it('verify_email_activates_a_pending_client_but_never_resurrects_a_suspended_one', async () => {
    const activated = await signupAndCaptureRawToken('activates-pending');
    await verifyEmail(baseCtx(), activated.rawToken);

    const activatedClientRow = await pool.query<{ status: string }>(
      'SELECT status FROM clients WHERE id = $1',
      [activated.clientId],
    );
    expect(activatedClientRow.rows[0]!.status).toBe('active');

    const suspended = await signupAndCaptureRawToken('never-resurrects-suspended');
    await pool.query("UPDATE clients SET status = 'suspended' WHERE id = $1", [suspended.clientId]);

    await verifyEmail(baseCtx(), suspended.rawToken);

    const suspendedClientRow = await pool.query<{ status: string }>(
      'SELECT status FROM clients WHERE id = $1',
      [suspended.clientId],
    );
    expect(suspendedClientRow.rows[0]!.status).toBe('suspended');

    // The email verification itself still proceeds normally - only the
    // client-status resurrection is denied.
    const suspendedUserRow = await pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [suspended.userId],
    );
    expect(suspendedUserRow.rows[0]!.email_verified_at).not.toBeNull();
  });
});
