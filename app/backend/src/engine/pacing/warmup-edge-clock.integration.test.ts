import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';
import { runOnePacingEvaluatorSweep, type PacingEvaluatorPublish } from './warmup-evaluator.js';

/**
 * warmup-edge-clock.integration.test.ts (P13a warmup-ladder, C2/E3
 * hardening pass; FIX ROUND MAJOR 3) - clock-boundary cases (future/null
 * `warmup_started_at`, local-midnight boundary, a DST-history timezone) and
 * sweep resilience to one instance's evaluation throwing (now asserting the
 * CORRECT non-aborting behaviour). Split from `warmup-edge.integration.test.ts`
 * (300-line lint cap); see the concurrency/crash sibling file for the rest.
 */

let pool: TestPool;
let tenantDb: TenantDb;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'warmup-edge-clock-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 0, 1, 3, 0, 0);

function makeClock(startMs: number): { now: () => number; advanceDays: (n: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advanceDays: (n: number) => {
      current += n * DAY_MS;
    },
  };
}

function noopPublish(): PacingEvaluatorPublish {
  return vi.fn().mockResolvedValue(undefined);
}

async function readTier(instanceId: string): Promise<number> {
  const result = await pool.query<{ warmup_tier: number }>(
    'SELECT warmup_tier FROM instance_pacing_state WHERE instance_id = $1',
    [instanceId],
  );
  return result.rows[0]?.warmup_tier as number;
}

async function countEvents(instanceId: string, kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM pacing_events WHERE instance_id = $1 AND kind = $2',
    [instanceId, kind],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('warmup tier-change path - clock boundaries', () => {
  it('a_warmup_started_at_in_the_future_holds_never_advances_on_a_negative_day_count', async () => {
    const clock = makeClock(START_MS);
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(START_MS + 30 * DAY_MS), // starts 30 days in the future
      warmupTierSince: new Date(START_MS),
      healthBand: 'healthy',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });

    expect(await readTier(instanceId)).toBe(1);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(0);
  });

  it('a_null_warmup_started_at_holds_via_the_evaluator_sweep_not_just_the_pure_table', async () => {
    const clock = makeClock(START_MS);
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: null,
      warmupTierSince: null,
      healthBand: 'healthy',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });

    expect(await readTier(instanceId)).toBe(1);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('an_IST_instance_advances_at_local_midnight_not_UTC_midnight', async () => {
    // 2025-12-31 23:55 IST == 2025-12-31 18:25 UTC -> local calendar day 2
    // (started 2025-12-30 00:00 IST = day 1). Five minutes later crosses
    // 2026-01-01 00:00 IST -> local day 3 -> tier 2 (dayFrom 3) becomes due.
    const almostDay3Ist = Date.UTC(2025, 11, 31, 18, 25, 0);
    const startedAtIst = Date.UTC(2025, 11, 29, 18, 30, 0);
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(startedAtIst),
      warmupTierSince: new Date(startedAtIst),
      healthBand: 'healthy',
      pacingTimezone: 'Asia/Kolkata',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({
      pool,
      tenantDb,
      clock: { now: () => almostDay3Ist },
      publish,
      env: 'test',
    });
    expect(await readTier(instanceId)).toBe(1); // still local day 2, tier 2 not due yet

    const atDay3Ist = almostDay3Ist + 5 * 60 * 1000;
    await runOnePacingEvaluatorSweep({
      pool,
      tenantDb,
      clock: { now: () => atDay3Ist },
      publish,
      env: 'test',
    });
    expect(await readTier(instanceId)).toBe(2);
  });

  it('a_sao_paulo_instance_still_advances_on_the_correct_local_calendar_day', async () => {
    // Brazil abolished DST in 2019; a 2026 date exercises the SAME `Intl`
    // local-calendar-day code path (`elapsedLocalDays` reads Y/M/D parts,
    // never a raw ms offset) that a DST transition would also exercise,
    // pinned deterministically against a fixed offset (UTC-3) so the
    // assertion never depends on ambient DST-table behaviour.
    const startedAtUtc = Date.UTC(2026, 0, 1, 3, 0, 0); // 2026-01-01 00:00 America/Sao_Paulo
    const dueAtUtc = Date.UTC(2026, 0, 3, 3, 0, 0); // 2026-01-03 00:00 America/Sao_Paulo -> local day 3
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(startedAtUtc),
      warmupTierSince: new Date(startedAtUtc),
      healthBand: 'healthy',
      pacingTimezone: 'America/Sao_Paulo',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({
      pool,
      tenantDb,
      clock: { now: () => dueAtUtc },
      publish,
      env: 'test',
    });
    expect(await readTier(instanceId)).toBe(2);
  });
});

describe('warmup tier-change path - sweep resilience', () => {
  it('one_instance_with_a_corrupted_state_row_does_not_abort_the_whole_sweep', async () => {
    // FIX ROUND MAJOR 3: `evaluateOneInstance` calls `elapsedLocalDays` ->
    // `localDateParts`, which constructs `new Intl.DateTimeFormat('en-US',
    // { timeZone })` for the row's OWN `pacing_timezone` - an invalid IANA
    // zone string throws synchronously there, a realistic "corrupted state
    // row" trigger with no production-code changes needed (no CHECK
    // constraint validates `pacing_timezone` as a real IANA zone at the DB
    // level). `runOnePacingEvaluatorSweep`'s `for` loop now wraps
    // `evaluateOneInstance` in try/catch: a non-race-lost error is logged
    // (ids only) and counted in the sweep outcome, and the loop continues to
    // the next row - it must never abort the whole batch. This test does
    // not depend on Postgres's (unordered, `LIMIT`-only) row scan order to
    // prove that: it asserts the SECOND (healthy) instance's tier via a
    // fresh sweep after seeding the corrupted row FIRST, which fails
    // regardless of scan order if the loop still aborts early.
    const clock = makeClock(START_MS);
    const broken = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(START_MS - 5 * DAY_MS),
      warmupTierSince: new Date(START_MS - 5 * DAY_MS),
      healthBand: 'healthy',
      pacingTimezone: 'Not/A_Real_Zone',
    });

    const healthy = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(START_MS - 5 * DAY_MS), // day 6, tier 2 (dayFrom 3) is due
      warmupTierSince: new Date(START_MS - 5 * DAY_MS),
      healthBand: 'healthy',
    });

    const publish = noopPublish();

    // Expected (canon, hunt list item 6, now the ASSERTED behaviour): one
    // instance's evaluation throwing must not abort the sweep for other
    // instances - later instances still evaluated; the error surfaces in
    // the sweep outcome, not silently swallowed, and never rejects the
    // promise the cron loop awaits.
    const outcome = await runOnePacingEvaluatorSweep({
      pool,
      tenantDb,
      clock,
      publish,
      env: 'test',
    });

    expect(outcome.errors).toBeGreaterThanOrEqual(1);
    expect(outcome.scanned).toBeGreaterThanOrEqual(2);
    // The broken row's own timezone throw never mutated its state.
    expect(await readTier(broken.instanceId)).toBe(1);
    // The healthy row (seeded, and due for advance) is unaffected by the
    // broken row's failure, regardless of which one the scan reached first.
    expect(await readTier(healthy.instanceId)).toBe(2);
  });
});
