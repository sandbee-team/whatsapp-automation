import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSendTenant } from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { attemptClaim } from './__tests__/internal-mutations-support.js';
import { notificationKinds } from './__tests__/internal-probe-support.js';
import {
  auditLogRows,
  forceInstanceState,
  instanceHealth,
  jobSnapshot,
  jobStatusCounts,
} from './__tests__/internal-u3b-support.js';
import { startU3bHarness, type U3bHarness } from './__tests__/internal-u3b-app-fixture.js';

/**
 * internal-mutations-instances.integration.test.ts (P28 Unit U3b, step 5) -
 * the staff INSTANCE-control mutations (pause/resume), including the phase safety
 * test 11: a resume is only ever a NAMED STAFF HUMAN's decision, and a
 * `provider_restriction` pause needs an explicit acknowledgement even for
 * staff. Boot/teardown comes from `__tests__/internal-u3b-app-fixture.ts`.
 */

let h: U3bHarness;

beforeAll(async () => {
  h = await startU3bHarness({
    secret: 'internal-u3b-instances-test-secret-0123456789',
    applicationName: 'internal-u3b-instances-tests',
  });
});

afterAll(async () => {
  await h.close();
});

async function post(
  path: string,
  staffId: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<U3bHarness['send']>>> {
  return h.send('POST', path, staffId, body);
}

describe('internal-mutations-instances (P28 U3b)', () => {
  it('staff_pause_keeps_queued_jobs_and_stops_claims', async () => {
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const staffId = await h.seedStaff('ops');
    for (let i = 0; i < 3; i += 1) await seedQueuedJob(h.pool, { clientId, instanceId });

    // A claim succeeds BEFORE the pause - so the zero-claim assertion below
    // proves the pause did it, not a fixture that never could claim.
    expect(await attemptClaim(h.pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(1);
    const beforeSnapshot = await jobSnapshot(h.pool, clientId);

    const pause = await post(`/internal/v1/instances/${instanceId}/pause`, staffId, {
      clientId,
      reason: 'suspected spam content pending a manual content review',
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().data.changed).toBe(true);
    expect(pause.json().data.healthState).toBe('paused');
    expect(pause.json().data.pauseReason).toBe('admin_action');

    const health = await instanceHealth(h.pool, clientId, instanceId);
    expect(health.health_state).toBe('paused');
    expect(health.pause_reason).toBe('admin_action');
    // A staff pause is NOT a tenant action item - WP support owns undoing it.
    expect(health.needs_user_action).toBe(false);
    expect(health.user_action_reason).toBeNull();

    expect(await attemptClaim(h.pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(0);
    // Invariant 5: the queued rows are untouched by the pause.
    expect(await jobSnapshot(h.pool, clientId)).toBe(beforeSnapshot);
    expect(await jobStatusCounts(h.pool, clientId)).toEqual({ processing: 1, queued: 2 });

    expect(await notificationKinds(h.pool, clientId)).toEqual(['instance_paused_by_staff']);

    // A repeat pause is an idempotent no-op, never a second write.
    const repeat = await post(`/internal/v1/instances/${instanceId}/pause`, staffId, {
      clientId,
      reason: 'suspected spam content pending a manual content review',
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().data.changed).toBe(false);
    expect(await notificationKinds(h.pool, clientId)).toEqual(['instance_paused_by_staff']);
  });

  it('pausing_a_logged_out_instance_is_a_409_and_never_relabels_a_restriction_pause', async () => {
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const staffId = await h.seedStaff('ops');

    await forceInstanceState(h.pool, { clientId, instanceId, healthState: 'logged_out' });
    const loggedOut = await post(`/internal/v1/instances/${instanceId}/pause`, staffId, {
      clientId,
      reason: 'attempting to pause a logged-out number',
    });
    expect(loggedOut.statusCode).toBe(409);
    expect(loggedOut.json().error.code).toBe('INVALID_STATE');
    expect((await instanceHealth(h.pool, clientId, instanceId)).health_state).toBe('logged_out');

    // An instance already paused BY A PROVIDER RESTRICTION must keep that
    // pause_reason - relabelling it 'admin_action' would erase the record of
    // why sending actually stopped.
    await forceInstanceState(h.pool, {
      clientId,
      instanceId,
      healthState: 'paused',
      pauseReason: 'provider_restriction',
    });
    const restricted = await post(`/internal/v1/instances/${instanceId}/pause`, staffId, {
      clientId,
      reason: 'staff pause on top of an existing restriction pause',
    });
    expect(restricted.statusCode).toBe(200);
    expect(restricted.json().data.changed).toBe(false);
    expect((await instanceHealth(h.pool, clientId, instanceId)).pause_reason).toBe(
      'provider_restriction',
    );
  });

  it('staff_resume_rejects_a_service_or_api_key_actor_and_requires_a_staff_user', async () => {
    // SAFE MODE TEST 11.
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const opsId = await h.seedStaff('ops');
    const supportId = await h.seedStaff('support');
    const path = `/internal/v1/instances/${instanceId}/resume`;
    const body = { clientId, reason: 'content review closed with no action needed' };

    // Paused through the real staff writer, not a raw UPDATE.
    const pause = await post(`/internal/v1/instances/${instanceId}/pause`, opsId, {
      clientId,
      reason: 'paused for the resume-actor probe',
    });
    expect(pause.statusCode).toBe(200);
    expect((await instanceHealth(h.pool, clientId, instanceId)).health_state).toBe('paused');

    // (a) a SYSTEM actor may never resume.
    const asSystem = await h.sendAs('POST', path, 'system', body);
    expect(asSystem.statusCode).toBe(403);
    expect((await instanceHealth(h.pool, clientId, instanceId)).health_state).toBe('paused');

    // (b) an API-KEY actor may never resume.
    const asApiKey = await h.sendAs('POST', path, `api_key:${randomUUID()}`, body);
    expect(asApiKey.statusCode).toBe(403);
    expect((await instanceHealth(h.pool, clientId, instanceId)).health_state).toBe('paused');

    // (c) a real staff human, but WITHOUT the `instances.resume` permission.
    const asSupport = await post(path, supportId, body);
    expect(asSupport.statusCode).toBe(403);
    expect((await instanceHealth(h.pool, clientId, instanceId)).health_state).toBe('paused');

    // (d) a real staff human WITH the permission - the only accepted caller.
    h.wakeCalls.length = 0;
    const asOps = await post(path, opsId, body);
    expect(asOps.statusCode).toBe(200);
    expect(asOps.json().data.resumed).toBe(true);
    // 'degraded', never 'connected': the socket is not re-established by a
    // DB write alone (see human-resume.ts's own FSM note).
    expect(asOps.json().data.healthState).toBe('degraded');
    const resumed = await instanceHealth(h.pool, clientId, instanceId);
    expect(resumed.health_state).toBe('degraded');
    expect(resumed.pause_reason).toBeNull();

    const staffAuditLogRows = (await auditLogRows(h.pool, clientId)).filter(
      (row) => row.action === 'instance.resume',
    );
    expect(staffAuditLogRows).toHaveLength(1);
    expect(staffAuditLogRows[0]?.actor_type).toBe('staff');
    expect(staffAuditLogRows[0]?.actor_staff_id).toBe(opsId);
    expect(staffAuditLogRows[0]?.target_id).toBe(instanceId);

    expect(h.wakeCalls).toEqual([{ clientId, instanceId }]);
    expect(await notificationKinds(h.pool, clientId)).toEqual([
      'instance_paused_by_staff',
      'instance_resumed_by_staff',
    ]);
  });

  it('a_provider_restriction_pause_needs_an_explicit_acknowledgement_even_for_staff', async () => {
    const { clientId, instanceId } = await seedSendTenant(h.pool, h.probeClientIds, {});
    const opsId = await h.seedStaff('ops');
    const path = `/internal/v1/instances/${instanceId}/resume`;

    await forceInstanceState(h.pool, {
      clientId,
      instanceId,
      healthState: 'paused',
      pauseReason: 'provider_restriction',
    });

    // No acknowledgement -> 422, and the instance is STILL paused.
    const refused = await post(path, opsId, {
      clientId,
      reason: 'resuming after a provider restriction without acknowledging it',
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
    const stillPaused = await instanceHealth(h.pool, clientId, instanceId);
    expect(stillPaused.health_state).toBe('paused');
    expect(stillPaused.pause_reason).toBe('provider_restriction');
    expect(await notificationKinds(h.pool, clientId)).toEqual([]);

    // With an explicit acknowledgement, the same named staff human may
    // resume - the legitimate, audited recovery path.
    const acknowledged = await post(path, opsId, {
      clientId,
      reason: 'restriction reviewed with the customer; content corrected',
      acknowledgement: true,
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().data.resumed).toBe(true);
    expect((await instanceHealth(h.pool, clientId, instanceId)).health_state).toBe('degraded');
  });

  it('an_instance_belonging_to_another_client_is_a_404_not_a_cross_tenant_write', async () => {
    const victim = await seedSendTenant(h.pool, h.probeClientIds, {});
    const attacker = await seedSendTenant(h.pool, h.probeClientIds, {});
    const staffId = await h.seedStaff('ops');

    // A well-formed request naming the ATTACKER's client but the VICTIM's
    // instance - core invariant 4. 404, indistinguishable from "no such
    // instance", so staff cannot map instances to tenants by probing.
    const crossTenant = await post(`/internal/v1/instances/${victim.instanceId}/pause`, staffId, {
      clientId: attacker.clientId,
      reason: 'cross-tenant pause attempt that must not land',
    });
    expect(crossTenant.statusCode).toBe(404);
    expect((await instanceHealth(h.pool, victim.clientId, victim.instanceId)).health_state).toBe(
      'connected',
    );
    expect(await notificationKinds(h.pool, victim.clientId)).toEqual([]);
  });
});
