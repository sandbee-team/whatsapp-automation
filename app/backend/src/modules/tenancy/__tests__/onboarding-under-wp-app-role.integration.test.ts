import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { signup } from '../../identity/index.js';
import { assertCanConnect, type EntitlementCtx } from '../entitlement.service.js';
import {
  getOnboardingStatus,
  setConsent,
  setPacingProfile,
  setTimezone,
  type OnboardingCtx,
} from '../onboarding.service.js';
import { EntitlementDeniedError } from '../entitlement.service.js';
import { wrapAsRole } from './wp-app-role-test-support.js';

/**
 * onboarding-under-wp-app-role.integration.test.ts (P04b Unit UB1b, THE RLS
 * PROOF - binding). Every other test in this module connects as the dev
 * superuser (BYPASSRLS); this file runs `onboarding.service.ts`'s and
 * `entitlement.service.ts`'s own functions against a connection that
 * actually operates AS `wp_app` (NOLOGIN, FORCE RLS) via `wrapAsRole` (`SET
 * LOCAL ROLE wp_app` inside each transaction - transaction-scoped, reverts
 * automatically at COMMIT/ROLLBACK).
 *
 * The client is seeded via `signup()` (superuser pool - out of THIS unit's
 * scope) and then activated/advanced to `choose_timezone` with a direct SQL
 * UPDATE (superuser, out of scope - `verify-email`'s own wp_app proof
 * already lives in modules/identity/__tests__/
 * identity-under-wp-app-role.integration.test.ts). Every onboarding/
 * entitlement operation below is what THIS unit's own wp_app proof covers.
 *
 * Two-tenant interference sanity (Blueprint's tenant-isolation invariant):
 * tenant B's onboarding state is untouched and unreadable while tenant A
 * advances - proven as the final assertion.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

function uniqueEmail(label: string): string {
  return `wp-app-onboarding-${label}-${randomUUID()}@example.test`;
}

async function seedActivatedClient(label: string): Promise<{ userId: string; clientId: string }> {
  const result = await signup(
    {
      tenantDb,
      sendVerificationEmail: async () => {},
      publicBaseUrl: 'http://localhost:5173',
      signupCreditMinor: 10000,
      lowBalanceThresholdMinor: 500,
    },
    {
      fullName: `WP App Onboarding ${label}`,
      email: uniqueEmail(label),
      companyName: `WP App Onboarding Co ${label}`,
    },
  );
  createdUserIds.push(result.userId);
  createdClientIds.push(result.clientId);

  // Superuser, direct - equivalent effect to verify-email's own activation +
  // onboarding_step advance (already proven under wp_app in
  // modules/identity/__tests__/identity-under-wp-app-role.integration.test.ts);
  // out of THIS unit's scope.
  await pool.query(
    `UPDATE clients SET status = 'active', onboarding_step = 'choose_timezone' WHERE id = $1`,
    [result.clientId],
  );
  await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [result.userId]);

  return { userId: result.userId, clientId: result.clientId };
}

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
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
  await pool.end();
});

describe('onboarding + entitlement under wp_app + FORCE RLS (P04b Unit UB1b - THE PROOF)', () => {
  it('the_full_onboarding_and_entitlement_chain_works_as_wp_app', async () => {
    const tenantA = await seedActivatedClient('a');
    const tenantB = await seedActivatedClient('b');

    const onboardingCtx: OnboardingCtx = { pool: wrapAsRole(pool, 'wp_app') };
    const entitlementCtx: EntitlementCtx = { pool: wrapAsRole(pool, 'wp_app') };

    // 1. GET-equivalent read as wp_app.
    const status0 = await getOnboardingStatus(onboardingCtx, tenantA.clientId);
    expect(status0.step).toBe('choose_timezone');

    // 2. Pre-state sanity check only: entitlement denies pre-completion
    // under wp_app. This alone cannot discriminate "correctly denied
    // because onboarding is incomplete" from "denied because a zero-row
    // RLS read looks identical to a real denial" - step 5 (post-completion)
    // is the load-bearing assertion that actually rules out the latter.
    await expect(
      assertCanConnect(entitlementCtx, { clientId: tenantA.clientId, userId: tenantA.userId }),
    ).rejects.toThrow(EntitlementDeniedError);

    // 3. Advance timezone -> pacing-profile -> consent, each a conditional
    // UPDATE under wp_app + FORCE RLS - must actually commit, not silently
    // no-op the way an unscoped GUC would.
    const afterTz = await setTimezone(onboardingCtx, {
      clientId: tenantA.clientId,
      timezone: 'Asia/Kolkata',
    });
    expect(afterTz.step).toBe('accept_pacing_profile');

    const afterPacing = await setPacingProfile(onboardingCtx, {
      clientId: tenantA.clientId,
      profileKey: 'standard',
    });
    expect(afterPacing.step).toBe('attest_consent');

    const afterConsent = await setConsent(onboardingCtx, {
      clientId: tenantA.clientId,
      userId: tenantA.userId,
    });
    expect(afterConsent.step).toBe('connect_whatsapp');

    // 4. The consent audit_logs INSERT (tenant-scoped, FORCE RLS `WITH
    // CHECK`) must have actually committed under wp_app.
    const auditRows = await pool.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_logs
        WHERE client_id = $1 AND action = 'onboarding.consent_attested'`,
      [tenantA.clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]!.actor_user_id).toBe(tenantA.userId);

    // 5. Entitlement now SUCCEEDS as wp_app (the stub route itself is HTTP-
    // level - out of this direct-service-call proof's scope).
    await expect(
      assertCanConnect(entitlementCtx, { clientId: tenantA.clientId, userId: tenantA.userId }),
    ).resolves.toBeUndefined();

    // 6. Two-tenant interference sanity: tenant B's onboarding state is
    // UNTOUCHED (still on choose_timezone) despite tenant A's advances
    // above running through the exact same wp_app connection pool.
    const statusB = await getOnboardingStatus(onboardingCtx, tenantB.clientId);
    expect(statusB.step).toBe('choose_timezone');
    await expect(
      assertCanConnect(entitlementCtx, { clientId: tenantB.clientId, userId: tenantB.userId }),
    ).rejects.toThrow(EntitlementDeniedError);
  });
});
