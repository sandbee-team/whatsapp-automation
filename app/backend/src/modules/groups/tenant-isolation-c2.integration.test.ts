import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { TransportSendError } from '../../provider/provider.types.js';
import {
  resolveFailure,
  type ResolveFailureInput,
  type ResultDeps,
} from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { seedWaGroup, readWaGroupState, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import { seedGroupDispatchedAttempt } from './__tests__/forbidden-test-helpers.js';
import type { GroupSocketPort } from './sync.js';
import { createSessionRegistry, type RunnerHandle } from '../../engine/session/registry.js';
import { buildGroupsSyncTimer } from '../../engine/session/session-groups-sync-timer.js';

/**
 * tenant-isolation-c2.integration.test.ts (P24 C2 test-engineer) - two-
 * tenant interference on every new P24 background path: two tenants'
 * instances on the SAME worker tick (one tenant's sync failure never
 * touches the other tenant's rows), and a `group_forbidden` disable never
 * crosses tenants even when the SAME group jid string exists under two
 * different (client_id, instance_id) scopes.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-tenant-isolation-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  // cleanupSendProbeClients FIRST - it clears send_attempts/message_jobs/
  // instance_lease_state before deleting whatsapp_instances/clients;
  // cleanupPacingProbeClients deletes whatsapp_instances more simply and
  // would otherwise trip the instance_lease_state FK left behind by a
  // seedSendTenant fixture in the SAME probeClientIds batch.
  await cleanupSendProbeClients(pool, probeClientIds);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function buildFakeHandle(
  clientId: string,
  instanceId: string,
  groupSocket: GroupSocketPort,
): RunnerHandle {
  return {
    instanceId,
    clientId,
    end: () => undefined,
    teardownNoRelease: async () => undefined,
    teardownWithRelease: async () => undefined,
    getGroupSocket: () => groupSocket,
  };
}

describe('two tenants on the same worker tick - one tenant sync failure never touches the other', () => {
  it('tenant_a_sync_failure_never_touches_tenant_b_rows_in_the_same_tick', async () => {
    const tenantA = await seedPacingInstance(pool, probeClientIds, {});
    const tenantB = await seedPacingInstance(pool, probeClientIds, {});
    await pool.query(
      `UPDATE whatsapp_instances SET groups_sync_requested_at = now() WHERE id = ANY($1)`,
      [[tenantA.instanceId, tenantB.instanceId]],
    );

    const groupJid = '120363990000000001@g.us';
    const throwingSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => {
        throw new Error('tenant A provider failure');
      },
      groupLeave: async () => undefined,
      selfJid: () => undefined,
    };
    let bWriteCount = 0;
    const workingSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => {
        bWriteCount += 1;
        return { [groupJid]: { id: groupJid, participants: [{ id: 'x@s.whatsapp.net' }] } };
      },
      groupLeave: async () => undefined,
      selfJid: () => undefined,
    };

    const registry = createSessionRegistry();
    registry.set(
      tenantA.instanceId,
      buildFakeHandle(tenantA.clientId, tenantA.instanceId, throwingSocket),
    );
    registry.set(
      tenantB.instanceId,
      buildFakeHandle(tenantB.clientId, tenantB.instanceId, workingSocket),
    );

    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: () => undefined, info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await timer.runOnce();
    } finally {
      timer.stop();
    }

    expect(bWriteCount).toBe(1);
    const bRows = await pool.query(
      `SELECT 1 FROM wa_groups WHERE client_id = $1 AND instance_id = $2 AND group_jid = $3`,
      [tenantB.clientId, tenantB.instanceId, groupJid],
    );
    expect(bRows.rows).toHaveLength(1);

    const aRows = await pool.query(
      `SELECT 1 FROM wa_groups WHERE client_id = $1 AND instance_id = $2`,
      [tenantA.clientId, tenantA.instanceId],
    );
    expect(aRows.rows).toHaveLength(0);
  });
});

describe('the same group jid under two different tenants - forbidden disable never crosses', () => {
  it('a_forbidden_result_for_tenant_as_group_never_disables_tenant_bs_group_of_the_identical_jid', async () => {
    const sameGroupJid = '120363990000000002@g.us';
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);

    const groupA = await seedWaGroup(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      groupJid: sameGroupJid,
      sendEnabled: true,
    });
    const groupB = await seedWaGroup(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      groupJid: sameGroupJid,
      sendEnabled: true,
    });

    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      groupJid: sameGroupJid,
    });

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const failureInput: ResolveFailureInput = {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      attempts: 1,
      maxAttempts: 5,
      error: new TransportSendError('group_forbidden', 'not-admin'),
      recipientJid: sameGroupJid,
    };
    await resolveFailure(failureInput, deps);

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('failed');

    const stateA = await readWaGroupState(pool, groupA.id);
    expect(stateA?.send_enabled).toBe(false);
    expect(stateA?.disabled_reason).toBe('group_forbidden');

    // Tenant B's identically-jidded group is byte-identical and untouched -
    // the disable predicate is scoped by (client_id, instance_id, group_jid),
    // never group_jid alone.
    const stateB = await readWaGroupState(pool, groupB.id);
    expect(stateB?.send_enabled).toBe(true);
    expect(stateB?.disabled_reason).toBeNull();

    const auditRowsB = await pool.query(
      `SELECT 1 FROM audit_logs WHERE client_id = $1 AND target_id = $2`,
      [tenantB.clientId, groupB.id],
    );
    expect(auditRowsB.rows).toHaveLength(0);
  });
});
