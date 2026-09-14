import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { generate as otpGenerate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { loadConfig } from '../../../platform/config.js';
import { signup } from '../signup.service.js';
import {
  enrolConfirm,
  enrolStart,
  InvalidRecoveryCodeError,
  InvalidTotpCodeError,
  MfaAlreadyEnrolledError,
  verify,
  verifyRecoveryCode,
  type TotpCtx,
} from '../totp.service.js';
import * as identityRepoDefault from '../identity.repo.js';

/**
 * totp.integration.test.ts (P04a Unit UA5b) - TOTP enrolment/verification and
 * recovery codes, proven against real Postgres + real Redis. Users/clients
 * are created via the existing `signup` service; each test user is unique.
 */

const ENV = 'test';
const TEST_KEY_RING_PATH = loadConfig({ NODE_ENV: 'test' }).KEY_RING_PATH;

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];
const usedRedisKeys: string[] = [];

function uniqueEmail(label: string): string {
  return `totp-${label}-${randomUUID()}@example.test`;
}

function baseCtx(overrides: Partial<TotpCtx> = {}): TotpCtx {
  return {
    db: pool,
    pool,
    redis,
    keyRingPath: TEST_KEY_RING_PATH,
    totpWindow: 1,
    totpUsedCodeTtlSec: 95,
    env: ENV,
    ...overrides,
  };
}

async function createUser(
  label: string,
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
    { fullName: `Totp Test ${label}`, email, companyName: `Totp Co ${label}` },
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
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Children first (mfa_recovery_codes before users).
    await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = ANY($1)', [createdUserIds]);
  }
  for (const key of usedRedisKeys) {
    await redis.del(key);
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
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [
      createdUserIds,
    ]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  redis.disconnect();
  await pool.end();
});

describe('totp (P04a Unit UA5b, TOTP MFA enrolment/verification + recovery codes)', () => {
  it('totp_secret_is_never_stored_in_plaintext', async () => {
    const { userId, email } = await createUser('plaintext');
    const ctx = baseCtx();

    const { secretShownOnce } = await enrolStart(ctx, userId, email);

    const row = await pool.query<{ mfa_totp_secret_enc: Buffer }>(
      'SELECT mfa_totp_secret_enc FROM users WHERE id = $1',
      [userId],
    );
    const raw = row.rows[0]!.mfa_totp_secret_enc;
    expect(raw).not.toBeNull();
    expect(raw.toString('utf8')).not.toContain(secretShownOnce);
    expect(raw.toString('ascii')).not.toContain(secretShownOnce);

    // Complete enrolment (verify() only serves an already-enrolled account),
    // then reuse the SAME code with verify() - enrolConfirm's own inline
    // check never touches the Redis replay marker, so this is still the
    // code's first submission to verify(). A working verify() proves the
    // round trip: the sealed column really does open back to the original
    // secret, not just "doesn't look like it".
    const code = await otpGenerate({ secret: secretShownOnce });
    await enrolConfirm(ctx, userId, code);
    await expect(verify(ctx, userId, code)).resolves.toBeUndefined();
    usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));
  });

  it('a_used_totp_code_cannot_be_replayed_within_its_window', async () => {
    const { userId, email } = await createUser('replay');
    const ctx = baseCtx();

    const { secretShownOnce } = await enrolStart(ctx, userId, email);
    const code = await otpGenerate({ secret: secretShownOnce });
    await enrolConfirm(ctx, userId, code);
    usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));

    await expect(verify(ctx, userId, code)).resolves.toBeUndefined();
    await expect(verify(ctx, userId, code)).rejects.toThrow(InvalidTotpCodeError);
  });

  it('enrol_confirm_sets_mfa_enabled_at_and_returns_ten_recovery_codes_once', async () => {
    const { userId, email } = await createUser('confirm');
    const ctx = baseCtx();

    const { secretShownOnce } = await enrolStart(ctx, userId, email);
    const code = await otpGenerate({ secret: secretShownOnce });
    usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));

    const { recoveryCodes } = await enrolConfirm(ctx, userId, code);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const userRow = await pool.query<{ mfa_enabled_at: Date | null }>(
      'SELECT mfa_enabled_at FROM users WHERE id = $1',
      [userId],
    );
    expect(userRow.rows[0]!.mfa_enabled_at).not.toBeNull();

    const codeRows = await pool.query<{ used_at: Date | null }>(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1',
      [userId],
    );
    expect(codeRows.rows).toHaveLength(10);
    for (const row of codeRows.rows) {
      expect(row.used_at).toBeNull();
    }
  });

  it('a_recovery_code_works_exactly_once', async () => {
    const { userId, email } = await createUser('recovery');
    const ctx = baseCtx();

    const { secretShownOnce } = await enrolStart(ctx, userId, email);
    const code = await otpGenerate({ secret: secretShownOnce });
    usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));

    const { recoveryCodes } = await enrolConfirm(ctx, userId, code);
    const firstRecoveryCode = recoveryCodes[0]!;

    await expect(verifyRecoveryCode(ctx, userId, firstRecoveryCode)).resolves.toBeUndefined();
    await expect(verifyRecoveryCode(ctx, userId, firstRecoveryCode)).rejects.toThrow(
      InvalidRecoveryCodeError,
    );
  });

  describe('FIX 11 (P04a FIXB, enrol re-enrolment + atomic confirm)', () => {
    it('enrolStart_rejects_with_conflict_once_already_enrolled', async () => {
      const { userId, email } = await createUser('enrol-start-conflict');
      const ctx = baseCtx();

      const { secretShownOnce } = await enrolStart(ctx, userId, email);
      const code = await otpGenerate({ secret: secretShownOnce });
      usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));
      await enrolConfirm(ctx, userId, code);

      await expect(enrolStart(ctx, userId, email)).rejects.toThrow(MfaAlreadyEnrolledError);
    });

    it('enrolConfirm_rejects_with_conflict_once_already_enrolled', async () => {
      const { userId, email } = await createUser('enrol-confirm-conflict');
      const ctx = baseCtx();

      const { secretShownOnce } = await enrolStart(ctx, userId, email);
      const code = await otpGenerate({ secret: secretShownOnce });
      usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));
      await enrolConfirm(ctx, userId, code);

      const secondCode = await otpGenerate({ secret: secretShownOnce });
      await expect(enrolConfirm(ctx, userId, secondCode)).rejects.toThrow(MfaAlreadyEnrolledError);
    });

    it('a_mid_loop_recovery_code_insert_failure_leaves_mfa_disabled_and_zero_codes', async () => {
      const { userId, email } = await createUser('enrol-confirm-atomic');
      let insertCalls = 0;
      const ctx = baseCtx({
        identityRepo: {
          ...identityRepoDefault,
          insertMfaRecoveryCode: async (sql, input) => {
            insertCalls += 1;
            if (insertCalls === 5) {
              throw new Error('injected failure at the 5th recovery code insert');
            }
            await identityRepoDefault.insertMfaRecoveryCode(sql, input);
          },
        },
      });

      const { secretShownOnce } = await enrolStart(ctx, userId, email);
      const code = await otpGenerate({ secret: secretShownOnce });
      usedRedisKeys.push(sysKey(ENV, 'totp', 'used', 'u', userId, code));

      await expect(enrolConfirm(ctx, userId, code)).rejects.toThrow('injected failure');

      const userRow = await pool.query<{ mfa_enabled_at: Date | null }>(
        'SELECT mfa_enabled_at FROM users WHERE id = $1',
        [userId],
      );
      expect(userRow.rows[0]!.mfa_enabled_at).toBeNull();

      const codeRows = await pool.query('SELECT id FROM mfa_recovery_codes WHERE user_id = $1', [
        userId,
      ]);
      expect(codeRows.rows).toHaveLength(0);
    });
  });
});
