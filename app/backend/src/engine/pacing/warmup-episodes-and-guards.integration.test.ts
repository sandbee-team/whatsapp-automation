import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { WARMUP_LADDER, type HealthBand, type Layers, type PacingLayer } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';
import { updatePacingConfig } from './config-service.js';
import { runOnePacingEvaluatorSweep, type PacingEvaluatorPublish } from './warmup-evaluator.js';

/**
 * warmup-episodes-and-guards.integration.test.ts (P13a warmup-ladder, FIX
 * ROUND MAJOR 4 / MINOR 9) - split from `warmup.integration.test.ts` (300-
 * line file cap, same idiom as `warmup-edge-*.integration.test.ts`): multi-
 * episode degraded/rollback tests, tenant isolation, and paused/critical
 * integration coverage. `no_path_skips_the_ramp` (MINOR 8) is its own
 * further sibling, `warmup-no-path-skip.integration.test.ts` - that test's
 * property-half body alone is large enough to need the split. Small helper
 * duplication (`makeClock`/`noopPublish`/`readTier`/`countEvents`/layer
 * builders) is deliberate - the sibling edge-* files already establish
 * "each split file owns its own copy" over a shared cross-file import.
 */

let pool: TestPool;
let tenantDb: TenantDb;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'warmup-episodes-and-guards-tests',
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

async function readBand(instanceId: string): Promise<string> {
  const result = await pool.query<{ health_band: string }>(
    'SELECT health_band FROM instance_pacing_state WHERE instance_id = $1',
    [instanceId],
  );
  return result.rows[0]?.health_band as string;
}

async function countEvents(instanceId: string, kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM pacing_events WHERE instance_id = $1 AND kind = $2',
    [instanceId, kind],
  );
  return Number(result.rows[0]?.count ?? '0');
}

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

function warmupTierLayerForTier(tier: number): PacingLayer {
  const row = WARMUP_LADDER.find((t) => t.tier === tier) ?? WARMUP_LADDER[0]!;
  return {
    dailyCap: row.dailyCap,
    hourlyCap: row.hourlyCap,
    newConvCap: row.newConvCap,
    gapMinMs: row.gapMinMs,
    gapMaxMs: row.gapMaxMs,
    coldRatioMax: row.coldRatioMax,
    groupDailyCap: row.groupDailyCap,
  };
}

/** See `warmup.integration.test.ts`'s identical helper for the full FIX ROUND MAJOR 4 rationale. */
async function enterDegradedRealistic(
  clientId: string,
  instanceId: string,
  fromBand: HealthBand,
  tier: number,
  clock: { now(): number },
): Promise<void> {
  const layers: Layers = {
    systemProfile: systemProfileLayer(),
    warmupTier: warmupTierLayerForTier(tier),
    healthBand: 'degraded',
  };
  await updatePacingConfig({
    sql: pool,
    clientId,
    instanceId,
    kind: 'health_band',
    reason: 'test: enter degraded',
    layers,
    clock,
    fromHealthBand: fromBand,
  });
}

describe('runOnePacingEvaluatorSweep - multi-episode and cross-tenant', () => {
  it('a_second_degraded_episode_after_recovery_rolls_back_again', async () => {
    // FIX ROUND MAJOR 4's own missing test: degrade -> one rollback ->
    // healthy -> degrade again (no advance in between) -> exactly one MORE
    // rollback. Before the fix, the SECOND episode's rollback was
    // (incorrectly) considered "already satisfied" by the first episode's
    // WARMUP_ROLLBACK event via the old warmup_tier_since fallback anchor.
    const clock = makeClock(START_MS);
    // Seeded at elapsed day 2 (tier 1's window). After the first rollback
    // (tier 3 -> 2), tier 2 is not due to advance until day 3 (its own
    // dayFrom) - so the three small clock.advanceDays(1) ticks below (day 2
    // -> 3 -> 4) stay right at that boundary. To keep this test isolated to
    // the rollback-episode anchor (not the advance path, covered elsewhere),
    // `warmupStartedAt` is nudged so elapsed days never reaches 3 across the
    // whole test.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 3,
      warmupStartedAt: new Date(START_MS),
      warmupTierSince: new Date(START_MS - 1 * DAY_MS),
      healthBand: 'healthy',
    });
    const publish = noopPublish();

    // First episode: degrade -> one rollback (tier 3 -> 2).
    await enterDegradedRealistic(clientId, instanceId, 'healthy', 3, clock);
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(1);

    // Recover to healthy - no advance seeded, tier stays 2.
    clock.advanceDays(1);
    await updatePacingConfig({
      sql: pool,
      clientId,
      instanceId,
      kind: 'health_band',
      reason: 'test: recover to healthy',
      layers: {
        systemProfile: systemProfileLayer(),
        warmupTier: warmupTierLayerForTier(2),
        healthBand: 'healthy',
      },
      clock,
      fromHealthBand: 'degraded',
    });
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(1);

    // Second, genuinely NEW degraded episode - must roll back exactly once
    // more (tier 2 -> 1), not be silently satisfied by the first episode's
    // rollback event.
    clock.advanceDays(1);
    await enterDegradedRealistic(clientId, instanceId, 'healthy', 2, clock);
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(1);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(2);
  });

  it('tenant_a_degraded_never_touches_tenant_bs_tier', async () => {
    const clock = makeClock(START_MS);
    const a = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 3,
      warmupStartedAt: new Date(START_MS - 20 * DAY_MS),
      warmupTierSince: new Date(START_MS - 1 * DAY_MS),
      healthBand: 'healthy',
    });
    await enterDegradedRealistic(a.clientId, a.instanceId, 'healthy', 3, clock);
    const b = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 3,
      warmupStartedAt: new Date(START_MS - 20 * DAY_MS),
      warmupTierSince: new Date(START_MS - 1 * DAY_MS),
      healthBand: 'healthy',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });

    expect(await readTier(a.instanceId)).toBe(2);
    expect(await readBand(b.instanceId)).toBe('healthy');
    expect(await readTier(b.instanceId)).toBe(4);
  });

  it('a_due_for_advance_but_paused_instance_holds_with_no_event_and_no_publish', async () => {
    // MINOR 9 - paused-instance skip, at the integration level (fixture
    // supports healthState: 'paused').
    const clock = makeClock(START_MS);
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(START_MS - 5 * DAY_MS), // day 6, tier 2 (dayFrom 3) is due
      warmupTierSince: new Date(START_MS - 5 * DAY_MS),
      healthBand: 'healthy',
      healthState: 'paused',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });

    expect(await readTier(instanceId)).toBe(1);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a_critical_band_instance_neither_advances_nor_rolls_back', async () => {
    // MINOR 9 - CRITICAL band, at the integration level (fixture supports
    // healthBand: 'critical'). Due for advance AND nominally degraded-shaped
    // (would be rollback-eligible under `degraded`) but CRITICAL freezes
    // both directions - P16's territory, this evaluator does nothing.
    const clock = makeClock(START_MS);
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 3,
      warmupStartedAt: new Date(START_MS - 20 * DAY_MS),
      warmupTierSince: new Date(START_MS - 1 * DAY_MS),
      healthBand: 'critical',
    });
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });

    expect(await readTier(instanceId)).toBe(3);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(0);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});
