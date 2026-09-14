import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneWalletReconcileSweep, type WalletReconcileOutcome } from './reconcile.js';
import { runOneWalletRollupSweep } from './rollup.js';
import {
  makeRecordingMetrics,
  markNonRepairedMissingDebit,
  markRepairedMissingDebit,
  type TestPool,
} from './__tests__/reconcile-test-support.js';

/**
 * reconcile.integration.test.ts (P18 Unit U8b) - real Postgres, the wallet
 * reconciler sweep's core check-B proofs: a missing debit auto-corrected
 * exactly once, a repaired-send missing debit charged uncapped, and the
 * append-only ledger invariant enforced at the DATABASE layer for `wp_app`
 * (never just by this module's own source text). Checks A/C/D/E's own
 * proofs (daily cap, orphan guard, continuity) live in the sibling
 * `reconcile-checks.integration.test.ts` (split at the max-lines cap).
 *
 * `tenantDb` is `createTenantDbAsRole(pool, 'wp_app')` so every WRITE this
 * sweep makes runs as the real `wp_app` role, under RLS; `pool` (the
 * superuser test pool) is the cross-tenant READ half, matching production's
 * own wp_scheduler-vs-wp_app split.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'reconcile-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the wallet reconciler sweep - check B - real Postgres', () => {
  it('a_missing_debit_is_detected_and_auto_corrected_once', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const attemptId = await markNonRepairedMissingDebit(pool, seeded);

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();

    // A single fixed `now` for every rollup/reconcile call below - the
    // ledger row's own `created_at` is the REAL wall-clock (a DB column
    // default), so pinning `now` here is not about the DB write itself, only
    // about the day-BOUNDARY math (`toUtcDayString`) staying internally
    // consistent across all four calls even if the real wall clock crosses
    // a UTC midnight mid-test (ambient state, not injected - see
    // core-invariants.md "tests must not assert on ambient state").
    const fixedNow = new Date();
    const now = () => fixedNow;

    // Run the rollup BEFORE the first reconcile sweep so check D (rollup
    // parity) has nothing to report for the probe client yet - the ONLY
    // thing check D compares against is whatever wallet_daily_summary
    // already holds, and a fresh probe client has no row at all until this
    // runs once.
    await runOneWalletRollupSweep({ pool, tenantDb, now });

    const outcome = await runOneWalletReconcileSweep({ pool, tenantDb, metrics, now });

    const ledgerRows = await pool.query<{ amount_minor: string; reason: string }>(
      `SELECT amount_minor::text, reason FROM wallet_ledger
        WHERE client_id = $1 AND kind = 'adjustment_debit'`,
      [seeded.clientId],
    );
    expect(ledgerRows.rows).toHaveLength(1);
    expect(ledgerRows.rows[0]?.amount_minor).toBe('-15');
    expect(ledgerRows.rows[0]?.reason).toBe('reconciliation');

    const guardRow = await pool.query<{ ledger_seq: string }>(
      `SELECT ledger_seq::text FROM wallet_charge_guards
        WHERE send_attempt_id = $1 AND kind = 'adjustment_debit'`,
      [attemptId],
    );
    expect(guardRow.rows[0]?.ledger_seq).not.toBe('0');

    expect(outcome.findings.missing_debits).toBe(1);
    expect(outcome.corrected).toBe(1);

    const balance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balance.rows[0]?.balance_minor).toBe('99985');

    const findingCountBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_reconcile_findings WHERE client_id = $1`,
      [seeded.clientId],
    );
    const ledgerCountBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1`,
      [seeded.clientId],
    );
    const guardCountBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1`,
      [seeded.clientId],
    );

    // The correction above just inserted a NEW adjustment_debit ledger row,
    // which changes today's rollup totals - re-run the rollup so check D
    // compares against the UPDATED summary, not the stale pre-correction one
    // (otherwise check D would re-report a rollup_parity finding on the
    // second sweep purely because the summary is now out of date, which is
    // not the idempotency property this test is proving).
    await runOneWalletRollupSweep({ pool, tenantDb, now });

    await runOneWalletReconcileSweep({ pool, tenantDb, metrics, now });

    const findingsAfter = await pool.query<{ kind: string; detail: unknown }>(
      `SELECT kind, detail FROM wallet_reconcile_findings WHERE client_id = $1`,
      [seeded.clientId],
    );
    const findingCountAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_reconcile_findings WHERE client_id = $1`,
      [seeded.clientId],
    );
    const newFindingsCount =
      Number(findingCountAfter.rows[0]?.count) - Number(findingCountBefore.rows[0]?.count);
    if (newFindingsCount !== 0) {
      throw new Error(
        `second sweep re-reported ${newFindingsCount} finding(s) for the probe client: ` +
          JSON.stringify(findingsAfter.rows.map((r) => ({ kind: r.kind, detail: r.detail }))),
      );
    }
    expect(findingCountAfter.rows[0]?.count).toBe(findingCountBefore.rows[0]?.count);

    const ledgerCountAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1`,
      [seeded.clientId],
    );
    expect(ledgerCountAfter.rows[0]?.count).toBe(ledgerCountBefore.rows[0]?.count);

    const guardCountAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1`,
      [seeded.clientId],
    );
    expect(guardCountAfter.rows[0]?.count).toBe(guardCountBefore.rows[0]?.count);

    const balanceAfter = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfter.rows[0]?.balance_minor).toBe('99985');
  });

  it('a_repaired_send_missing_debit_is_charged_uncapped', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const attemptId = await markRepairedMissingDebit(pool, seeded);

    const tenantDb = createTenantDbAsRole(pool, 'wp_app');
    const { metrics } = makeRecordingMetrics();

    const outcome: WalletReconcileOutcome = await runOneWalletReconcileSweep({
      pool,
      tenantDb,
      metrics,
      dailyCorrectionCap: 0,
    });

    expect(outcome.findings.missing_debits).toBeGreaterThanOrEqual(1);

    const guardRow = await pool.query<{ ledger_seq: string }>(
      `SELECT ledger_seq::text FROM wallet_charge_guards
        WHERE send_attempt_id = $1 AND kind = 'debit_send'`,
      [attemptId],
    );
    expect(guardRow.rows[0]?.ledger_seq).not.toBe('0');

    const findingRow = await pool.query<{ kind: string }>(
      `SELECT kind FROM wallet_reconcile_findings
        WHERE client_id = $1 AND kind = 'missing_debit_repaired'`,
      [seeded.clientId],
    );
    expect(findingRow.rows).toHaveLength(1);
  });

  it('the_reconciler_never_updates_or_deletes_a_ledger_row', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDbAsRole(pool, 'wp_app');

    await expect(
      tenantDb.withTenant(seeded.clientId, (tx) =>
        tx.query(`UPDATE wallet_ledger SET reason = 'x' WHERE client_id = $1`, [seeded.clientId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const { metrics } = makeRecordingMetrics();
    await expect(runOneWalletReconcileSweep({ pool, tenantDb, metrics })).resolves.toBeDefined();
  });
});
