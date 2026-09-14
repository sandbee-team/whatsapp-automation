import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSendTenant } from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { resolveEffectiveMaxContacts } from '../contacts/index.js';
import { attemptClaim } from './__tests__/internal-mutations-support.js';
import { notificationKinds, walletAccount } from './__tests__/internal-probe-support.js';
import { staffAuditActions } from './__tests__/internal-u3b-support.js';
import { startU3bHarness, type U3bHarness } from './__tests__/internal-u3b-app-fixture.js';

/**
 * internal-mutations-clients-pricing.integration.test.ts (P28 Unit U3b,
 * step 5) - the staff PRICING / LIMITS / PLAN mutations. Sibling of
 * `internal-mutations-clients.integration.test.ts` (suspend/reactivate),
 * split for that file's own `max-lines: 300` cap; both share
 * `__tests__/internal-u3b-app-fixture.ts`.
 *
 * Every money assertion here is an EXACT paise value, never a bound: a
 * pricing override that landed at the WRONG rate would still satisfy
 * `<= 100`, and `max_rate_minor` is what `claim-jobs.sql`'s
 * `balance_minor >= max_rate_minor` predicate admits a client on.
 */

let h: U3bHarness;

beforeAll(async () => {
  h = await startU3bHarness({
    secret: 'internal-u3b-pricing-test-secret-0123456789',
    applicationName: 'internal-u3b-pricing-tests',
  });
});

afterAll(async () => {
  await h.close();
});

describe('internal-mutations-clients-pricing (P28 U3b)', () => {
  it('a_pricing_override_rewrites_max_rate_minor_in_the_same_transaction', async () => {
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {
      balanceMinor: 50,
      walletState: 'active',
      maxRateMinor: 100,
    });
    const staffId = await h.seedStaff('superadmin');

    const override = await h.send('PUT', `/internal/v1/clients/${clientId}/pricing`, staffId, {
      reason: 'negotiated enterprise rate card for this account',
      overrideItems: { text: '90' },
    });
    expect(override.statusCode).toBe(200);
    // EXACT: 90 paise is now the highest of the four effective price keys
    // (`default_inr`'s own highest is 25), so it becomes `max_rate_minor`.
    expect(override.json().data.maxRateMinor).toBe('90');

    const account = await h.pool.query<{ max_rate_minor: string }>(
      `SELECT max_rate_minor::text AS max_rate_minor FROM wallet_accounts WHERE client_id = $1`,
      [clientId],
    );
    expect(account.rows[0]?.max_rate_minor).toBe('90');
    // The override moved the RATE, never the balance.
    expect((await walletAccount(h.pool, clientId)).balanceMinor).toBe('50');

    // A 50-paise balance cannot cover a 90-paise max rate -> zero claims.
    await seedQueuedJob(h.pool, { clientId, instanceId });
    expect(await attemptClaim(h.pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(0);

    // Clearing the override restores the list price EXACTLY, and the same
    // queued job becomes claimable again.
    const cleared = await h.send('PUT', `/internal/v1/clients/${clientId}/pricing`, staffId, {
      reason: 'reverting to the standard rate card',
      overrideItems: {},
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.overrideItems).toEqual({});
    expect(cleared.json().data.maxRateMinor).toBe('25');
    const afterClear = await walletAccount(h.pool, clientId);
    expect([afterClear.balanceMinor, afterClear.state]).toEqual(['50', 'active']);
    expect(await attemptClaim(h.pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(1);

    expect(await notificationKinds(h.pool, clientId)).toEqual([
      'pricing_changed',
      'pricing_changed',
    ]);
  });

  it('limit_overrides_are_upserted_and_read_through_by_admission', async () => {
    const { clientId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const staffId = await h.seedStaff('ops');
    await h.pool.query(
      `UPDATE clients SET plan_id = (SELECT id FROM plans WHERE key = 'starter'), updated_at = now()
        WHERE id = $1`,
      [clientId],
    );

    // The plan baseline, read through the SAME reader admission uses.
    const planValue = await h.tenantDb.withTenant(clientId, (tx) =>
      resolveEffectiveMaxContacts(tx, clientId),
    );
    expect(planValue).toBe(5000);

    const set = await h.send('PUT', `/internal/v1/clients/${clientId}/limits`, staffId, {
      reason: 'temporary contact cap while the account is under review',
      overrides: [{ limitKey: 'max_contacts', limitValue: 2 }],
    });
    expect(set.statusCode).toBe(200);
    expect(
      await h.tenantDb.withTenant(clientId, (tx) => resolveEffectiveMaxContacts(tx, clientId)),
    ).toBe(2);

    // A repeat upsert on the SAME key REPLACES rather than accumulating.
    const raised = await h.send('PUT', `/internal/v1/clients/${clientId}/limits`, staffId, {
      reason: 'raising the interim cap after a partial review',
      overrides: [{ limitKey: 'max_contacts', limitValue: 7 }],
    });
    expect(raised.statusCode).toBe(200);
    expect(
      await h.tenantDb.withTenant(clientId, (tx) => resolveEffectiveMaxContacts(tx, clientId)),
    ).toBe(7);
    const overrideCount = await h.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM client_limit_overrides WHERE client_id = $1`,
      [clientId],
    );
    expect(overrideCount.rows[0]?.n).toBe('1');

    // `limitValue: null` is a SOFT clear (no DELETE grant exists) - the
    // reader must fall back to the plan value, EXACTLY.
    const cleared = await h.send('PUT', `/internal/v1/clients/${clientId}/limits`, staffId, {
      reason: 'review closed - restoring the plan contact cap',
      overrides: [{ limitKey: 'max_contacts', limitValue: null }],
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      await h.tenantDb.withTenant(clientId, (tx) => resolveEffectiveMaxContacts(tx, clientId)),
    ).toBe(5000);

    const plan = await h.send('PUT', `/internal/v1/clients/${clientId}/plan`, staffId, {
      reason: 'upgraded to growth per the signed order form',
      planKey: 'growth',
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().data.planKey).toBe('growth');
    const planRow = await h.pool.query<{ key: string }>(
      `SELECT p.key FROM clients c JOIN plans p ON p.id = c.plan_id WHERE c.id = $1`,
      [clientId],
    );
    expect(planRow.rows[0]?.key).toBe('growth');

    // One staff audit row and one `limits_changed` notification PER call.
    expect((await staffAuditActions(h.pool, clientId)).map((row) => row.action)).toEqual([
      'clients.limits',
      'clients.limits',
      'clients.limits',
      'clients.plan',
    ]);
    expect(await notificationKinds(h.pool, clientId)).toEqual([
      'limits_changed',
      'limits_changed',
      'limits_changed',
      'limits_changed',
    ]);
  });

  it('an_unknown_plan_key_or_limit_key_is_rejected_before_any_write', async () => {
    const { clientId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const staffId = await h.seedStaff('superadmin');

    const badPlan = await h.send('PUT', `/internal/v1/clients/${clientId}/plan`, staffId, {
      reason: 'a plan key that does not exist in the catalogue',
      planKey: 'enterprise',
    });
    expect(badPlan.statusCode).toBe(400);

    const badLimit = await h.send('PUT', `/internal/v1/clients/${clientId}/limits`, staffId, {
      reason: 'a limit key that is not in the contract enum',
      overrides: [{ limitKey: 'max_anything', limitValue: 1 }],
    });
    expect(badLimit.statusCode).toBe(400);

    // A 400 is raised BEFORE `withStaffMutation` is entered, so not even an
    // audit row exists.
    expect(await staffAuditActions(h.pool, clientId)).toEqual([]);
    expect(await notificationKinds(h.pool, clientId)).toEqual([]);
  });
});
