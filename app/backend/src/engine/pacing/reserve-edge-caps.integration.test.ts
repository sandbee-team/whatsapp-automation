import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { reserve } from './index.js';
import { claimAndReserve } from '../queue/send-loop-pacing-claim.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
} from '../queue/__tests__/queue-send-test-helpers.js';

/**
 * reserve-edge-caps.integration.test.ts (P13 C2 hardening) - empty/huge
 * input edge cases the C2 checklist calls out specifically, none of which
 * are exercised by the sibling suites: `eff_daily_cap = 0` (immediate deny,
 * never a false grant), a cap set exactly to `ABSOLUTE_DAILY_CEILING`
 * (2000 - reserve-pacing.sql reads eff_daily_cap in-statement, so this
 * proves the DB-side predicate itself, not just resolveEffective's own
 * clamp, honours the ceiling), `gapMinMs === gapMaxMs` (the log-uniform
 * draw's degenerate case) flowing all the way through `reserve()`'s own
 * `next_eligible_at` write, and a claimed job with NO
 * `instance_pacing_state` row at all reaching `claimAndReserve` - the
 * fail-closed `NO_LEDGER_ROW` path, never a silent grant.
 */

type PoolT = TestPool;

let pool: PoolT;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-edge-caps-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];
let sendProbeClientIds: string[] = [];

afterEach(async () => {
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
  await cleanupSendProbeClients(pool, sendProbeClientIds);
  sendProbeClientIds = [];
});

const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

describe('reserve() empty/huge cap edge cases', () => {
  it('eff_daily_cap_of_zero_denies_the_very_first_reserve', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 0,
    });

    const outcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });

    expect(outcome.granted).toBe(false);
    if (!outcome.granted) {
      expect(outcome.reason).toBe('DAILY_CAP');
    }

    const ledger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    // The first-reserve-of-the-day ON CONFLICT DO NOTHING insert still runs
    // (that is a structural side effect of reserve-pacing.sql's own CTEs,
    // independent of any cap), but consumed_count is byte-identical to the
    // seed value 0 - a zero cap grants nothing, ever.
    expect(ledger.rows[0]?.consumed_count ?? 0).toBe(0);
  });

  it('a_cap_at_the_absolute_daily_ceiling_grants_exactly_2000_and_no_more', async () => {
    const ABSOLUTE_DAILY_CEILING = 2000;
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: ABSOLUTE_DAILY_CEILING,
      hourlyCap: ABSOLUTE_DAILY_CEILING + 1,
      newConvCap: ABSOLUTE_DAILY_CEILING + 1,
      coldRatioMax: 1,
      coldRatioFloor: 0,
    });

    // Directly set consumed_count to CEILING - 1 so only ONE more grant is
    // possible - proves the DB predicate itself (not just a slow loop)
    // honours the ceiling value at the boundary.
    await pool.query(
      `INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, hour_key, consumed_count, next_eligible_at)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, EXTRACT(hour FROM now() AT TIME ZONE 'Asia/Kolkata')::smallint, $3, now())`,
      [clientId, instanceId, ABSOLUTE_DAILY_CEILING - 1],
    );

    const first = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(first.granted).toBe(true);

    const second = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(second.granted).toBe(false);
    if (!second.granted) {
      expect(second.reason).toBe('DAILY_CAP');
    }

    const ledger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.consumed_count).toBe(ABSOLUTE_DAILY_CEILING);
  });

  it('a_degenerate_gap_min_equals_gap_max_advances_next_eligible_at_by_exactly_that_value_never_nan', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 10,
      gapMinMs: 42_000,
      gapMaxMs: 42_000,
    });

    const before = await pool.query<{ now: Date }>('SELECT now() AS now');
    const dbNowMs = before.rows[0]!.now.getTime();

    const outcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 42_000,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });

    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;

    expect(Number.isNaN(outcome.nextEligibleAt.getTime())).toBe(false);
    // next_eligible_at = now() + 42_000ms, written by the SAME statement -
    // assert against the DB's own before/after now() window, never a
    // client-side wall-clock margin.
    const after = await pool.query<{ now: Date }>('SELECT now() AS now');
    const dbAfterMs = after.rows[0]!.now.getTime();
    expect(outcome.nextEligibleAt.getTime()).toBeGreaterThanOrEqual(dbNowMs + 42_000);
    expect(outcome.nextEligibleAt.getTime()).toBeLessThanOrEqual(dbAfterMs + 42_000);
  });
});

describe('claimAndReserve() with no instance_pacing_state row at all', () => {
  /**
   * FINDING 3 FIX (P13 C1/C2 review) - formerly pinned as
   * `BUG_a_missing_pacing_state_row_throws_a_not_null_violation_instead_of_
   * the_documented_NO_LEDGER_ROW_deny`: a missing `instance_pacing_state`
   * row used to make `reserve-pacing.sql`'s own `ins`/`cu` CTEs insert a
   * NULL `ledger_date` into `client_daily_usage` (NOT NULL), throwing a raw
   * Postgres error instead of the documented `NO_LEDGER_ROW` deny. Fixed by
   * deleting those row-creation CTEs from the reserve statement entirely
   * (Finding 5) and, separately, by `claimAndReserve` (Finding 3b) skipping
   * the reserve call ENTIRELY when `readPacingState` finds no row - it
   * writes the `NO_LEDGER_ROW` deferral directly instead. This test now
   * proves the documented, intended contract: fail-closed, never a grant,
   * NEVER a thrown error - the job is preserved `queued` with a
   * `NO_LEDGER_ROW` deny reason and a bounded retry hold.
   */
  it('a_missing_pacing_state_row_denies_no_ledger_row_and_never_throws', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, sendProbeClientIds);
    // seedSendTenant already inserts an instance_pacing_state row - delete
    // it to reproduce the genuinely-missing-row shape.
    await pool.query('DELETE FROM instance_pacing_state WHERE instance_id = $1', [instanceId]);

    const job = await seedQueuedJob(pool, { clientId, instanceId });

    const tenantDb = createTenantDb(pool);
    const claimOneAndReserve = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: fixedClock,
    });

    const result = await claimOneAndReserve(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'no-pacing-state-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    // undefined = "nothing claimable right now" (the same band-empty shape
    // a real pacing denial always resolves to - see send-loop.ts's own doc).
    expect(result).toBeUndefined();

    // The job is preserved queued, with the NO_LEDGER_ROW deny reason and a
    // bounded retry hold written back - never a thrown error, never lost,
    // attempts untouched (a pacing deferral never consumes retry budget).
    const jobRow = await pool.query<{
      status: string;
      attempts: number;
      pacing_deny_reason: string | null;
      next_attempt_at: Date;
    }>(
      'SELECT status, attempts, pacing_deny_reason, next_attempt_at FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');
    expect(jobRow.rows[0]?.attempts).toBe(0);
    expect(jobRow.rows[0]?.pacing_deny_reason).toBe('NO_LEDGER_ROW');
    expect(jobRow.rows[0]?.next_attempt_at.getTime()).toBeGreaterThan(fixedClock.now());

    // No ledger row was created anywhere - the reserve was skipped
    // entirely, never even attempted.
    const ledgerRows = await pool.query('SELECT 1 FROM pacing_ledger WHERE instance_id = $1', [
      instanceId,
    ]);
    expect(ledgerRows.rows).toEqual([]);
  });
});
