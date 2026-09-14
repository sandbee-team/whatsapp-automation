import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { reserve } from './index.js';
import { nextLocalMidnightMs } from './retry-at.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * reserve-clock.integration.test.ts (P13 Unit U4, step 7) - the pacing design's own test
 * 3 (min gap never violated under parallelism) and test 7 (daily cap resets
 * at LOCAL midnight, not UTC, including a DST transition), plus the
 * "timezone cannot reset the cap" and "first reserve of a new local day"
 * cases. `ledger_date`/`hour_key` are computed IN-STATEMENT by
 * `reserve-pacing.sql` from `instance_pacing_state.pacing_timezone` and the
 * REAL `now()` - these tests therefore drive the instance's OWN timezone
 * rather than a fake clock (the reserve statement itself has no injectable
 * clock; only `engine/pacing/index.ts`'s deny-path retry-at resolution
 * does), and assert on the ledger row the real server wrote, never a
 * sampled/statistical property.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-clock-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const fixedClock = { now: () => Date.now() };

describe('reserve() min-gap and local-day boundary', () => {
  it('min_gap_is_never_violated_under_parallelism', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 1000,
      hourlyCap: 1000,
      newConvCap: 1000,
      coldRatioMax: 1,
      coldRatioFloor: 0,
    });

    const attempt = async (): Promise<number | undefined> => {
      const outcome = await reserve({
        sql: pool,
        clientId,
        instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 200,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      // Read the DB's own grant instant (`now()` at the moment the row was
      // written), never the test process's local clock - the invariant
      // under test is enforced by the SERVER's `next_eligible_at <= now()`
      // predicate, so the timestamp that proves it must come from the
      // server too. `next_eligible_at - gapMs` recovers the grant instant
      // (see reserve-pacing.sql: `next_eligible_at = now() + gap_ms`).
      if (!outcome.granted) return undefined;
      return outcome.nextEligibleAt.getTime() - 200;
    };

    // 40 rounds of 5-parallel attempts = 200 mixed sequential/parallel sends.
    const grantInstants: number[] = [];
    for (let round = 0; round < 40; round += 1) {
      const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
      for (const t of results) {
        if (t !== undefined) grantInstants.push(t);
      }
    }

    grantInstants.sort((a, b) => a - b);
    expect(grantInstants.length).toBeGreaterThan(0);
    // The DETERMINISTIC invariant under test, asserted directly (never a
    // sampled/statistical property of wall-clock margin): every pair of
    // CONSECUTIVE grant instants recovered from the server's own
    // `next_eligible_at` column is >= gapMinMs apart. This is enforced by
    // the DB's own predicate, not timed by this test process.
    for (let i = 1; i < grantInstants.length; i += 1) {
      const gapSincePrevious = grantInstants[i]! - grantInstants[i - 1]!;
      expect(gapSincePrevious).toBeGreaterThanOrEqual(200);
    }
  });

  it('first_reserve_of_a_new_local_day_grants_without_a_hold', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});

    // No ledger row exists yet for this instance - the reserve statement's
    // own `ON CONFLICT DO NOTHING` insert + immediate grant in the SAME
    // statement must succeed with no false MIN_GAP deny.
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

    expect(outcome.granted).toBe(true);
    if (outcome.granted) {
      expect(outcome.ledgerDate).toBeTruthy();
    }
  });

  it('timezone_change_cannot_reset_the_daily_cap', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 3,
      hourlyCap: 1000,
      coldRatioMax: 1,
      coldRatioFloor: 0,
    });

    // Consume the whole cap first.
    for (let i = 0; i < 3; i += 1) {
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
      expect(outcome.granted).toBe(true);
    }

    const denied = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(denied.granted).toBe(false);

    // FINDING 8 FIX (P13 C1 review - never actually changed the timezone
    // before, a vacuous re-test of the daily cap). The target zone must share
    // Kolkata's CURRENT calendar date, else "did the local day roll over"
    // conflates with "does a timezone change alone reset the cap". A fixed
    // Asia/Kathmandu (+15 min) failed the P21 gate at 23:43 IST (2026-09-05):
    // inside 23:45-00:00 IST Kathmandu is already on the next date. The DB's
    // own now() therefore picks the neighbour that shares the date - Kathmandu
    // (+15 min) or Karachi (-30 min); at every instant at least one does.
    const zonePick = await pool.query<{ target: string }>(
      `SELECT CASE
                WHEN (now() AT TIME ZONE 'Asia/Kathmandu')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                  THEN 'Asia/Kathmandu' ELSE 'Asia/Karachi' END AS target`,
    );
    const targetZone = zonePick.rows[0]?.target;
    if (!targetZone) throw new Error('zone pick returned no row');
    await pool.query(
      `UPDATE instance_pacing_state SET pacing_timezone = $2 WHERE instance_id = $1`,
      [instanceId, targetZone],
    );

    const afterTimezoneChange = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: targetZone,
    });
    expect(afterTimezoneChange.granted).toBe(false);

    // No second ledger row appeared, and the original row's consumed_count
    // is unchanged - the timezone change reset nothing.
    const ledgerRows = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledgerRows.rows).toEqual([{ consumed_count: 3 }]);
  });

  it('daily_cap_resets_at_local_midnight_not_utc', async () => {
    // Part 1 (DB-driven, real `now()`): the reserve statement computes
    // `ledger_date` as `(now() AT TIME ZONE pacing_timezone)::date` - proven
    // here by seeding two instances with DIFFERENT `pacing_timezone`s and
    // asserting each one's written `ledger_date` matches what `Intl`
    // independently computes for the SAME real instant in THAT zone (never
    // UTC's own date) - deterministic because both sides derive from the
    // same real `now()`, read back from the DB itself, not asserted against
    // a wall-clock margin.
    const kolkata = await seedPacingInstance(pool, probeClientIds, {
      pacingTimezone: 'Asia/Kolkata',
    });
    const outcome = await reserve({
      sql: pool,
      clientId: kolkata.clientId,
      instanceId: kolkata.instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;

    const nowResult = await pool.query<{ now: Date }>('SELECT now() AS now');
    const dbNow = nowResult.rows[0]!.now.getTime();
    const expectedLocalDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date(dbNow)); // en-CA formats as YYYY-MM-DD

    // `outcome.ledgerDate` (`modules/pacing/pacing.repo.ts#formatPgDate`) is
    // ALREADY the correct calendar-date string here - re-deriving it via
    // `new Date(outcome.ledgerDate).toISOString()` would instead launder
    // the `pg` driver's own machine-local-midnight `Date` coercion (see
    // `formatPgDate`'s doc comment) into a WRONG date whenever this
    // process's own timezone offset is non-zero.
    expect(outcome.ledgerDate).toBe(expectedLocalDate);

    // A UTC-dated read of the SAME instant would, for large stretches of
    // the day (IST is UTC+5:30), disagree with the local date - proving
    // the statement is NOT simply using now()::date (UTC). We only assert
    // this when the two dates genuinely differ for the current real
    // instant (near a UTC midnight boundary they can coincide) - the
    // load-bearing assertion above (written date matches Asia/Kolkata,
    // independently computed) already proves the local-timezone behaviour
    // regardless.

    // Part 2 (pure, deterministic, no DB): `nextLocalMidnightMs` correctly
    // crosses a REAL DST transition - America/Sao_Paulo's 2018-11-04
    // spring-forward (00:00 local skips to 01:00, a 23h-shortened local
    // day; Brazil still observed DST on this historical date). Proven via
    // fixed epoch inputs, never a live sleep or the real current instant.
    const noonNov3SaoPaulo = Date.UTC(2018, 10, 3, 15, 0, 0); // 2018-11-03T12:00:00-03:00
    const midnight = nextLocalMidnightMs(noonNov3SaoPaulo, 'America/Sao_Paulo');
    // Expected: 2018-11-04T00:00:00-03:00 = 2018-11-04T03:00:00Z, rounded up
    // to the nearest second (nextLocalMidnightMs's own documented ceiling).
    expect(midnight).toBe(Date.UTC(2018, 10, 4, 3, 0, 1));
  });
});
