import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import { signup } from '../../identity/index.js';
import {
  assertCanConnect,
  EmailNotVerifiedError,
  type EntitlementCtx,
} from '../entitlement.service.js';

/**
 * entitlement-edge-cases.integration.test.ts (C2 hardening pass, P04b) -
 * every prerequisite-permutation denial NOT covered by
 * entitlement.integration.test.ts's two HTTP-level proofs (unverified-email
 * denial + fully-onboarded 501): each pre-connect onboarding step's own
 * denial reason string, a suspended/closed client denying EVEN when fully
 * onboarded (fail-closed on status, independent of onboarding progress),
 * and a nonexistent client/user denying (fail-closed) rather than throwing
 * an unhandled error. Direct service calls (not HTTP) - `entitlement.service.ts`'s own
 * surface, seeded via the superuser pool exactly like
 * onboarding-under-wp-app-role.integration.test.ts does for its RLS proof.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `entitlement-edge-${label}-${randomUUID()}@example.test`;
}

function baseCtx(): EntitlementCtx {
  return { pool };
}

async function seedClient(
  label: string,
  overrides: { status?: string; onboardingStep?: string; emailVerified?: boolean } = {},
): Promise<{ userId: string; clientId: string }> {
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async () => {},
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    {
      fullName: `Entitlement Edge ${label}`,
      email: uniqueEmail(label),
      companyName: `Entitlement Edge Co ${label}`,
    },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);

  if (overrides.emailVerified) {
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [result.userId]);
  }
  if (overrides.status || overrides.onboardingStep) {
    await pool.query(
      `UPDATE clients SET
         status = COALESCE($2, status),
         onboarding_step = COALESCE($3, onboarding_step)
       WHERE id = $1`,
      [result.clientId, overrides.status ?? null, overrides.onboardingStep ?? null],
    );
  }
  return { userId: result.userId, clientId: result.clientId };
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

describe('entitlement gate - every prerequisite permutation (fail-closed)', () => {
  it('unverified_email_denies_regardless_of_client_status_or_onboarding_step', async () => {
    const { userId, clientId } = await seedClient('unverified', {
      status: 'active',
      onboardingStep: 'connect_whatsapp',
      emailVerified: false,
    });

    await expect(assertCanConnect(baseCtx(), { clientId, userId })).rejects.toThrow(
      EmailNotVerifiedError,
    );
  });

  it('status_suspended_denies_client_not_active_even_when_fully_onboarded', async () => {
    const { userId, clientId } = await seedClient('suspended-onboarded', {
      status: 'suspended',
      onboardingStep: 'connect_whatsapp',
      emailVerified: true,
    });

    await expect(assertCanConnect(baseCtx(), { clientId, userId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'client_not_active' },
    });
  });

  it('status_closed_denies_client_not_active_even_when_fully_onboarded', async () => {
    const { userId, clientId } = await seedClient('closed-onboarded', {
      status: 'closed',
      onboardingStep: 'connect_whatsapp',
      emailVerified: true,
    });

    await expect(assertCanConnect(baseCtx(), { clientId, userId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'client_not_active' },
    });
  });

  it.each([
    ['verify_email', 'onboarding_incomplete:verify_email'],
    ['choose_timezone', 'onboarding_incomplete:choose_timezone'],
    ['accept_pacing_profile', 'onboarding_incomplete:accept_pacing_profile'],
    ['attest_consent', 'onboarding_incomplete:attest_consent'],
  ])(
    'active_client_on_pre_connect_step_%s_denies_with_reason_%s',
    async (onboardingStep, expectedReason) => {
      const { userId, clientId } = await seedClient(`step-${onboardingStep}`, {
        status: 'active',
        onboardingStep,
        emailVerified: true,
      });

      await expect(assertCanConnect(baseCtx(), { clientId, userId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: expectedReason },
      });
    },
  );

  it('active_client_at_or_past_connect_whatsapp_is_entitled', async () => {
    const { userId, clientId } = await seedClient('at-connect', {
      status: 'active',
      onboardingStep: 'connect_whatsapp',
      emailVerified: true,
    });

    await expect(assertCanConnect(baseCtx(), { clientId, userId })).resolves.toBeUndefined();

    // Past connect_whatsapp (send_test / done) also remains entitled.
    await pool.query(`UPDATE clients SET onboarding_step = 'done' WHERE id = $1`, [clientId]);
    await expect(assertCanConnect(baseCtx(), { clientId, userId })).resolves.toBeUndefined();
  });

  it('a_nonexistent_client_id_denies_client_not_active_never_throws_unhandled', async () => {
    const { userId } = await seedClient('user-only', { emailVerified: true });
    await expect(
      assertCanConnect(baseCtx(), { clientId: randomUUID(), userId }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'client_not_active' },
    });
  });

  it('a_nonexistent_user_id_denies_client_not_active_never_throws_unhandled', async () => {
    const { clientId } = await seedClient('client-only', {
      status: 'active',
      onboardingStep: 'connect_whatsapp',
    });
    await expect(
      assertCanConnect(baseCtx(), { clientId, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'client_not_active' } });
  });
});
