import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createBroadcast } from './lifecycle.service.js';
import { runExpansionToCompletion } from './expansion.worker.js';
import { createExpansionBudget } from './expansion-budget.js';
import { runEpochStrandingSweep } from './epoch-sweep.js';
import { restampBroadcast, RestampCountMismatchError } from './restamp.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  seedExpandingCampaign,
  type SeededBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { jobRows, queueCampaignJobs, tryClaim } from './__tests__/lifecycle-test-support.js';

/**
 * lifecycle-edge.integration.test.ts (P23 test-engineer hardening pass) -
 * edge cases NOT covered by lifecycle.integration.test.ts / lifecycle-pause-
 * resume.integration.test.ts / epoch-sweep.integration.test.ts:
 *   - POST /v1/broadcasts (createBroadcast) replayed with the same
 *     Idempotency-Key returns the SAME campaign id and writes exactly ONE
 *     campaign_counters row (never a second one on replay).
 *   - restampBroadcast replayed with the SAME idempotencyKey after the first
 *     call already succeeded - documents the current (gap) behaviour.
 *   - two workers racing to claim the SAME single queued job: exactly one
 *     wins, never both, never zero after a legitimate claim exists.
 *   - a slow (latency-injecting, never down) tenantDb wrapper must not
 *     change any claim/cancel outcome - no timing assertion, outcomes only.
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
    applicationName: 'broadcast-lifecycle-edge-test',
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

async function queued(count: number) {
  return queueCampaignJobs(pool, tenantDb, keyProvider, probeClientIds, count);
}

async function countCounterRows(campaignId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM campaign_counters WHERE campaign_id = $1`,
    [campaignId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('broadcast lifecycle edge cases', () => {
  it('create_broadcast_replayed_with_the_same_idempotency_key_returns_the_same_id_and_one_counters_row', async () => {
    const tenant: SeededBroadcastTenant = await seedBroadcastTenant(pool, probeClientIds);
    const actor = { kind: 'user' as const, userId: randomUUID() };
    const idempotencyKey = 'create-replay-key-1';
    const input = {
      clientId: tenant.clientId,
      actor,
      idempotencyKey,
      name: 'idempotent broadcast',
      instanceId: tenant.instanceId,
      audience: { kind: 'contacts', tagIds: [tenant.tagId], contactIds: [] },
      message: { kind: 'text', body: 'Hello!' },
      priority: 'low' as const,
      scheduledAt: null,
    };

    const first = await createBroadcast({ tenantDb, publishWake: () => {} }, input);
    const second = await createBroadcast({ tenantDb, publishWake: () => {} }, input);

    expect(second.id).toBe(first.id);
    expect(await countCounterRows(first.id)).toBe(1);

    const campaignRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaigns WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(campaignRows.rows[0]?.count).toBe('1');
  });

  it('create_broadcast_with_a_different_idempotency_key_creates_a_second_distinct_campaign', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const actor = { kind: 'user' as const, userId: randomUUID() };
    const baseInput = {
      clientId: tenant.clientId,
      actor,
      name: 'broadcast',
      instanceId: tenant.instanceId,
      audience: { kind: 'contacts', tagIds: [tenant.tagId], contactIds: [] },
      message: { kind: 'text', body: 'Hi!' },
      priority: 'low' as const,
      scheduledAt: null,
    };

    const first = await createBroadcast(
      { tenantDb, publishWake: () => {} },
      { ...baseInput, idempotencyKey: 'key-a' },
    );
    const second = await createBroadcast(
      { tenantDb, publishWake: () => {} },
      { ...baseInput, idempotencyKey: 'key-b' },
    );

    expect(second.id).not.toBe(first.id);
    const campaignRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaigns WHERE client_id = $1`,
      [tenant.clientId],
    );
    expect(campaignRows.rows[0]?.count).toBe('2');
  });

  it('restamp_replayed_with_the_same_idempotency_key_after_success_rejects_rather_than_silently_replaying', async () => {
    // Documents the CURRENT restamp.service.ts contract: `idempotencyKey` is
    // accepted but never consulted for dedupe. A genuine network-retry replay
    // (identical key, identical confirmCount) after the first call already
    // committed and cleared every stranded row therefore hits the live-count
    // mismatch path (0 stranded left) rather than replaying the original
    // success - never a silent double-restamp, but also never an idempotent
    // 200 on a legitimate retry.
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
    await pool.query(
      `UPDATE whatsapp_instances SET session_epoch = session_epoch + 1 WHERE id = $1`,
      [tenant.instanceId],
    );
    await runEpochStrandingSweep(
      { tenantDb },
      { clientId: tenant.clientId, instanceId: tenant.instanceId, currentEpoch: 1 },
    );

    const actor = { kind: 'user' as const, userId: randomUUID() };
    const sameKey = 'restamp-replay-key';

    const first = await restampBroadcast({ tenantDb }, actor, {
      clientId: tenant.clientId,
      campaignId,
      confirmCount: 10,
      idempotencyKey: sameKey,
    });
    expect(first.restamped).toBe(10);

    await expect(
      restampBroadcast({ tenantDb }, actor, {
        clientId: tenant.clientId,
        campaignId,
        confirmCount: 10,
        idempotencyKey: sameKey,
      }),
    ).rejects.toBeInstanceOf(RestampCountMismatchError);
  }, 30_000);

  it('two_workers_racing_to_claim_one_job_produce_exactly_one_winner', async () => {
    const { clientId, instanceId } = await queued(1);
    // The claim predicate INNER JOINs wallet_accounts (fail-closed) -
    // queueCampaignJobs never seeds one (snapshot/expansion never claim).
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [clientId],
    );

    const results = await Promise.all([
      tryClaim(tenantDb, clientId, instanceId),
      tryClaim(tenantDb, clientId, instanceId),
    ]);

    const winners = results.filter((claimed) => claimed === true);
    expect(winners).toHaveLength(1);
  });

  it('a_slow_tenant_db_wrapper_does_not_change_the_cancel_outcome', async () => {
    const { clientId, instanceId, campaignId } = await queued(20);

    const slowTenantDb: TenantDb = {
      async withTenant(cId, fn) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return tenantDb.withTenant(cId, fn);
      },
    };

    const { cancelBroadcast } = await import('./lifecycle.service.js');
    const { runCancelBookkeepingBatch } = await import('./cancel-bookkeeping.js');

    await cancelBroadcast(
      {
        tenantDb: slowTenantDb,
        publishWake: () => {},
        runBookkeeping: () => Promise.resolve({ recipientsStamped: 0, jobsStamped: 0, done: true }),
      },
      { kind: 'user', userId: randomUUID() },
      { clientId, id: campaignId },
    );

    expect(await tryClaim(slowTenantDb, clientId, instanceId)).toBe(false);
    await runCancelBookkeepingBatch(slowTenantDb, { clientId, campaignId });

    const rows = await jobRows(pool, clientId, campaignId);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('retry_storm_a_hundred_backpressure_holds_in_a_row_change_nothing', async () => {
    vi.useFakeTimers();
    try {
      const { runExpansionBatch } = await import('./expansion.worker.js');
      const { tenant, campaignId } = await seedExpandingCampaign(
        pool,
        tenantDb,
        keyProvider,
        probeClientIds,
        5,
      );

      const fillerIds: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        const row = await pool.query<{ id: string }>(
          `INSERT INTO message_jobs
             (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, payload,
              payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
           VALUES ($1, $2, 0, $3, '+15550000001', '{"text":"filler"}'::jsonb, 'text', 'low', 1,
                   'queued', now(), now())
           RETURNING id`,
          [tenant.clientId, tenant.instanceId, `filler-storm-${String(i)}@s.whatsapp.net`],
        );
        const id = row.rows[0]?.id;
        if (id) fillerIds.push(id);
      }

      for (let i = 0; i < 100; i += 1) {
        const held = await runExpansionBatch(
          { tenantDb, budget: unlimitedBudget(), holdQueueDepth: 20 },
          { campaignId, clientId: tenant.clientId },
        );
        expect(held).toEqual({ kind: 'held', reason: 'queue_depth', depth: 21 });
      }

      const campaignRow = await pool.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      expect(campaignRow.rows[0]?.status).toBe('expanding');
      const queuedRecipients = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued'`,
        [campaignId],
      );
      expect(queuedRecipients.rows[0]?.count).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
