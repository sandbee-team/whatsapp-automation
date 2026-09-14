import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  makeStaffHeaders,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { attemptClaim } from './__tests__/internal-mutations-support.js';
import { notificationKinds } from './__tests__/internal-probe-support.js';
import {
  auditLogRows,
  cleanupU3bRows,
  staffAuditActions,
} from './__tests__/internal-u3b-support.js';
import {
  campaignRow,
  seedRunningCampaignForJobs,
} from './__tests__/internal-u3b-campaign-support.js';

/**
 * internal-mutations-campaigns.integration.test.ts (P28 Unit U3b, step 5) -
 * the staff campaign-cancel mutation. The load-bearing assertion is that the
 * cancel actually stops the NEXT CLAIM (through `claim-jobs.sql`'s own
 * campaign allow-list), not merely that a status column changed.
 */

const SECRET = 'internal-u3b-campaigns-test-secret-0123456789';
const CIDRS = '0.0.0.0/0';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

const staffHeaders = makeStaffHeaders(SECRET);

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-u3b-campaigns-tests',
  });
  tenantDb = createTenantDb(pool);
  app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: SECRET,
      allowedCidrs: CIDRS,
      publishWake: () => {},
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupU3bRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

async function seedStaff(role: 'support' | 'ops' | 'superadmin' = 'ops'): Promise<string> {
  const id = await seedStaffUser(pool, role);
  probeStaffIds.push(id);
  return id;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function postCancel(
  campaignId: string,
  staffId: string,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  const path = `/internal/v1/campaigns/${campaignId}/cancel`;
  return app.inject({
    method: 'POST',
    url: path,
    headers: staffHeaders('POST', path, staffId),
    payload: body,
  });
}

describe('internal-mutations-campaigns (P28 U3b)', () => {
  it('staff_campaign_cancel_stops_the_next_claim', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const staffId = await seedStaff('ops');

    const jobIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      jobIds.push((await seedQueuedJob(pool, { clientId, instanceId })).id);
    }
    const campaignId = await seedRunningCampaignForJobs(pool, { clientId, instanceId, jobIds });

    // A claim succeeds while the campaign is `running` - so the zero-claim
    // assertion after the cancel proves the CANCEL did it, not a fixture
    // that could never claim in the first place.
    expect(await attemptClaim(pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(1);

    const cancel = await postCancel(campaignId, staffId, {
      clientId,
      reason: 'campaign stopped at the customer request during a support call',
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.campaignId).toBe(campaignId);
    expect(cancel.json().data.status).toBe('cancelled');

    const campaign = await campaignRow(pool, clientId, campaignId);
    expect(campaign.status).toBe('cancelled');
    expect(campaign.cancel_reason).toBe('staff_cancelled');

    // THE enforcement point: the next claim for this campaign's jobs returns
    // zero rows, through `claim-jobs.sql`'s own campaign allow-list.
    expect(await attemptClaim(pool, { clientId, instanceId, band: 3, fence: 1 })).toBe(0);

    const cancelAudit = (await auditLogRows(pool, clientId)).filter(
      (row) => row.action === 'broadcast.cancel',
    );
    expect(cancelAudit).toHaveLength(1);
    expect(cancelAudit[0]?.actor_type).toBe('staff');
    expect(cancelAudit[0]?.actor_staff_id).toBe(staffId);

    expect((await staffAuditActions(pool, clientId)).map((row) => row.action)).toEqual([
      'campaigns.cancel',
    ]);
    expect(await notificationKinds(pool, clientId)).toEqual(['campaign_cancelled_by_staff']);
  });

  it('cancelling_an_already_cancelled_campaign_is_a_409_and_a_cross_tenant_id_is_a_404', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const other = await seedSendTenant(pool, probeClientIds, {});
    const staffId = await seedStaff('ops');
    const campaignId = await seedRunningCampaignForJobs(pool, {
      clientId,
      instanceId,
      jobIds: [],
    });

    const first = await postCancel(campaignId, staffId, {
      clientId,
      reason: 'first cancel, which must succeed',
    });
    expect(first.statusCode).toBe(200);

    // A second cancel is an ILLEGAL TRANSITION (already terminal), not a
    // silent success - the campaign is already stopped either way.
    const second = await postCancel(campaignId, staffId, {
      clientId,
      reason: 'second cancel on an already-cancelled campaign',
    });
    expect(second.statusCode).toBe(409);
    expect(await staffAuditActions(pool, clientId)).toHaveLength(1);

    // A well-formed request naming ANOTHER client's id for this campaign is
    // a 404, indistinguishable from "no such campaign" (core invariant 4).
    const crossTenant = await postCancel(campaignId, staffId, {
      clientId: other.clientId,
      reason: 'cross-tenant cancel attempt that must not land',
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(await staffAuditActions(pool, other.clientId)).toEqual([]);
    expect(await notificationKinds(pool, other.clientId)).toEqual([]);
  });

  it('a_support_role_may_not_cancel_a_campaign', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    const supportId = await seedStaff('support');
    const campaignId = await seedRunningCampaignForJobs(pool, {
      clientId,
      instanceId,
      jobIds: [],
    });

    const refused = await postCancel(campaignId, supportId, {
      clientId,
      reason: 'support attempting a cancel outside its role',
    });
    expect(refused.statusCode).toBe(403);

    expect((await campaignRow(pool, clientId, campaignId)).status).toBe('running');
    expect(await staffAuditActions(pool, clientId)).toEqual([]);
    expect(await notificationKinds(pool, clientId)).toEqual([]);
  });
});
