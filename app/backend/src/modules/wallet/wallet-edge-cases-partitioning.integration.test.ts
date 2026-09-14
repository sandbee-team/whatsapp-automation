import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { chargeRepairedSend } from './charge.js';
import { runOneWalletReconcileSweep } from './reconcile.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  markNonRepairedMissingDebit,
  makeRecordingMetrics,
} from './__tests__/reconcile-test-support.js';

/**
 * wallet-edge-cases-partitioning.integration.test.ts (P18 C2 hardening) -
 * real Postgres, sibling to `wallet-edge-cases-boundaries.integration.
 * test.ts` (split at the max-lines cap): the guard partition's month
 * boundary (ADR 0038 SS1's `created_at` = the charged job's own
 * `created_at`, never `now()`) and the reconciler window's grace-period
 * edge (`resolved_at` inclusive/exclusive bounds).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-partitioning-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wallet edge cases - partitioning/window boundaries (real Postgres)', () => {
  it('month_boundary_guard_partition_repair_then_reconciler_check_B_both_see_it_as_charged', async () => {
    const tenant = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    // A job created on the LAST MICROSECOND of last month (relative to the
    // real wall clock's own month) - the guard's created_at is the job's
    // OWN created_at (ADR 0038 SS1), so this lands in last month's
    // wallet_charge_guards partition (seeded by migration 0051).
    const now = new Date();
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1);

    const jobRow = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, created_at, sent_at, terminal_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'sent', $5, $5, 1, 5, $5, $5, $5)
       RETURNING id, created_at`,
      [
        tenant.clientId,
        tenant.instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        JSON.stringify({ text: 'hello' }),
        lastMonthEnd,
      ],
    );
    const job = jobRow.rows[0]!;

    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at, resolved_at, provider_msg_id)
       VALUES ($1, $2, $3, $4, $5, 1, 'acked', $4, $4, now() - interval '30 minutes', 'wamid.month-boundary')`,
      [tenant.clientId, tenant.instanceId, job.id, job.created_at, randomUUID()],
    );
    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1',
      [job.id],
    );
    const attemptId = attemptRow.rows[0]!.id;

    // chargeRepairedSend sees it charged.
    const repaired = await chargeRepairedSend(
      tenantDb,
      { clientId: tenant.clientId, attemptId },
      {},
    );
    expect(repaired.seq).not.toBeNull();

    // The reconciler's own check B sees the SAME guard (already stamped) -
    // a second attempt at charging is a correct no-op, never a double
    // charge across the month boundary.
    const wpAppTenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();
    await runOneWalletReconcileSweep({ pool, tenantDb: wpAppTenantDb, metrics });

    const guardCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE send_attempt_id = $1 AND kind = 'debit_send'",
      [attemptId],
    );
    expect(guardCount.rows[0]?.count).toBe('1');
    const ledgerCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE send_attempt_id = $1 AND kind = 'debit_send'",
      [attemptId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('1');
  });

  it('reconciler_window_edge_now_minus_graceMs_is_excluded_now_minus_graceMs_minus_1s_is_included', async () => {
    const graceMs = 10 * 60 * 1000;
    const fixedNow = new Date('2026-06-15T12:00:00.000Z');

    const seededExcluded = await seedDispatchedAttempt(pool, probeClientIds);
    const seededIncluded = await seedDispatchedAttempt(pool, probeClientIds);

    const excludedResolvedAt = new Date(fixedNow.getTime() - graceMs);
    const includedResolvedAt = new Date(fixedNow.getTime() - graceMs - 1000);

    await markNonRepairedMissingDebit(pool, seededExcluded);
    await pool.query(`UPDATE send_attempts SET resolved_at = $2 WHERE message_job_id = $1`, [
      seededExcluded.jobId,
      excludedResolvedAt,
    ]);
    await markNonRepairedMissingDebit(pool, seededIncluded);
    await pool.query(`UPDATE send_attempts SET resolved_at = $2 WHERE message_job_id = $1`, [
      seededIncluded.jobId,
      includedResolvedAt,
    ]);

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();
    await runOneWalletReconcileSweep({ pool, tenantDb, metrics, now: () => fixedNow, graceMs });

    const excludedLedger = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'adjustment_debit'`,
      [seededExcluded.clientId],
    );
    expect(excludedLedger.rows[0]?.count).toBe('0');

    const includedLedger = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'adjustment_debit'`,
      [seededIncluded.clientId],
    );
    expect(includedLedger.rows[0]?.count).toBe('1');
  });
});
