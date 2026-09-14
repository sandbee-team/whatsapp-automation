import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  cleanupReaperProbeClients,
  insertProcessingJob,
  insertSendAttempt,
  readJobStatus,
  seedNeedsReconcile,
  type ReapedRow,
} from './helpers/reaper-fixtures.js';

/**
 * db/tests/reaper-repair-contract.test.ts (P12 U2a) - split out of
 * `reaper-definer.test.ts` at the max-lines cap. Proves the BEHAVIORAL
 * contract of `db/migrations/0027_reaper_and_reconcile_definer_functions.sql`
 * against the REAL database: the two-tenant single pass, the grace boundary,
 * the four-state repair contract, and the reconciler's read-only cross-
 * tenant scan. Function-level hardening/EXECUTE/ownership proofs live in
 * `reaper-definer.test.ts`; the `wp_reaper` role's own shape lives in
 * `wp-reaper-role.test.ts`. Same seed helpers (`helpers/reaper-fixtures.ts`).
 *
 * No sleeps anywhere - every timestamp is seeded relative to SQL's own
 * `now()` (see .claude/rules/core-invariants.md "Tests must not assert on
 * ambient state").
 */
describe('reaper_repair_contract', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    await cleanupReaperProbeClients(probeClientIds);
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('the_reaper_definer_repairs_across_two_tenants_in_one_pass', async () => {
    const pool = await getMigratedPool();
    const clientA = randomUUID();
    const clientB = randomUUID();
    const instanceA = randomUUID();
    const instanceB = randomUUID();
    probeClientIds.push(clientA, clientB);

    const jobA = await insertProcessingJob({
      clientId: clientA,
      instanceId: instanceA,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });
    const jobB = await insertProcessingJob({
      clientId: clientB,
      instanceId: instanceB,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<ReapedRow>(
        'SELECT * FROM wp_reap_expired_leases($1, $2)',
        [30, 500],
      );
      await client.query('COMMIT');

      // Containment, not exact-set equality: this is a genuinely cross-
      // tenant sweep with a shared p_limit of 500, so it may legitimately
      // also repair OTHER expired jobs unrelated to this test (from a
      // concurrent test, or - the whole point of this test - some third
      // tenant entirely). What matters is that BOTH seeded tenants' jobs are
      // present in the same single pass.
      const rowsByJobId = new Map(result.rows.map((row) => [row.message_job_id, row]));
      expect(rowsByJobId.get(jobA.id)).toMatchObject({
        client_id: clientA,
        new_status: 'queued',
        attempt_state: null,
      });
      expect(rowsByJobId.get(jobB.id)).toMatchObject({
        client_id: clientB,
        new_status: 'queued',
        attempt_state: null,
      });
    } finally {
      client.release();
    }
  });

  it('the_reaper_definer_honours_the_grace_and_never_touches_a_live_lease', async () => {
    const pool = await getMigratedPool();
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    // Inside the 30s grace window - must be untouched.
    const liveJob = await insertProcessingJob({
      clientId,
      instanceId,
      leaseExpiresAtSql: "now() - interval '5 seconds'",
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<ReapedRow>(
        'SELECT * FROM wp_reap_expired_leases($1, $2)',
        [30, 500],
      );
      await client.query('COMMIT');

      const touchedIds = result.rows.map((row) => row.message_job_id);
      expect(touchedIds).not.toContain(liveJob.id);
    } finally {
      client.release();
    }

    const after = await readJobStatus(liveJob.id);
    expect(after.status).toBe('processing');
  });

  it('the_four_state_repair_contract_cross_tenant_through_the_function', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const noAttemptJob = await insertProcessingJob({
      clientId,
      instanceId,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });

    const preparedLease = randomUUID();
    const preparedJob = await insertProcessingJob({
      clientId,
      instanceId,
      leaseId: preparedLease,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });
    const preparedAttempt = await insertSendAttempt({
      clientId,
      instanceId,
      jobId: preparedJob.id,
      leaseId: preparedLease,
      state: 'prepared',
    });

    const dispatchedLease = randomUUID();
    const dispatchedJob = await insertProcessingJob({
      clientId,
      instanceId,
      leaseId: dispatchedLease,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });
    const dispatchedAttempt = await insertSendAttempt({
      clientId,
      instanceId,
      jobId: dispatchedJob.id,
      leaseId: dispatchedLease,
      state: 'dispatched',
    });

    const ackedLease = randomUUID();
    const ackedJob = await insertProcessingJob({
      clientId,
      instanceId,
      leaseId: ackedLease,
      leaseExpiresAtSql: "now() - interval '1 minute'",
    });
    const ackedAttempt = await insertSendAttempt({
      clientId,
      instanceId,
      jobId: ackedJob.id,
      leaseId: ackedLease,
      state: 'acked',
    });

    const pool = await getMigratedPool();
    const client = await pool.connect();
    let rows: ReapedRow[];
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<ReapedRow>(
        'SELECT * FROM wp_reap_expired_leases($1, $2)',
        [30, 500],
      );
      await client.query('COMMIT');
      rows = result.rows;
    } finally {
      client.release();
    }

    const byJobId = new Map(rows.map((row) => [row.message_job_id, row]));

    expect(byJobId.get(noAttemptJob.id)).toMatchObject({
      new_status: 'queued',
      attempt_state: null,
      send_attempt_id: null,
    });
    const noAttemptAfter = await readJobStatus(noAttemptJob.id);
    expect(noAttemptAfter.attempts).toBe(1); // UNCHANGED (was seeded at 1)

    expect(byJobId.get(preparedJob.id)).toMatchObject({
      new_status: 'queued',
      attempt_state: 'prepared',
      send_attempt_id: preparedAttempt.id,
    });
    const preparedAfter = await readJobStatus(preparedJob.id);
    // Migration 0029 (P12 C1 review, CRITICAL finding 1): the `prepared`
    // branch no longer decrements `attempts`. The decrement (this
    // assertion's old expectation, `toBe(0)` - "was 1, minus 1") created an
    // unbounded attemptNo-collision retry loop: dispatch()'s
    // `attemptNo = attempts + 1` would recompute the exact attempt_no this
    // still-existing send_attempts row already occupies
    // (`UNIQUE (message_job_id, attempt_no)`, permanent, state-independent),
    // so every re-claim threw DispatchAlreadyRecorded forever. `attempts`
    // now stays exactly as dispatch() last left it (unchanged, still 1) so
    // the next attemptNo is always fresh - see migration 0029's own header
    // for the full collision proof and the two rejected alternatives.
    expect(preparedAfter.attempts).toBe(1); // UNCHANGED - was seeded at 1, no longer decremented

    expect(byJobId.get(dispatchedJob.id)).toMatchObject({
      new_status: 'needs_reconcile',
      attempt_state: 'dispatched',
      send_attempt_id: dispatchedAttempt.id,
    });

    expect(byJobId.get(ackedJob.id)).toMatchObject({
      new_status: 'sent',
      attempt_state: 'acked',
      send_attempt_id: ackedAttempt.id,
    });
    const ackedAfter = await readJobStatus(ackedJob.id);
    expect(ackedAfter.sent_at).not.toBeNull();
    expect(ackedAfter.terminal_at).not.toBeNull();
  });

  it('the_reconcile_scan_definer_is_read_only_and_single_pass_across_tenants', async () => {
    const clientA = randomUUID();
    const clientB = randomUUID();
    const instanceA = randomUUID();
    const instanceB = randomUUID();
    probeClientIds.push(clientA, clientB);

    const pool = await getMigratedPool();

    const jobA = await seedNeedsReconcile(clientA, instanceA);
    const jobB = await seedNeedsReconcile(clientB, instanceB);

    const beforeA = await readJobStatus(jobA);
    const beforeB = await readJobStatus(jobB);

    const client = await pool.connect();
    let rows: Array<{ client_id: string; message_job_id: string }>;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<{ client_id: string; message_job_id: string }>(
        'SELECT * FROM wp_reconcile_scan_unresolved($1, $2, $3)',
        [3600, 300, 500],
      );
      await client.query('COMMIT');
      rows = result.rows;
    } finally {
      client.release();
    }

    // Containment, not exact-set equality - same reasoning as the reaper's
    // two-tenant test: a genuinely cross-tenant scan may legitimately also
    // surface OTHER needs_reconcile jobs. What matters is both seeded
    // tenants' jobs are present in the same single pass.
    const rowsByJobId = new Map(rows.map((row) => [row.message_job_id, row]));
    expect(rowsByJobId.get(jobA)).toMatchObject({ client_id: clientA });
    expect(rowsByJobId.get(jobB)).toMatchObject({ client_id: clientB });

    const afterA = await readJobStatus(jobA);
    const afterB = await readJobStatus(jobB);
    expect(afterA).toEqual(beforeA);
    expect(afterB).toEqual(beforeB);
  });
});
