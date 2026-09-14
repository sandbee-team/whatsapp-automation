import { createPool } from '@wp/db';
import { WARMUP_LADDER, type Layers, type PacingLayer } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';
import { updatePacingConfig, WarmupTierRaceLostError } from './config-service.js';

/**
 * warmup-edge-concurrency.integration.test.ts (P13a warmup-ladder, C2/E3
 * hardening pass) - double-claim races, replay-after-crash, and the
 * mid-"transaction" crash probe over `updatePacingConfig`'s `warmup_tier`
 * path. Split from `warmup-edge.integration.test.ts` (300-line lint cap);
 * see the clock-boundaries/sweep-resilience sibling file for the rest.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'warmup-edge-concurrency-tests',
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

const START_MS = Date.UTC(2026, 0, 1, 3, 0, 0);
const fixedClock = { now: () => START_MS };

function systemProfileLayer(): PacingLayer {
  return {
    dailyCap: 1000,
    hourlyCap: 200,
    newConvCap: 500,
    gapMinMs: 15_000,
    gapMaxMs: 600_000,
    coldRatioMax: 0.8,
    coldRatioFloor: 5,
    groupDailyCap: 50,
    window: { startLocal: '00:00:00', endLocal: '23:59:59' },
  };
}

function warmupTierLayer(dailyCap: number): PacingLayer {
  const tier1 = WARMUP_LADDER[0]!;
  return {
    dailyCap,
    hourlyCap: tier1.hourlyCap,
    newConvCap: tier1.newConvCap,
    gapMinMs: tier1.gapMinMs,
    gapMaxMs: tier1.gapMaxMs,
    coldRatioMax: tier1.coldRatioMax,
    groupDailyCap: tier1.groupDailyCap,
  };
}

function layers(dailyCap: number): Layers {
  return {
    systemProfile: systemProfileLayer(),
    warmupTier: warmupTierLayer(dailyCap),
    healthBand: 'healthy',
  };
}

async function readTier(instanceId: string): Promise<number> {
  const result = await pool.query<{ warmup_tier: number }>(
    'SELECT warmup_tier FROM instance_pacing_state WHERE instance_id = $1',
    [instanceId],
  );
  return result.rows[0]?.warmup_tier as number;
}

async function readConfigVersion(instanceId: string): Promise<number> {
  const result = await pool.query<{ config_version: number }>(
    'SELECT config_version FROM instance_pacing_state WHERE instance_id = $1',
    [instanceId],
  );
  return result.rows[0]?.config_version as number;
}

async function countEvents(instanceId: string, kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM pacing_events WHERE instance_id = $1 AND kind = $2',
    [instanceId, kind],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countAudit(instanceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_logs
      WHERE target_id = $1 AND action = 'pacing.config.change'`,
    [instanceId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('warmup tier-change path - concurrency', () => {
  it('two_concurrent_advance_attempts_on_the_same_instance_exactly_one_wins', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
    });

    const attempt = () =>
      updatePacingConfig({
        sql: pool,
        clientId,
        instanceId,
        kind: 'warmup_tier',
        reason: 'race probe',
        layers: layers(50),
        clock: fixedClock,
        expectedFromWarmupTier: 1,
        toWarmupTier: 2,
        reasonCodes: ['test_race'],
        evidence: {},
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WarmupTierRaceLostError);

    // Exactly one tier change, one event, one config_version bump - the
    // loser wrote nothing (no event, no audit row, no eff_* change).
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(1);
    expect(await countAudit(instanceId)).toBe(1);
    expect(await readConfigVersion(instanceId)).toBe(2);
  });

  it('a_replayed_apply_of_the_same_stale_from_tier_is_a_clean_no_op', async () => {
    // Simulates an evaluator tick re-run after a crash BETWEEN commit and
    // metrics/publish: the tier already advanced once, so a second call
    // with the SAME (now-stale) expectedFromWarmupTier must reject cleanly
    // with no duplicate event and no additional config_version bump.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
    });

    const call = () =>
      updatePacingConfig({
        sql: pool,
        clientId,
        instanceId,
        kind: 'warmup_tier',
        reason: 'replay probe',
        layers: layers(50),
        clock: fixedClock,
        expectedFromWarmupTier: 1,
        toWarmupTier: 2,
        reasonCodes: ['test_replay'],
        evidence: {},
      });

    await call();
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(1);
    const versionAfterFirst = await readConfigVersion(instanceId);

    await expect(call()).rejects.toBeInstanceOf(WarmupTierRaceLostError);

    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(1);
    expect(await countAudit(instanceId)).toBe(1);
    expect(await readConfigVersion(instanceId)).toBe(versionAfterFirst);
  });
});

describe('warmup tier-change path - crash mid "transaction"', () => {
  it('a_failure_after_the_tier_UPDATE_but_before_the_event_insert_leaves_a_tier_change_with_no_event', async () => {
    // REAL BUG PROBE (not a workaround): config-service.ts's module doc
    // claims "Every change is ONE transaction" for the warmup_tier path,
    // but `updatePacingConfig` is invoked with `sql: pool` (a raw pg.Pool)
    // everywhere in production (see warmup-evaluator.ts's
    // `evaluateOneInstance` and cron-wiring.ts's `pacingEvaluatorLoop`) -
    // there is no BEGIN/COMMIT wrapping the tier UPDATE + audit INSERT +
    // event INSERT sequence. Forcing the LAST statement
    // (`insertWarmupTierEvent`'s `JSON.stringify(input.evidence)`) to throw
    // via a circular-reference `evidence` object proves whether the earlier
    // writes were rolled back with it, as the doc promises, or already
    // durably committed on their own pooled connections.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      updatePacingConfig({
        sql: pool,
        clientId,
        instanceId,
        kind: 'warmup_tier',
        reason: 'poisoned evidence probe',
        layers: layers(50),
        clock: fixedClock,
        expectedFromWarmupTier: 1,
        toWarmupTier: 2,
        reasonCodes: ['test_poison'],
        evidence: circular,
      }),
    ).rejects.toThrow(/circular/i);

    // Invariant this module's own doc promises: "no tier change without its
    // event, no event without its tier change". If this fails, the tier
    // UPDATE (and its audit row) committed independently of the event
    // insert that failed after it - a real atomicity gap, not a test bug.
    const tierAfter = await readTier(instanceId);
    const eventCount = await countEvents(instanceId, 'WARMUP_ADVANCE');
    const auditCount = await countAudit(instanceId);
    expect({ tierAfter, eventCount, auditCount }).toEqual({
      tierAfter: 1,
      eventCount: 0,
      auditCount: 0,
    });
  });
});
