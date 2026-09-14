import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { resolveRedisUrl, createRedis } from '../../../platform/redis.js';
import {
  cleanupChargerRedisKeys,
  cleanupSendProbeClients,
  seedSendTenant,
  seedDispatchedAttempt,
  seedClaimedJob,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createTenantDbAsRole } from '../../../platform/db/test-support/wp-app-role.js';
import { createChargerWorker } from '../charger.worker.js';
import { runOneWalletRollupSweep } from '../rollup.js';
import { runOneWalletReconcileSweep } from '../reconcile.js';
import { resolveAck } from '../../../engine/queue/result.js';
import {
  makeRecordingMetrics,
  markNonRepairedMissingDebit,
  markRepairedMissingDebit,
} from './reconcile-test-support.js';

/**
 * suite-b-wallet.integration.test.ts (P18 C2, step 10 "suite B" deliverable) - the wallet module's three background paths (charger drain, rollup, reconciler) as two-tenant isolation proofs (clientA/clientB/clientNeither) - writes land on the right tenant, checked by CONTENT.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const REDIS_ENV = 'test'; // must satisfy the `[a-z]+` env grammar
const fixedRng = { random: () => 0.5 };

interface AckSeed {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attemptNo: number;
  publicId: string;
}

/** Acks one dispatched-attempt-shaped seed via the real resolveAck, charging its wallet by one debit_send. */
async function ackOneDebit(
  tenantDb: ReturnType<typeof createTenantDb>,
  seeded: AckSeed,
  providerMsgId: string,
): Promise<void> {
  await resolveAck(
    {
      ...seeded,
      outcome: { providerMsgId },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
    },
    { tenantDb, rng: fixedRng },
  );
}

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'suite-b-wallet' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupChargerRedisKeys(REDIS_ENV, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wallet background paths - two-tenant isolation (suite B)', () => {
  it('charger_drain_charges_each_tenants_repaired_send_on_its_own_wallet_only', async () => {
    const redis = createRedis(resolveRedisUrl());
    try {
      const clientA = await seedDispatchedAttempt(pool, probeClientIds);
      const clientB = await seedDispatchedAttempt(pool, probeClientIds);
      const clientNeither = await seedSendTenant(pool, probeClientIds);

      const attemptRowA = await markRepairedMissingDebit(pool, clientA);
      const attemptRowB = await markRepairedMissingDebit(pool, clientB);

      const tenantDb = createTenantDb(pool);
      const worker = createChargerWorker({ redis, env: REDIS_ENV, tenantDb });

      await worker.enqueue({ clientId: clientA.clientId, attemptId: attemptRowA });
      await worker.enqueue({ clientId: clientB.clientId, attemptId: attemptRowB });

      const result = await worker.drainOnce();
      expect(result.clients).toBe(2);
      expect(result.charged).toBe(2);
      expect(result.failed).toBe(0);

      const balanceA = await pool.query<{ balance_minor: string }>(
        'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
        [clientA.clientId],
      );
      expect(balanceA.rows[0]?.balance_minor).toBe('99985');
      const balanceB = await pool.query<{ balance_minor: string }>(
        'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
        [clientB.clientId],
      );
      expect(balanceB.rows[0]?.balance_minor).toBe('99985');

      const guardA = await pool.query<{ client_id: string }>(
        `SELECT client_id FROM wallet_charge_guards WHERE send_attempt_id = $1 AND kind = 'debit_send'`,
        [attemptRowA],
      );
      expect(guardA.rows).toHaveLength(1);
      expect(guardA.rows[0]?.client_id).toBe(clientA.clientId);

      const guardB = await pool.query<{ client_id: string }>(
        `SELECT client_id FROM wallet_charge_guards WHERE send_attempt_id = $1 AND kind = 'debit_send'`,
        [attemptRowB],
      );
      expect(guardB.rows).toHaveLength(1);
      expect(guardB.rows[0]?.client_id).toBe(clientB.clientId);

      // No ledger row of A references B's attempt id, and vice versa.
      const ledgerA = await pool.query<{ send_attempt_id: string }>(
        `SELECT send_attempt_id::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'`,
        [clientA.clientId],
      );
      expect(ledgerA.rows.map((r) => r.send_attempt_id)).toEqual([attemptRowA]);
      const ledgerB = await pool.query<{ send_attempt_id: string }>(
        `SELECT send_attempt_id::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'`,
        [clientB.clientId],
      );
      expect(ledgerB.rows.map((r) => r.send_attempt_id)).toEqual([attemptRowB]);

      const neitherBalance = await pool.query<{ balance_minor: string }>(
        'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
        [clientNeither.clientId],
      );
      expect(neitherBalance.rows[0]?.balance_minor).toBe('100000');
      const neitherGuards = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1`,
        [clientNeither.clientId],
      );
      expect(neitherGuards.rows[0]?.count).toBe('0');
      const neitherLedger = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1`,
        [clientNeither.clientId],
      );
      expect(neitherLedger.rows[0]?.count).toBe('0');
    } finally {
      redis.disconnect();
    }
  });

  it('rollup_writes_each_tenants_daily_summary_from_its_own_ledger_only', async () => {
    const clientA = await seedDispatchedAttempt(pool, probeClientIds);
    const clientB = await seedDispatchedAttempt(pool, probeClientIds);
    const clientNeither = await seedSendTenant(pool, probeClientIds);

    const tenantDbBypass = createTenantDb(pool);
    const fixedNow = new Date();
    const now = () => fixedNow;

    // A gets two debits (below + a second seeded on A directly); B gets one
    // - proving the rollup groups strictly by client_id, not by seed call.
    await ackOneDebit(tenantDbBypass, clientA, 'wamid.suite-b-rollup-a1');
    await ackOneDebit(tenantDbBypass, clientB, 'wamid.suite-b-rollup-b1');

    // A's SECOND debit: a fresh dispatched attempt seeded directly on A's
    // own tenant (mirrors seedDispatchedAttemptOnTenant's shape).
    const secondJob = await seedClaimedJob(pool, {
      clientId: clientA.clientId,
      instanceId: clientA.instanceId,
    });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
      [clientA.clientId, clientA.instanceId, secondJob.id, secondJob.createdAt, secondJob.leaseId],
    );
    await ackOneDebit(
      tenantDbBypass,
      {
        ...clientA,
        jobId: secondJob.id,
        jobCreatedAt: secondJob.createdAt,
        leaseId: secondJob.leaseId,
        attemptNo: 1,
        publicId: secondJob.publicId,
      },
      'wamid.suite-b-rollup-a2',
    );

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const result = await runOneWalletRollupSweep({ pool, tenantDb, now, days: 1 });
    expect(result.rowsUpserted).toBeGreaterThanOrEqual(2);

    const summaryA = await pool.query<{ sent_count: number; instance_id: string }>(
      `SELECT sent_count, instance_id FROM wallet_daily_summary WHERE client_id = $1`,
      [clientA.clientId],
    );
    expect(summaryA.rows).toHaveLength(1);
    expect(summaryA.rows[0]?.sent_count).toBe(2);
    expect(summaryA.rows[0]?.instance_id).toBe(clientA.instanceId);

    const summaryB = await pool.query<{ sent_count: number; instance_id: string }>(
      `SELECT sent_count, instance_id FROM wallet_daily_summary WHERE client_id = $1`,
      [clientB.clientId],
    );
    expect(summaryB.rows).toHaveLength(1);
    expect(summaryB.rows[0]?.sent_count).toBe(1);
    expect(summaryB.rows[0]?.instance_id).toBe(clientB.instanceId);

    const summaryNeither = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM wallet_daily_summary WHERE client_id = $1`,
      [clientNeither.clientId],
    );
    expect(summaryNeither.rows[0]?.count).toBe('0');
  });

  it('reconciler_corrections_and_findings_stay_on_their_own_tenant', async () => {
    const seededA = await seedDispatchedAttempt(pool, probeClientIds);
    const attemptA = await markNonRepairedMissingDebit(pool, seededA);

    const seededB = await seedDispatchedAttempt(pool, probeClientIds);
    // Plant a continuity break for B: a seq that skips ahead of entry_seq.
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor, actor_type)
       VALUES ($1, 999, 'debit_send', -15, 99985, 'text', 15, 'system')`,
      [seededB.clientId],
    );

    const clientNeither = await seedSendTenant(pool, probeClientIds);

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();

    const balanceBBefore = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seededB.clientId],
    );

    const outcome = await runOneWalletReconcileSweep({ pool, tenantDb, metrics });
    expect(outcome.findings.missing_debits).toBeGreaterThanOrEqual(1);
    expect(outcome.findings.continuity).toBeGreaterThanOrEqual(1);

    // A: adjustment_debit + missing_debit finding, on A only.
    const ledgerA = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'adjustment_debit'`,
      [seededA.clientId],
    );
    expect(ledgerA.rows[0]?.count).toBe('1');
    const findingA = await pool.query<{ kind: string; detail: unknown }>(
      `SELECT kind, detail FROM wallet_reconcile_findings WHERE client_id = $1 AND kind = 'missing_debit'`,
      [seededA.clientId],
    );
    expect(findingA.rows).toHaveLength(1);
    expect(JSON.stringify(findingA.rows[0]?.detail)).toContain(attemptA);
    expect(JSON.stringify(findingA.rows[0]?.detail)).not.toContain(seededB.jobId);

    // B: continuity/balance_mismatch findings, NO money change.
    const findingsB = await pool.query<{ kind: string }>(
      `SELECT kind FROM wallet_reconcile_findings WHERE client_id = $1`,
      [seededB.clientId],
    );
    const kindsB = findingsB.rows.map((r) => r.kind);
    expect(kindsB.some((k) => k === 'continuity_break' || k === 'balance_mismatch')).toBe(true);
    const adjustmentB = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'adjustment_debit'`,
      [seededB.clientId],
    );
    expect(adjustmentB.rows[0]?.count).toBe('0');
    const balanceBAfter = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seededB.clientId],
    );
    expect(balanceBAfter.rows[0]?.balance_minor).toBe(balanceBBefore.rows[0]?.balance_minor);

    // clientNeither: zero ledger rows. It DOES get a spurious check-A
    // balance_mismatch (PRODUCT DEFECT - see checkpoint-balance-not-
    // initialised-at-signup.integration.test.ts). Asserted as a finding
    // KIND, not absence, to document reality rather than hide it.
    const neitherFindings = await pool.query<{ kind: string }>(
      `SELECT kind FROM wallet_reconcile_findings WHERE client_id = $1`,
      [clientNeither.clientId],
    );
    expect(neitherFindings.rows.map((r) => r.kind)).toEqual(['balance_mismatch']);
    const neitherLedger = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1`,
      [clientNeither.clientId],
    );
    expect(neitherLedger.rows[0]?.count).toBe('0');

    // A's findings never mention B's ids.
    for (const row of findingA.rows) {
      expect(JSON.stringify(row.detail)).not.toContain(seededB.clientId);
    }
  });
});
