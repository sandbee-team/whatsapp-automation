import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { metrics as defaultMetrics } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { seedWaGroup, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import {
  buildGroupSendTestKeyProvider,
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  linkInstance,
  runOneIteration,
} from './__tests__/send-test-helpers.js';

/**
 * forbidden-loop.integration.test.ts (P24 C1 FIX ROUND, Finding 2) - proves
 * the `group_forbidden` disable path fires through the REAL production send
 * loop (`runOneIteration` -> `runOneSendLoopIteration` -> `claimAndReserve`
 * -> `dispatch` -> `resolveFailure` -> `result-terminal.ts`'s hook), never
 * through a direct `resolveFailure` call. This is the gap Finding 1's fix
 * closed: `send-loop.ts` previously built its `resolveFailure` input without
 * `recipientJid`, so `result-terminal.ts`'s `isGroupJid` gate never fired in
 * production even though every existing forbidden test drove `resolveFailure`
 * directly and stayed green. Enqueues through the REAL `createMessage`
 * service (never a hand-inserted job row), same idiom as
 * `send.integration.test.ts`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-forbidden-loop-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // The guard pipeline's duplicate-fanout check writes these on every real
    // send loop pass - `cleanupSendProbeClients` predates this content-guard
    // traffic and does not know about them (same fix `send.integration.
    // test.ts`'s own afterEach already carries).
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Extracts the exact integer value of one `wp_group_sends_total{result="…"}` sample from raw Prometheus text - 0 if the series has never been observed yet. */
function groupSendsTotalFor(text: string, result: string): number {
  const match = new RegExp(`wp_group_sends_total\\{result="${result}"\\} (\\d+)`).exec(text);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

describe('P24 C1 fix - a group_forbidden result through the REAL wired send loop', () => {
  it('a_group_forbidden_through_the_real_send_loop_disables_that_group_only', async () => {
    const keyProvider = buildGroupSendTestKeyProvider();
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);

    const groupA = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const groupB = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });

    const instanceBefore = await pool.query<{ health_state: string; pause_reason: string | null }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );

    const metricsBefore = await defaultMetrics.metricsText();
    const forbiddenBefore = groupSendsTotalFor(metricsBefore, 'group_forbidden');

    const transport = createFakeTransport();
    transport.queueReject(0, 'group_forbidden');

    const enqueued = await enqueueVia(tenantDb, keyProvider, clientId, instanceId, groupA.groupJid);
    const claimed = await runOneIteration(tenantDb, pool, { clientId, instanceId, transport });
    expect(claimed).toBe(true);

    const jobId = await jobIdForPublicId(pool, clientId, enqueued.id);
    const jobRow = await pool.query<{ status: string; last_error_class: string | null }>(
      'SELECT status, last_error_class FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('failed');
    expect(jobRow.rows[0]?.last_error_class).toBe('group_forbidden');

    const groupARow = await pool.query<{
      send_enabled: boolean;
      disabled_reason: string | null;
      next_sync_after: Date | null;
    }>('SELECT send_enabled, disabled_reason, next_sync_after FROM wa_groups WHERE id = $1', [
      groupA.id,
    ]);
    expect(groupARow.rows[0]?.send_enabled).toBe(false);
    expect(groupARow.rows[0]?.disabled_reason).toBe('group_forbidden');
    expect(groupARow.rows[0]?.next_sync_after).not.toBeNull();

    // Group B (sibling, same instance) is byte-identical - only the ONE
    // targeted group was ever touched.
    const groupBRow = await pool.query<{ send_enabled: boolean; disabled_reason: string | null }>(
      'SELECT send_enabled, disabled_reason FROM wa_groups WHERE id = $1',
      [groupB.id],
    );
    expect(groupBRow.rows[0]?.send_enabled).toBe(true);
    expect(groupBRow.rows[0]?.disabled_reason).toBeNull();

    const auditRows = await pool.query<{ target_id: string }>(
      `SELECT target_id FROM audit_logs WHERE client_id = $1 AND action = 'group.send_disabled'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]?.target_id).toBe(groupA.id);

    const notificationRows = await pool.query<{ id: string }>(
      `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
      [clientId],
    );
    expect(notificationRows.rows).toHaveLength(1);

    const instanceAfter = await pool.query<{ health_state: string; pause_reason: string | null }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceAfter.rows[0]).toEqual(instanceBefore.rows[0]);

    const metricsAfter = await defaultMetrics.metricsText();
    const forbiddenAfter = groupSendsTotalFor(metricsAfter, 'group_forbidden');
    expect(forbiddenAfter - forbiddenBefore).toBe(1);
  });
});
