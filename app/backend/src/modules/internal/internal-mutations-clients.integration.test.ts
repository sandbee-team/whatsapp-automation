import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSendTenant } from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { attemptClaim } from './__tests__/internal-mutations-support.js';
import { notificationKinds, walletAccount } from './__tests__/internal-probe-support.js';
import {
  clientStatus,
  jobSnapshot,
  jobStatusCounts,
  seedExtraInstance,
  setClientStatus,
  staffAuditActions,
} from './__tests__/internal-u3b-support.js';
import { startU3bHarness, type U3bHarness } from './__tests__/internal-u3b-app-fixture.js';

/**
 * internal-mutations-clients.integration.test.ts (P28 Unit U3b, step 5) - the
 * staff SUSPEND/REACTIVATE mutations. The limits/plan/pricing half lives in
 * the `internal-mutations-clients-pricing.integration.test.ts` sibling
 * (`max-lines: 300` split); both share
 * `__tests__/internal-u3b-app-fixture.ts`.
 *
 * `.integration.test.ts` suffix is mandatory (real Postgres) - see
 * `internal-auth.integration.test.ts`'s header for the two-vitest-project
 * reason.
 */

let h: U3bHarness;

beforeAll(async () => {
  h = await startU3bHarness({
    secret: 'internal-u3b-clients-test-secret-0123456789',
    applicationName: 'internal-u3b-clients-tests',
  });
});

afterAll(async () => {
  await h.close();
});

describe('internal-mutations-clients (P28 U3b)', () => {
  it('staff_suspend_stops_claiming_and_preserves_every_queued_job', async () => {
    // PHASE DEMO CASE.
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {
      balanceMinor: 100_000,
      walletState: 'active',
    });
    const secondInstanceId = await seedExtraInstance(h.pool, clientId);
    const staffId = await h.seedStaff('ops');

    for (let i = 0; i < 3; i += 1) {
      await seedQueuedJob(h.pool, { clientId, instanceId });
      await seedQueuedJob(h.pool, { clientId, instanceId: secondInstanceId });
    }
    const beforeSnapshot = await jobSnapshot(h.pool, clientId);
    expect(JSON.parse(beforeSnapshot)).toHaveLength(6);

    const suspend = await h.send('POST', `/internal/v1/clients/${clientId}/suspend`, staffId, {
      reason: 'repeated unverified recipient complaints under review',
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().data.status).toBe('suspended');
    expect(suspend.json().data.changed).toBe(true);
    expect(await clientStatus(h.pool, clientId)).toBe('suspended');

    // The real claim statement, for BOTH instances: a suspended client grants
    // zero claims (claim-jobs.sql's own `c.status = 'active'` predicate).
    for (const id of [instanceId, secondInstanceId]) {
      expect(await attemptClaim(h.pool, { clientId, instanceId: id, band: 3, fence: 1 })).toBe(0);
    }

    // Invariant 5: a suspend never loses, fails or deletes queued work.
    expect(await jobSnapshot(h.pool, clientId)).toBe(beforeSnapshot);
    expect(await jobStatusCounts(h.pool, clientId)).toEqual({ queued: 6 });

    expect(await notificationKinds(h.pool, clientId)).toEqual(['client_suspended']);
    const audit = await staffAuditActions(h.pool, clientId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('clients.suspend');
    expect(audit[0]?.target_kind).toBe('client');
    expect(audit[0]?.target_ref).toBe(clientId);

    // Reactivate restores claiming, still without touching a job row.
    const reactivate = await h.send(
      'POST',
      `/internal/v1/clients/${clientId}/reactivate`,
      staffId,
      { reason: 'review closed with no action required' },
    );
    expect(reactivate.statusCode).toBe(200);
    expect(reactivate.json().data.status).toBe('active');
    expect(reactivate.json().data.changed).toBe(true);
    expect(await clientStatus(h.pool, clientId)).toBe('active');
    expect(await attemptClaim(h.pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(1);
  });

  it('a_repeat_suspend_is_a_no_op_and_a_closed_client_is_never_touched', async () => {
    const { clientId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const staffId = await h.seedStaff('ops');
    const body = { reason: 'first suspension for account review' };

    const first = await h.send('POST', `/internal/v1/clients/${clientId}/suspend`, staffId, body);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.changed).toBe(true);

    // Already suspended -> `changed:false`, never a 409 and never a second
    // notification.
    const repeat = await h.send('POST', `/internal/v1/clients/${clientId}/suspend`, staffId, body);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().data.changed).toBe(false);
    expect(await notificationKinds(h.pool, clientId)).toEqual(['client_suspended']);

    // `closed` is never touched by staff -> 409 INVALID_STATE, row unchanged.
    await setClientStatus(h.pool, clientId, 'closed');
    const closed = await h.send('POST', `/internal/v1/clients/${clientId}/suspend`, staffId, {
      reason: 'attempt to suspend an already-closed account',
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('INVALID_STATE');
    expect(await clientStatus(h.pool, clientId)).toBe('closed');
  });

  it('a_reactivate_publishes_a_wake_for_every_instance_of_the_client', async () => {
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const secondInstanceId = await seedExtraInstance(h.pool, clientId);
    const deletedInstanceId = await seedExtraInstance(h.pool, clientId, { deleted: true });
    const staffId = await h.seedStaff('ops');

    h.wakeCalls.length = 0;
    const suspend = await h.send('POST', `/internal/v1/clients/${clientId}/suspend`, staffId, {
      reason: 'temporary hold pending a billing review',
    });
    expect(suspend.statusCode).toBe(200);
    // A suspend never wakes anything - it is a STOP.
    expect(h.wakeCalls).toEqual([]);

    const reactivate = await h.send(
      'POST',
      `/internal/v1/clients/${clientId}/reactivate`,
      staffId,
      { reason: 'billing review closed' },
    );
    expect(reactivate.statusCode).toBe(200);
    expect(reactivate.json().data.wokenInstances).toBe(2);

    const forThisClient = h.wakeCalls.filter((call) => call.clientId === clientId);
    expect(forThisClient).toHaveLength(2);
    expect(forThisClient.map((call) => call.instanceId).sort()).toEqual(
      [instanceId, secondInstanceId].sort(),
    );
    expect(forThisClient.some((call) => call.instanceId === deletedInstanceId)).toBe(false);
    expect(await notificationKinds(h.pool, clientId)).toEqual([
      'client_suspended',
      'client_reactivated',
    ]);
  });

  it('a_support_role_may_not_suspend_or_reprice_a_client', async () => {
    const { clientId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const supportId = await h.seedStaff('support');
    const opsId = await h.seedStaff('ops');

    const suspend = await h.send('POST', `/internal/v1/clients/${clientId}/suspend`, supportId, {
      reason: 'support attempting an action outside its role',
    });
    expect(suspend.statusCode).toBe(403);
    expect(await clientStatus(h.pool, clientId)).toBe('active');

    // Pricing is superadmin-only: even `ops` is refused.
    const pricing = await h.send('PUT', `/internal/v1/clients/${clientId}/pricing`, opsId, {
      reason: 'ops attempting a pricing change',
      overrideItems: { text: '90' },
    });
    expect(pricing.statusCode).toBe(403);
    expect((await walletAccount(h.pool, clientId)).state).toBe('active');

    expect(await staffAuditActions(h.pool, clientId)).toEqual([]);
    expect(await notificationKinds(h.pool, clientId)).toEqual([]);
  });
});
