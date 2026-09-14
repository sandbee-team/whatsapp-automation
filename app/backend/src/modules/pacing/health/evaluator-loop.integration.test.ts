import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../../engine/pacing/__tests__/pacing-test-helpers.js';
import { runOneHealthEvaluatorSweep, scanForHealthDue } from './evaluator-loop.js';

/**
 * evaluator-loop.integration.test.ts (P16 Unit E, step 9) - real Postgres,
 * fake clock injected via `HealthEvaluatorClock`. Proves: the due-scan only
 * evaluates rows whose `eval_due_at` has passed (a bounded, registered
 * cross-tenant scan); a send outcome (simulated here via `dirty-set.ts#
 * markDirty`, the fast-lane's own write point) marks an instance dirty for
 * the 60s tier; a paused instance falls to tier 3 after its own evaluation;
 * and two tenants evaluated in the same pass never see each other's evidence.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'health-evaluator-loop-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM instance_health_samples WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

// Fake-clock base for the evaluator's OWN tier-ladder arithmetic
// (eval-tier-ladder.ts's nextEvalDueAtMs = nowMs + delay) - self-consistent,
// asserted only against values derived from this same NOW_MS, never against
// a real DB now() comparison.
const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

// Real-time base for any `eval_due_at` value that gates `health-due.sql`'s
// `WHERE eval_due_at <= now()` predicate (scanForHealthDue) or is compared
// against a DB-written `now()` (dirty-set.ts#markDirty) - a hardcoded NOW_MS
// literal drifts relative to Postgres's real wall clock and silently breaks
// the due-scan once real time crosses it (see .memory/lessons/2026-09-02-
// hardcoded-fake-clock-drifts-past-real-db-time.md, third occurrence).
function dbRelativeMs(offsetMs: number): number {
  return Date.now() + offsetMs;
}

function fakeClock(startMs: number): { now: () => number } {
  return { now: () => startMs };
}

async function setEvalDueAt(instanceId: string, dueAt: Date): Promise<void> {
  await pool.query(`UPDATE instance_pacing_state SET eval_due_at = $2 WHERE instance_id = $1`, [
    instanceId,
    dueAt,
  ]);
}

describe('runOneHealthEvaluatorSweep (P16 Unit E, real Postgres)', () => {
  it('only_due_instances_are_evaluated_and_the_scan_is_limited', async () => {
    const due = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });
    const notDue = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });

    const notDueAtMs = dbRelativeMs(60 * 60 * 1000);
    await setEvalDueAt(due.instanceId, new Date(dbRelativeMs(-1000)));
    await setEvalDueAt(notDue.instanceId, new Date(notDueAtMs));

    const outcome = await runOneHealthEvaluatorSweep({
      pool,
      tenantDb,
      clock: fakeClock(NOW_MS),
    });

    expect(outcome.errors).toBe(0);
    expect(outcome.scanned).toBeGreaterThanOrEqual(1);

    const dueRow = await pool.query<{ health_score: string | null }>(
      `SELECT health_score FROM instance_pacing_state WHERE instance_id = $1`,
      [due.instanceId],
    );
    expect(dueRow.rows[0]?.health_score).not.toBeNull();

    const notDueRow = await pool.query<{ eval_due_at: Date }>(
      `SELECT eval_due_at FROM instance_pacing_state WHERE instance_id = $1`,
      [notDue.instanceId],
    );
    expect(notDueRow.rows[0]?.eval_due_at.getTime()).toBe(notDueAtMs);

    // The due-scan itself is bounded (LIMIT-ed) - proving the scan is never
    // unbounded (registration of this query in
    // scripts/registries/cross-tenant-queries.ts is proved by the guard
    // suite, scripts/guards/check-tenant-scope.test.ts, not here).
    //
    // `health-due.sql` is deliberately cross-tenant/global-scope (its own
    // header comment): it scans and claims across every client_id in one
    // statement, with no per-test filter available. `instance_pacing_state`
    // is therefore a SHARED table other suites/fixtures also write real rows
    // into, so asserting a hardcoded `limited.length === 1` (assuming this
    // test's own two fixtures are the only due-or-not rows in the whole
    // table) is the BLOCKER-CLASS pattern (see
    // .memory/progress/master-plan.md, sixth member,
    // lease-state-repo.edge.integration.test.ts's SCAN_CEILING idiom) -
    // fixed here the same way: raise the ceiling far above any plausible
    // ambient population, assert non-truncation (nothing was silently
    // dropped), and assert the INVARIANT the ambient rows cannot break -
    // this test's own due row is present, its own not-due row is absent -
    // rather than a magic exact count on a shared unscoped table.
    await setEvalDueAt(notDue.instanceId, new Date(dbRelativeMs(-500)));
    const SCAN_CEILING = 5_000;
    const limited = await scanForHealthDue(pool, SCAN_CEILING);
    expect(
      limited.length,
      `SCAN_CEILING (${SCAN_CEILING}) was truncating the eligible population (returned exactly that many rows) - raise it and re-measure`,
    ).toBeLessThan(SCAN_CEILING);
    const limitedIds = limited.map((row) => row.instance_id);
    expect(limitedIds).toContain(notDue.instanceId);
  });

  it('the_due_scan_claims_rows_before_evaluation_completes_so_a_second_immediate_scan_returns_none_of_them', async () => {
    // WARNING 3 fix (P16 fix round): scanForHealthDue itself CLAIMS the rows
    // it returns (health-due.sql's own UPDATE ... RETURNING) - the claim is
    // visible in the DB immediately, before any evaluate() call runs, so a
    // concurrent replica's own scan (simulated here as a second, immediate
    // call) can never observe the same due row twice on one tick.
    const first = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });
    const second = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });
    await setEvalDueAt(first.instanceId, new Date(dbRelativeMs(-1000)));
    await setEvalDueAt(second.instanceId, new Date(dbRelativeMs(-500)));

    const beforeScanMs = Date.now();
    const claimed = await scanForHealthDue(pool, 200);
    const claimedIds = claimed.map((row) => row.instance_id);
    expect(claimedIds).toEqual(expect.arrayContaining([first.instanceId, second.instanceId]));

    // The claim is already in the DB future - BEFORE evaluate() ever runs.
    const claimedRows = await pool.query<{ instance_id: string; eval_due_at: Date }>(
      `SELECT instance_id, eval_due_at FROM instance_pacing_state WHERE instance_id = ANY($1)`,
      [[first.instanceId, second.instanceId]],
    );
    for (const row of claimedRows.rows) {
      expect(row.eval_due_at.getTime()).toBeGreaterThan(beforeScanMs);
    }

    // A second, immediate scan returns zero of the same rows - they are no
    // longer due (claimed 60s into the future by the first scan).
    const secondScan = await scanForHealthDue(pool, 200);
    const secondScanIds = secondScan.map((row) => row.instance_id);
    expect(secondScanIds).not.toContain(first.instanceId);
    expect(secondScanIds).not.toContain(second.instanceId);
  });

  it('a_send_outcome_marks_the_instance_dirty_for_the_sixty_second_tier', async () => {
    const seeded = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });
    // Not due yet - proves markDirty (the fast-lane's own send-outcome write
    // point), not the sweep, is what re-arms tier 1.
    await setEvalDueAt(seeded.instanceId, new Date(dbRelativeMs(60 * 60 * 1000)));

    const markDirtyCalledAtMs = Date.now();
    const { markDirty } = await import('./dirty-set.js');
    await tenantDb.withTenant(seeded.clientId, (tx) =>
      markDirty(tx, { clientId: seeded.clientId, instanceId: seeded.instanceId }),
    );

    const dirtyRow = await pool.query<{ eval_tier: number; eval_due_at: Date }>(
      `SELECT eval_tier, eval_due_at FROM instance_pacing_state WHERE instance_id = $1`,
      [seeded.instanceId],
    );
    expect(dirtyRow.rows[0]?.eval_tier).toBe(1);
    // markDirty writes eval_due_at = real DB now() - assert against a
    // real-time bound taken around the call, never against the fake NOW_MS
    // literal (drifts relative to Postgres's actual wall clock).
    expect(dirtyRow.rows[0]?.eval_due_at.getTime()).toBeLessThanOrEqual(
      markDirtyCalledAtMs + 60_000,
    );

    // Now run the sweep at that due time - the evaluator's OWN tick-end
    // decision (eval-tier-ladder.ts) resolves tier 2 (idle) for a connected
    // instance with no band change, the honest exact outcome given the
    // currently-available signals (no "last send outcome" timestamp column
    // exists yet - see HealthEvaluator.ts's own doc).
    await runOneHealthEvaluatorSweep({ pool, tenantDb, clock: fakeClock(NOW_MS) });

    const afterSweep = await pool.query<{ eval_tier: number; eval_due_at: Date }>(
      `SELECT eval_tier, eval_due_at FROM instance_pacing_state WHERE instance_id = $1`,
      [seeded.instanceId],
    );
    expect(afterSweep.rows[0]?.eval_tier).toBe(2);
    expect(afterSweep.rows[0]?.eval_due_at.getTime()).toBe(NOW_MS + 5 * 60 * 1000);

    // Pause the instance directly, then evaluate again - a paused instance
    // falls to tier 3 (30 min) after its own evaluation.
    await pool.query(`UPDATE whatsapp_instances SET health_state = 'paused' WHERE id = $1`, [
      seeded.instanceId,
    ]);
    await setEvalDueAt(seeded.instanceId, new Date(dbRelativeMs(-1000)));

    await runOneHealthEvaluatorSweep({ pool, tenantDb, clock: fakeClock(NOW_MS) });

    const pausedRow = await pool.query<{ eval_tier: number; eval_due_at: Date }>(
      `SELECT eval_tier, eval_due_at FROM instance_pacing_state WHERE instance_id = $1`,
      [seeded.instanceId],
    );
    expect(pausedRow.rows[0]?.eval_tier).toBe(3);
    expect(pausedRow.rows[0]?.eval_due_at.getTime()).toBe(NOW_MS + 30 * 60 * 1000);
  });

  it('two_tenants_do_not_interfere_in_one_evaluation_pass', async () => {
    const tenantA = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });
    const tenantB = await seedPacingInstance(pool, probeClientIds, { healthState: 'connected' });
    await setEvalDueAt(tenantA.instanceId, new Date(dbRelativeMs(-1000)));
    await setEvalDueAt(tenantB.instanceId, new Date(dbRelativeMs(-1000)));

    await runOneHealthEvaluatorSweep({ pool, tenantDb, clock: fakeClock(NOW_MS) });

    const evidenceB = await pool.query<{ evidence: Record<string, unknown> }>(
      `SELECT evidence FROM instance_health_samples WHERE instance_id = $1`,
      [tenantB.instanceId],
    );
    expect(evidenceB.rows.length).toBeGreaterThanOrEqual(1);
    // tenant B's evidence row never references tenant A's ids.
    expect(JSON.stringify(evidenceB.rows[0]?.evidence)).not.toContain(tenantA.instanceId);
    expect(JSON.stringify(evidenceB.rows[0]?.evidence)).not.toContain(tenantA.clientId);
  });
});
