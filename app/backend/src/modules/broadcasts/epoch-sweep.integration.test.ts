import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedExpandingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runEpochStrandingSweep, countStrandedEpochJobs } from './epoch-sweep.js';
import { restampBroadcast, RestampCountMismatchError } from './restamp.service.js';
import { BroadcastActorForbiddenError } from './broadcasts.errors.js';

/**
 * epoch-sweep.integration.test.ts (P23 Unit U6, step 7) - proves the
 * epoch-stranding sweep and the human-confirmed restamp, exactly as the
 * canon's three named tests: `epoch_bump_leaves_no_silently_unclaimable_job`,
 * `restamping_requires_a_human_actor_and_a_matching_number`, and
 * `the_periodic_reconciliation_sweep_catches_a_missed_hook`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];
const unlimitedBudget = () =>
  createExpansionBudget({
    ratePerSecond: 1_000_000,
    burst: 1_000_000,
    clock: { now: () => Date.now() },
  });

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-epoch-sweep-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedPlainQueuedJobs(
  clientId: string,
  instanceId: string,
  count: number,
  sessionEpoch: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status)
       VALUES ($1, $2, $3, $4, $5, '{"text":"hi"}'::jsonb, 'text', 'low', 30, 'queued')`,
      [
        clientId,
        instanceId,
        sessionEpoch,
        `plain-${String(i)}@s.whatsapp.net`,
        `+19995550${String(i).padStart(3, '0')}`,
      ],
    );
  }
}

async function countQueuedForInstance(clientId: string, instanceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message_jobs
      WHERE client_id = $1 AND instance_id = $2 AND status = 'queued'`,
    [clientId, instanceId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countBlockedForInstance(clientId: string, instanceId: string): Promise<number> {
  const result = await pool.query<{ count: string; needs_action: string }>(
    `SELECT count(*)::text AS count, count(*) FILTER (WHERE needs_user_action)::text AS needs_action
       FROM message_jobs
      WHERE client_id = $1 AND instance_id = $2 AND status = 'blocked_needs_review'
        AND unresolved_reason = 'session_epoch_advanced'`,
    [clientId, instanceId],
  );
  const row = result.rows[0];
  expect(Number(row?.needs_action ?? 0)).toBe(Number(row?.count ?? 0));
  return Number(row?.count ?? 0);
}

describe('epoch stranding sweep + restamp (P23 Unit U6, step 7)', () => {
  it('epoch_bump_leaves_no_silently_unclaimable_job', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      300,
    );
    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );

    await seedPlainQueuedJobs(tenant.clientId, tenant.instanceId, 20, 0);

    const second = await seedExpandingCampaign(pool, tenantDb, keyProvider, [], 0);
    probeClientIds.push(second.tenant.clientId);
    await seedPlainQueuedJobs(second.tenant.clientId, second.tenant.instanceId, 30, 0);

    expect(await countQueuedForInstance(tenant.clientId, tenant.instanceId)).toBe(320);

    await pool.query(
      `UPDATE whatsapp_instances SET session_epoch = session_epoch + 1 WHERE id = $1`,
      [tenant.instanceId],
    );

    const result = await runEpochStrandingSweep(
      { tenantDb },
      { clientId: tenant.clientId, instanceId: tenant.instanceId, currentEpoch: 1 },
    );

    expect(result.moved).toBe(320);
    expect(await countQueuedForInstance(tenant.clientId, tenant.instanceId)).toBe(0);
    expect(await countBlockedForInstance(tenant.clientId, tenant.instanceId)).toBe(320);

    // The second instance's jobs are byte-identical (untouched).
    expect(await countQueuedForInstance(second.tenant.clientId, second.tenant.instanceId)).toBe(30);

    // 0 rows deleted anywhere.
    const totalRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = ANY($1)`,
      [[tenant.clientId, second.tenant.clientId]],
    );
    expect(Number(totalRows.rows[0]?.count ?? 0)).toBe(350);

    // The gauge recount reflects the moved rows for at least this instance.
    const gaugeCount = await countStrandedEpochJobs(pool);
    expect(gaugeCount).toBeGreaterThanOrEqual(320);

    // A claim on instance 1 (still at epoch 0 in claim-jobs.sql terms)
    // returns nothing silently claimable - every previously-queued row is
    // now blocked_needs_review, never queued.
    expect(await countQueuedForInstance(tenant.clientId, tenant.instanceId)).toBe(0);

    // Idempotent: a second run moves 0.
    const rerun = await runEpochStrandingSweep(
      { tenantDb },
      { clientId: tenant.clientId, instanceId: tenant.instanceId, currentEpoch: 1 },
    );
    expect(rerun.moved).toBe(0);
  }, 30_000);

  it('restamping_requires_a_human_actor_and_a_matching_number', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      50,
    );
    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );

    await pool.query(
      `UPDATE whatsapp_instances SET session_epoch = session_epoch + 1 WHERE id = $1`,
      [tenant.instanceId],
    );
    await runEpochStrandingSweep(
      { tenantDb },
      { clientId: tenant.clientId, instanceId: tenant.instanceId, currentEpoch: 1 },
    );
    expect(await countBlockedForInstance(tenant.clientId, tenant.instanceId)).toBe(50);

    const publishWakeForClient = vi.fn(async () => undefined);

    await expect(
      restampBroadcast(
        { tenantDb, publishWakeForClient },
        { kind: 'api_key' },
        { clientId: tenant.clientId, campaignId, confirmCount: 50, idempotencyKey: 'k1' },
      ),
    ).rejects.toBeInstanceOf(BroadcastActorForbiddenError);
    expect(await countBlockedForInstance(tenant.clientId, tenant.instanceId)).toBe(50);
    expect(publishWakeForClient).not.toHaveBeenCalled();

    await expect(
      restampBroadcast(
        { tenantDb, publishWakeForClient },
        { kind: 'user', userId: '64df4f08-6e93-48a5-9320-43c7fb42bc23' },
        { clientId: tenant.clientId, campaignId, confirmCount: 49, idempotencyKey: 'k2' },
      ),
    ).rejects.toBeInstanceOf(RestampCountMismatchError);
    expect(await countBlockedForInstance(tenant.clientId, tenant.instanceId)).toBe(50);
    expect(publishWakeForClient).not.toHaveBeenCalled();

    const result = await restampBroadcast(
      { tenantDb, publishWakeForClient },
      { kind: 'user', userId: '64df4f08-6e93-48a5-9320-43c7fb42bc23' },
      { clientId: tenant.clientId, campaignId, confirmCount: 50, idempotencyKey: 'k3' },
    );

    expect(result.restamped).toBe(50);
    expect(result.sessionEpoch).toBe(1);
    expect(await countBlockedForInstance(tenant.clientId, tenant.instanceId)).toBe(0);
    expect(await countQueuedForInstance(tenant.clientId, tenant.instanceId)).toBe(50);
    expect(publishWakeForClient).toHaveBeenCalledTimes(1);

    const auditRow = await pool.query<{
      actor_user_id: string;
      metadata: { count: number };
      target_type: string;
      target_id: string;
    }>(
      `SELECT actor_user_id, metadata, target_type, target_id FROM audit_logs
          WHERE client_id = $1 AND action = 'message.broadcast_restamped'`,
      [tenant.clientId],
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0]?.actor_user_id).toBe('64df4f08-6e93-48a5-9320-43c7fb42bc23');
    expect(auditRow.rows[0]?.metadata).toEqual({ count: 50 });
    // The restamp is instance-scoped (every stranded job of that NUMBER), so
    // the audit row targets the instance, not the campaign (C1 re-review).
    expect(auditRow.rows[0]?.target_type).toBe('whatsapp_instances');
    expect(auditRow.rows[0]?.target_id).toBe(tenant.instanceId);
  }, 30_000);

  it('the_periodic_reconciliation_sweep_catches_a_missed_hook', async () => {
    const { tenant, campaignId } = await seedExpandingCampaign(
      pool,
      tenantDb,
      keyProvider,
      probeClientIds,
      10,
    );
    await runExpansionToCompletion(
      { tenantDb, budget: unlimitedBudget() },
      { campaignId, clientId: tenant.clientId },
    );

    // Bump the epoch WITHOUT calling the hook - simulating a missed
    // post-commit callback (e.g. a crash between commit and the hook).
    await pool.query(
      `UPDATE whatsapp_instances SET session_epoch = session_epoch + 1 WHERE id = $1`,
      [tenant.instanceId],
    );
    expect(await countQueuedForInstance(tenant.clientId, tenant.instanceId)).toBe(10);

    // The periodic reconciliation sweep (belt and braces) runs the SAME
    // sweep function directly against the instance's current epoch.
    const instanceRow = await pool.query<{ session_epoch: number }>(
      `SELECT session_epoch FROM whatsapp_instances WHERE id = $1`,
      [tenant.instanceId],
    );
    const currentEpoch = instanceRow.rows[0]!.session_epoch;

    const result = await runEpochStrandingSweep(
      { tenantDb },
      { clientId: tenant.clientId, instanceId: tenant.instanceId, currentEpoch },
    );

    expect(result.moved).toBe(10);
    expect(await countQueuedForInstance(tenant.clientId, tenant.instanceId)).toBe(0);
    expect(await countBlockedForInstance(tenant.clientId, tenant.instanceId)).toBe(10);
  }, 30_000);
});
