import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck, type ResultDeps } from '../../engine/queue/result.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  seedSendTenant,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneWalletReconcileSweep } from './reconcile.js';
import {
  makeRecordingMetrics,
  markNonRepairedMissingDebit,
  markRepairedMissingDebit,
  seedDispatchedAttemptOnTenant,
  type TestPool,
} from './__tests__/reconcile-test-support.js';

/**
 * reconcile-checks.integration.test.ts (P18 Unit U8b) - real Postgres, the
 * remaining wallet reconciler proofs split out of `reconcile.integration
 * .test.ts` at the max-lines cap: the daily correction cap (non-repaired
 * only), check E's orphan-guard age filter, and check A's continuity/
 * balance-mismatch detection with an exact drift-gauge reading.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reconcile-checks-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the wallet reconciler sweep - checks A/C/E - real Postgres', () => {
  it('auto_correction_respects_the_daily_cap_except_for_repaired_sends', async () => {
    // The cap is PER CLIENT: both non-repaired candidates AND the repaired
    // one live on the SAME tenant, so this proves the cap actually binds
    // per-client (seeding them on different clients would never exercise
    // the cap at all - each client gets its own budget).
    const tenant = await seedSendTenant(pool, probeClientIds);
    const attemptA = await seedDispatchedAttemptOnTenant(pool, tenant);
    const attemptB = await seedDispatchedAttemptOnTenant(pool, tenant);
    const attemptRepaired = await seedDispatchedAttemptOnTenant(pool, tenant);

    await markNonRepairedMissingDebit(pool, attemptA);
    await markNonRepairedMissingDebit(pool, attemptB);
    await markRepairedMissingDebit(pool, attemptRepaired);

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();

    const balanceBefore = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [tenant.clientId],
    );

    await runOneWalletReconcileSweep({ pool, tenantDb, metrics, dailyCorrectionCap: 1 });

    // Only ONE non-repaired candidate on `tenant` may be corrected (cap=1);
    // the other is capped. Which of the two gets corrected is order-
    // dependent, so assert the COUNTS only, never which attempt won.
    const adjustmentDebits = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'adjustment_debit'`,
      [tenant.clientId],
    );
    expect(adjustmentDebits.rows[0]?.count).toBe('1');

    const cappedFindings = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_reconcile_findings
        WHERE client_id = $1 AND kind = 'missing_debit_capped'`,
      [tenant.clientId],
    );
    expect(cappedFindings.rows[0]?.count).toBe('1');

    // The repaired attempt is uncapped (chargeRepairedSend never consults
    // the daily cap) - exactly one debit_send on the SAME client.
    const repairedDebits = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'`,
      [tenant.clientId],
    );
    expect(repairedDebits.rows[0]?.count).toBe('1');

    // Balance dropped by exactly 30: the one corrected non-repaired debit
    // (-15) plus the repaired-send debit (-15), both on `tenant`.
    const balanceAfter = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [tenant.clientId],
    );
    expect(
      Number(balanceBefore.rows[0]?.balance_minor) - Number(balanceAfter.rows[0]?.balance_minor),
    ).toBe(30);
  });

  it('an_orphan_guard_older_than_ten_minutes_is_reported', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]?.id;
    if (!attemptId) throw new Error('no send_attempts row seeded');

    const freshAttemptRow = await pool.query<{ id: string }>(
      `INSERT INTO send_attempts (client_id, instance_id, message_job_id, message_job_created_at, lease_id, attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, gen_random_uuid(), 2, 'dispatched', now(), now())
       RETURNING id`,
      [seeded.clientId, seeded.instanceId, seeded.jobId, seeded.jobCreatedAt],
    );
    const freshAttemptId = freshAttemptRow.rows[0]?.id;
    if (!freshAttemptId) throw new Error('no fresh attempt seeded');

    await pool.query(
      `INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
       VALUES ($1, 'debit_send', $2, 0, now() - interval '11 minutes')`,
      [attemptId, seeded.clientId],
    );
    await pool.query(
      `INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
       VALUES ($1, 'debit_send', $2, 0, now())`,
      [freshAttemptId, seeded.clientId],
    );

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();

    await runOneWalletReconcileSweep({ pool, tenantDb, metrics });

    const findings = await pool.query<{ detail: { send_attempt_id: string } }>(
      `SELECT detail FROM wallet_reconcile_findings
        WHERE client_id = $1 AND kind = 'orphan_guard'`,
      [seeded.clientId],
    );
    const reportedAttemptIds = findings.rows.map((r) => r.detail.send_attempt_id);
    expect(reportedAttemptIds).toContain(attemptId);
    expect(reportedAttemptIds).not.toContain(freshAttemptId);
  });

  it('continuity_detects_a_planted_break_and_the_drift_gauge_reflects_it', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDbProd = createTenantDb(pool);
    const resultDeps: ResultDeps = { tenantDb: tenantDbProd, rng: fixedRng };

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        outcome: { providerMsgId: 'wamid.reconcile-continuity' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      resultDeps,
    );

    const accountBefore = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    const realBalance = Number(accountBefore.rows[0]?.balance_minor);
    const plantedBalance = realBalance + 999;

    await pool.query(
      `UPDATE wallet_ledger SET balance_after_minor = $2
        WHERE client_id = $1 AND seq = (SELECT max(seq) FROM wallet_ledger WHERE client_id = $1)`,
      [seeded.clientId, plantedBalance],
    );
    await pool.query(`UPDATE wallet_accounts SET entry_seq = entry_seq + 1 WHERE client_id = $1`, [
      seeded.clientId,
    ]);

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics, drifts } = makeRecordingMetrics();

    const outcome = await runOneWalletReconcileSweep({ pool, tenantDb, metrics });

    // (a) The PROBE client's own findings from THIS sweep only - never the
    // global gauge, which also reflects permanent fixture-client drift
    // ("Queue Fixture Client 1-5") that this sweep correctly reports too
    // (wp_wallet_drift_minor is a global, unlabelled gauge by design, ADR
    // 0019 S10). Exactly one continuity_break and one balance_mismatch, and
    // the balance_mismatch's own amount_minor is the EXACT planted delta:
    // amount_minor = account.balance_minor - ledger.newest.balance_after_minor
    //              = realBalance - plantedBalance = -999, so |amount_minor| = 999.
    const findings = await pool.query<{ kind: string; amount_minor: string | null }>(
      `SELECT kind, amount_minor::text FROM wallet_reconcile_findings WHERE client_id = $1`,
      [seeded.clientId],
    );
    const continuityBreaks = findings.rows.filter((r) => r.kind === 'continuity_break');
    const balanceMismatches = findings.rows.filter((r) => r.kind === 'balance_mismatch');
    expect(continuityBreaks).toHaveLength(1);
    expect(balanceMismatches).toHaveLength(1);
    const plantedDriftMinor = Math.abs(realBalance - plantedBalance);
    expect(plantedDriftMinor).toBe(999);
    expect(Math.abs(Number(balanceMismatches[0]?.amount_minor))).toBe(plantedDriftMinor);

    // (b) `setDrift` was called exactly once, with a value EQUAL to a fresh
    // read of wp_wallet_check_continuity's own balance_mismatch rows, summed
    // by THIS TEST against the SAME database state right after the sweep -
    // an identity between two reads of the same state, never a bound and
    // never a hard-coded number (the persistent dev DB's fixture clients
    // contribute real balance_mismatch drift of their own, which this
    // cross-tenant sum legitimately includes).
    const globalDrift = await pool.query<{ drift_minor: string }>(
      `SELECT COALESCE(sum(abs(amount_minor)), 0)::text AS drift_minor
         FROM wp_wallet_check_continuity(500)
        WHERE kind = 'balance_mismatch'`,
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toBe(Number(globalDrift.rows[0]?.drift_minor));
    expect(outcome.driftMinor).toBe(Number(globalDrift.rows[0]?.drift_minor));

    // (c) Sanity check only (never the primary assertion): the global sum
    // must be at least the probe client's own planted drift.
    expect(Number(globalDrift.rows[0]?.drift_minor)).toBeGreaterThanOrEqual(plantedDriftMinor);
  });
});
