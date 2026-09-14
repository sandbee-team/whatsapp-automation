import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, tenantKey, sysKey } from '../../platform/redis.js';
import { bindQueueMetrics, type QueueMetricsHandles } from '../../engine/queue/metrics.js';
import { bindWalletMetrics } from '../../platform/metrics/wallet-metrics.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneReaperSweep, type ReaperDeps } from './reaper.js';
import { runOneWalletReconcileSweep } from '../wallet/reconcile.js';
import { createChargerWorker } from '../wallet/charger.worker.js';
import { createWalletRepairedSendSink } from '../wallet/wallet-sink.js';
import type { Redis } from 'ioredis';

/**
 * reaper-charge.integration.test.ts (P18 Unit U5) - proves a claim-lost
 * repaired send is charged EXACTLY ONCE end-to-end (reaper -> real wallet
 * sink -> Redis work item -> charger drain), real Postgres + real Redis. The
 * dropped-work-item case proves the reconciler's check B is a correct
 * backstop when the charger queue never sees the item at all. A third test
 * proves the charger never throws on a broken Redis and bounds its own
 * queue length.
 *
 * Cleanup never `FLUSHALL`s Redis (shared dev instance) - only this test's
 * own client's list/index-set membership is removed in `afterEach`.
 */

const ENV = 'test';

let pool: TestPool;
let tenantDb: TenantDb;
let redis: Redis;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reaper-charge-test',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

afterEach(async () => {
  for (const clientId of probeClientIds) {
    await redis.del(tenantKey(ENV, clientId, 'charge'));
    await redis.srem(sysKey(ENV, 'sys', 'wallet', 'charge-pending'), clientId);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Sets a job's lease to already-expired (past the 30s grace) via a raw UPDATE - no sleeps. */
async function expireLease(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE message_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [jobId],
  );
}

function makeReaperDeps(overrides: Partial<ReaperDeps> = {}): ReaperDeps {
  const metrics: QueueMetricsHandles = bindQueueMetrics(createMetricsRegistry());
  return {
    pool,
    tenantDb,
    metrics,
    sink: createWalletRepairedSendSink({ tenantDb }),
    graceSeconds: 30,
    limit: 500,
    rng: { random: () => 0 },
    ...overrides,
  };
}

describe('a repaired send is charged exactly once (real Postgres + real Redis)', () => {
  it('claim_lost_then_repaired_send_is_charged_exactly_once', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, $4, 1, 'acked', now(), now(), now()
         FROM message_jobs j WHERE j.id = $3
       RETURNING id`,
      [clientId, instanceId, job.id, job.leaseId],
    );
    const sendAttemptId = attempt.rows[0]?.id;
    if (!sendAttemptId) throw new Error('seed: no send_attempts row returned');
    await expireLease(job.id);

    const walletMetricsRegistry = createMetricsRegistry();
    const walletMetrics = bindWalletMetrics(walletMetricsRegistry);
    const incDebitSpy = vi.spyOn(walletMetrics, 'incDebit');

    const charger = createChargerWorker({ redis, env: ENV, tenantDb, metrics: walletMetrics });
    const sink = createWalletRepairedSendSink({
      tenantDb,
      enqueueCharge: (item) => charger.enqueue(item),
      metrics: walletMetrics,
    });

    await runOneReaperSweep(makeReaperDeps({ sink }));

    const jobAfter = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobAfter.rows[0]?.status).toBe('sent');

    const listLength = await redis.llen(tenantKey(ENV, clientId, 'charge'));
    expect(listLength).toBe(1);

    const firstDrain = await charger.drainOnce();
    expect(firstDrain.charged).toBe(1);
    expect(firstDrain.noop).toBe(0);

    // Second/third attempts to charge the SAME attempt id must be a
    // correct no-op - the guard is the true idempotency boundary. Re-enqueue
    // the same attempt id directly to drive a second drainOnce() through the
    // charger itself (the first drain already popped the original item off
    // the list and the client id off the index set).
    await charger.enqueue({ clientId, attemptId: sendAttemptId });
    const secondDrain = await charger.drainOnce();
    expect(secondDrain.charged).toBe(0);
    expect(secondDrain.noop).toBe(1);

    // A third, direct call to chargeRepairedSend (bypassing the queue
    // entirely) must also be a correct no-op.
    const { chargeRepairedSend } = await import('../wallet/charge.js');
    const thirdCall = await chargeRepairedSend(
      tenantDb,
      { clientId, attemptId: sendAttemptId },
      { metrics: walletMetrics },
    );
    expect(thirdCall.seq).toBeNull();

    const guardRows = await pool.query<{ kind: string }>(
      'SELECT kind FROM wallet_charge_guards WHERE send_attempt_id = $1 AND client_id = $2',
      [sendAttemptId, clientId],
    );
    expect(guardRows.rows).toHaveLength(1);
    expect(guardRows.rows[0]?.kind).toBe('debit_send');

    const ledgerRows = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor FROM wallet_ledger WHERE send_attempt_id = $1 AND client_id = $2',
      [sendAttemptId, clientId],
    );
    expect(ledgerRows.rows).toHaveLength(1);
    expect(ledgerRows.rows[0]?.amount_minor).toBe('-15');

    const account = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(account.rows[0]?.balance_minor).toBe('99985');

    expect(incDebitSpy).toHaveBeenCalledTimes(1);
  });

  it('a_repaired_send_is_still_charged_when_the_work_item_is_dropped', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, $4, 1, 'acked', now(), now(), now()
         FROM message_jobs j WHERE j.id = $3`,
      [clientId, instanceId, job.id, job.leaseId],
    );
    await expireLease(job.id);

    // The sink's enqueueCharge resolves without writing anything - models a
    // dropped work item (e.g. a Redis blip between the reaper and the
    // charger). Never touch shared Redis for this test.
    const sink = createWalletRepairedSendSink({
      tenantDb,
      enqueueCharge: async () => undefined,
    });

    await runOneReaperSweep(makeReaperDeps({ sink }));

    const listLength = await redis.llen(tenantKey(ENV, clientId, 'charge'));
    expect(listLength).toBe(0);

    const guardsBeforeReconcile = await pool.query(
      'SELECT 1 FROM wallet_charge_guards WHERE client_id = $1',
      [clientId],
    );
    expect(guardsBeforeReconcile.rows).toHaveLength(0);

    // The attempt's resolved_at must be inside check B's evidence window -
    // set it 30 minutes in the past (default windowMs=25h, graceMs=10min).
    await pool.query(
      `UPDATE send_attempts SET resolved_at = now() - interval '30 minutes'
        WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, job.id],
    );

    const walletMetrics = bindWalletMetrics(createMetricsRegistry());
    const reconcileOutcome = await runOneWalletReconcileSweep({
      pool,
      tenantDb,
      metrics: walletMetrics,
      graceMs: 0,
    });
    expect(reconcileOutcome.findings.missing_debits).toBeGreaterThanOrEqual(1);

    const guardRows = await pool.query<{ kind: string }>(
      'SELECT kind FROM wallet_charge_guards WHERE client_id = $1',
      [clientId],
    );
    expect(guardRows.rows).toHaveLength(1);
    expect(guardRows.rows[0]?.kind).toBe('debit_send');

    const ledgerRows = await pool.query('SELECT 1 FROM wallet_ledger WHERE client_id = $1', [
      clientId,
    ]);
    expect(ledgerRows.rows).toHaveLength(1);

    const findingRows = await pool.query<{ kind: string }>(
      'SELECT kind FROM wallet_reconcile_findings WHERE client_id = $1',
      [clientId],
    );
    expect(findingRows.rows.some((r) => r.kind === 'missing_debit_repaired')).toBe(true);

    const accountBefore = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(accountBefore.rows[0]?.balance_minor).toBe('99985');

    // Second sweep: nothing new on money - exact balance unchanged.
    await runOneWalletReconcileSweep({ pool, tenantDb, metrics: walletMetrics, graceMs: 0 });
    const accountAfter = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(accountAfter.rows[0]?.balance_minor).toBe('99985');
  });

  it('the_charger_bounds_its_queue_and_never_throws_on_a_broken_redis', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const charger = createChargerWorker({ redis, env: ENV, tenantDb, maxQueueLength: 1000 });

    for (let i = 0; i < 1005; i += 1) {
      await charger.enqueue({ clientId, attemptId: `attempt-${String(i)}` });
    }
    const length = await redis.llen(tenantKey(ENV, clientId, 'charge'));
    expect(length).toBe(1000);

    const warn = vi.fn();
    const brokenRedis = {
      lpush: vi.fn().mockRejectedValue(new Error('connection reset')),
      ltrim: vi.fn(),
      sadd: vi.fn(),
      spop: vi.fn(),
      rpop: vi.fn(),
    };
    const brokenCharger = createChargerWorker({
      redis: brokenRedis,
      env: ENV,
      tenantDb,
      logger: { warn },
    });

    await expect(
      brokenCharger.enqueue({ clientId, attemptId: 'attempt-broken' }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const [meta] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta).toEqual({ client_id: clientId, send_attempt_id: 'attempt-broken' });
  });
});
