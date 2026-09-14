import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from '../queue/queue.repo.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type SeedSendTenantOptions,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';

/**
 * wallet-gate.integration.test.ts (P19 Unit U3) - real Postgres proofs that
 * the wallet stop baked into `db/queries/claim-jobs.sql` (`w.state NOT IN
 * ('empty','frozen') AND w.balance_minor >= w.max_rate_minor`) is a
 * claim-level gate: it blocks every instance under a client, it never
 * touches `whatsapp_instances.health_state`/`pause_reason` or writes a
 * `hard_signal_pause` evidence row (ADR 0019 S4 - the wallet stop is
 * orthogonal to health, never a `paused` reuse - see this file's own
 * `wallet_stop_never_writes_health_state` case), it never loses/fails a
 * queued job, and it is scoped per-client (tenant isolation). This file does
 * NOT edit `db/queries/claim-jobs.sql` - it only proves the two predicates
 * already there (P03) work as specified.
 *
 * `the_wallet_predicates_exist_only_in_claim_jobs_sql` (a pure source scan,
 * no DB needed) lives in the sibling `wallet-gate-source-scan.integration.
 * test.ts` - split at the max-lines cap (300), same idiom as
 * `session-worker-discovery-wiring.ts`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const DEFAULT_BAND = 3; // matches seedQueuedJob's default priority_rank

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-gate-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

interface JobSnapshotRow {
  id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
}

async function snapshotJobs(clientId: string): Promise<JobSnapshotRow[]> {
  const result = await pool.query<JobSnapshotRow>(
    `SELECT id, status, attempts, next_attempt_at
       FROM message_jobs
      WHERE client_id = $1
      ORDER BY id`,
    [clientId],
  );
  return result.rows;
}

/** Seeds one extra whatsapp_instance + instance_lease_state under an already-seeded client, same shape as seedSendTenant's own instance insert. */
async function seedExtraInstance(
  clientId: string,
  options: { healthState?: string; fence?: number } = {},
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'send-probe-extra', $3, 0)`,
    [instanceId, clientId, options.healthState ?? 'connected'],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, clientId, options.fence ?? 1],
  );
  return instanceId;
}

async function seedTenantWithWallet(options: SeedSendTenantOptions = {}) {
  return seedSendTenant(pool, probeClientIds, options);
}

/** Thin wrapper over claimOne with this file's shared worker/expiry defaults - cuts repeated call-site boilerplate. */
async function claimAsGateProbe(
  clientId: string,
  instanceId: string,
  workerId = 'wallet-gate-worker',
) {
  return claimOne(
    { clientId, sql: pool },
    { instanceId, band: DEFAULT_BAND, fence: 1, workerId, claimExpiryMs: 30_000 },
  );
}

describe('wallet stop is a claim-level gate (ADR 0019 S4)', () => {
  it('wallet_empty_stops_claims_and_preserves_every_queued_job', async () => {
    const { clientId, instanceId: instance1 } = await seedTenantWithWallet({
      walletState: 'empty',
    });
    const instance2 = await seedExtraInstance(clientId);
    const instance3 = await seedExtraInstance(clientId);
    const instances = [instance1, instance2, instance3];

    // 200 jobs total, split as evenly as an integer division allows across 3
    // instances (67 + 67 + 66) - a plain `200 / instances.length` non-integer
    // loop bound would silently round UP per instance and over-seed.
    const baseCount = Math.floor(200 / instances.length);
    const jobCounts = instances.map((_, index) =>
      index < 200 % instances.length ? baseCount + 1 : baseCount,
    );
    for (const [index, instanceId] of instances.entries()) {
      // `jobCounts[index] ?? 0` rather than a bare index read: `jobCounts` is
      // built by mapping over `instances`, so the entry always exists, but
      // `noUncheckedIndexedAccess` types it `number | undefined` and a bare
      // read is a compile error (TS2532).
      const count = jobCounts[index] ?? 0;
      for (let i = 0; i < count; i++) {
        await seedQueuedJob(pool, { clientId, instanceId });
      }
    }

    const before = await snapshotJobs(clientId);
    expect(before).toHaveLength(200);
    expect(before.every((job) => job.status === 'queued' && job.attempts === 0)).toBe(true);

    for (const instanceId of instances) {
      const claimed = await claimAsGateProbe(clientId, instanceId);
      expect(claimed, `instanceId=${instanceId}`).toBeUndefined();
    }

    const after = await snapshotJobs(clientId);
    expect(after).toEqual(before);
    expect(after.filter((job) => job.status === 'failed')).toHaveLength(0);
    expect(after).toHaveLength(200);
  });

  it('wallet_stop_never_writes_health_state', async () => {
    const { clientId, instanceId } = await seedTenantWithWallet({ walletState: 'active' });
    for (let i = 0; i < 5; i++) {
      await seedQueuedJob(pool, { clientId, instanceId });
    }

    async function snapshotInstance() {
      const result = await pool.query<{
        health_state: string;
        pause_reason: string | null;
      }>('SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1', [instanceId]);
      const row = result.rows[0];
      if (!row) throw new Error('instance row missing');
      return row;
    }

    async function snapshotHealthScore() {
      const result = await pool.query<{ health_score: string }>(
        'SELECT health_score::text AS health_score FROM instance_pacing_state WHERE instance_id = $1',
        [instanceId],
      );
      return result.rows[0]?.health_score ?? null;
    }

    const beforeInstance = await snapshotInstance();
    const beforeHealthScore = await snapshotHealthScore();

    // Drain the wallet to empty mid-flight, exactly as a real balance
    // exhaustion under a continuous send stream would.
    for (let i = 0; i < 5; i++) {
      const claimed = await claimAsGateProbe(clientId, instanceId, 'drain-worker');
      expect(claimed, `claim ${i}`).toBeDefined();
    }
    await pool.query("UPDATE wallet_accounts SET state = 'empty' WHERE client_id = $1", [clientId]);

    const claimedAfterEmpty = await claimAsGateProbe(clientId, instanceId, 'drain-worker');
    expect(claimedAfterEmpty).toBeUndefined();

    const afterInstance = await snapshotInstance();
    const afterHealthScore = await snapshotHealthScore();

    expect(afterInstance).toEqual(beforeInstance);
    expect(afterInstance.health_state).toBe('connected');
    expect(afterInstance.pause_reason).toBeNull();
    expect(afterHealthScore).toBe(beforeHealthScore);

    const hardSignalEvidence = await pool.query(
      "SELECT id FROM pacing_events WHERE client_id = $1 AND kind = 'hard_signal_pause'",
      [clientId],
    );
    expect(hardSignalEvidence.rows).toHaveLength(0);
  });

  it('balance_below_max_rate_stops_claims_even_though_it_is_positive', async () => {
    const { clientId, instanceId } = await seedTenantWithWallet({
      walletState: 'active',
      maxRateMinor: 100,
      balanceMinor: 99, // max_rate_minor - 1: positive, but strictly below the gate
    });
    const jobId = (await seedQueuedJob(pool, { clientId, instanceId })).id;

    const claimed = await claimAsGateProbe(clientId, instanceId);

    expect(claimed).toBeUndefined();
    const job = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(job.rows[0]?.status).toBe('queued');

    // The gate is `>=`, not `>` - a balance exactly AT max_rate_minor must claim.
    await pool.query('UPDATE wallet_accounts SET balance_minor = 100 WHERE client_id = $1', [
      clientId,
    ]);
    const claimedAtThreshold = await claimAsGateProbe(clientId, instanceId);
    expect(claimedAtThreshold?.id).toBe(jobId);
  });

  it('client_with_unmaterialised_pricing_cannot_claim', async () => {
    // A wallet row with max_rate_minor <= 0 cannot exist: mj_wallet_max_rate
    // is enforced by wallet_accounts' own CHECK (max_rate_minor > 0) - the
    // "unmaterialised pricing" state this case names is not a reachable
    // runtime row, it is a boot-time assertion: planting one is rejected at
    // the INSERT itself, not silently coerced or defaulted.
    const clientId = randomUUID();
    probeClientIds.push(clientId);
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, 'Unpriced Probe Client', `unpriced-probe-${clientId}`, 'active'],
    );

    await expect(
      pool.query(
        'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1, $2, $3, $4)',
        [clientId, 100_000, 'active', 0],
      ),
    ).rejects.toThrow(/max_rate_minor/);

    const walletRow = await pool.query('SELECT 1 FROM wallet_accounts WHERE client_id = $1', [
      clientId,
    ]);
    expect(walletRow.rows).toHaveLength(0);
  });

  it('a_frozen_wallet_with_a_large_balance_yields_zero_claims', async () => {
    const { clientId, instanceId } = await seedTenantWithWallet({
      walletState: 'frozen',
      balanceMinor: 100_000_000,
      maxRateMinor: 1,
    });
    const jobId = (await seedQueuedJob(pool, { clientId, instanceId })).id;

    const claimed = await claimAsGateProbe(clientId, instanceId);

    expect(claimed).toBeUndefined();
    const job = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(job.rows[0]?.status).toBe('queued');
  });

  it('another_clients_empty_wallet_does_not_stop_this_client', async () => {
    const emptied = await seedTenantWithWallet({ walletState: 'empty' });
    const healthy = await seedTenantWithWallet({ walletState: 'active' });

    const emptiedJobId = (
      await seedQueuedJob(pool, { clientId: emptied.clientId, instanceId: emptied.instanceId })
    ).id;
    const healthyJobId = (
      await seedQueuedJob(pool, { clientId: healthy.clientId, instanceId: healthy.instanceId })
    ).id;

    const claimedForEmptied = await claimAsGateProbe(emptied.clientId, emptied.instanceId);
    const claimedForHealthy = await claimAsGateProbe(healthy.clientId, healthy.instanceId);

    expect(claimedForEmptied).toBeUndefined();
    expect(claimedForHealthy?.id).toBe(healthyJobId);

    const emptiedJob = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [emptiedJobId],
    );
    expect(emptiedJob.rows[0]?.status).toBe('queued');
  });
});
