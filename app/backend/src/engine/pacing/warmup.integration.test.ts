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
 * warmup.integration.test.ts (P13a warmup-ladder Unit U1, step 1; FIX ROUND
 * MAJOR 4 / MINOR 9) - proves `runOnePacingEvaluatorSweep` advances/freezes/
 * rolls back the warm-up ladder purely on elapsed time + health band +
 * hard-signal evidence, NEVER on reply data (none exists anywhere in this
 * suite), with every applied change fully audited and the panel
 * notification port called. The `no_path_skips_the_ramp` static+property
 * test lives in the sibling `warmup-no-path-skip.integration.test.ts` (300-
 * line file cap split, same idiom as `warmup-edge-*.integration.test.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'warmup-evaluator-tests',
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
const START_MS = Date.UTC(2026, 0, 1, 3, 0, 0); // 08:30 IST on 2026-01-01

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

/**
 * FIX ROUND MAJOR 4 - the REALISTIC way to move an instance into `degraded`:
 * through `updatePacingConfig({kind:'health_band'})`, which (this fix round)
 * writes the `BAND_CHANGE` `pacing_events` row `isDegradedRollbackDue` reads
 * as its episode anchor. A direct fixture override of `health_band` no
 * longer produces a rollback-eligible episode - this is intentional
 * (fail-safe: an un-anchored `degraded` band HOLDs rather than guessing).
 */
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

async function seedHardSignal(instanceId: string, clientId: string, ageMs: number): Promise<void> {
  await pool.query(
    `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, reason_codes, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'hard_signal_pause', '{}', '{}', now() - ($3 || ' milliseconds')::interval)`,
    [clientId, instanceId, ageMs],
  );
}

describe('runOnePacingEvaluatorSweep', () => {
  it('warmup_progresses_on_time_not_on_reply_rate', async () => {
    const clock = makeClock(START_MS);
    const { instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupStartedAt: new Date(START_MS),
      warmupTierSince: new Date(START_MS),
      healthBand: 'healthy',
    });
    const publish = noopPublish();

    // 40 simulated days, stepping the clock one day at a time and running
    // the evaluator each tick - NOTHING in this test seeds any reply/message
    // data at all, proving tier advancement depends only on elapsed time +
    // health band, never on reply rate.
    for (let day = 0; day < 40; day += 1) {
      await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
      clock.advanceDays(1);
    }

    expect(await readTier(instanceId)).toBe(6);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(WARMUP_LADDER.length - 1);
    expect(await countAudit(instanceId)).toBe(WARMUP_LADDER.length - 1);
    expect(publish).toHaveBeenCalled();
  });

  it('warmup_freezes_in_watch_and_rolls_back_in_degraded', async () => {
    const clock = makeClock(START_MS);
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 2,
      warmupStartedAt: new Date(START_MS - 10 * DAY_MS),
      warmupTierSince: new Date(START_MS - 5 * DAY_MS),
      healthBand: 'watch',
    });
    const publish = noopPublish();

    // WATCH: due for tier 3 (day 8) many times over - never advances.
    for (let i = 0; i < 5; i += 1) {
      await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
      clock.advanceDays(3);
    }
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(0);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(0);

    // DEGRADED (realistic episode, via updatePacingConfig - see
    // enterDegradedRealistic's own doc, FIX ROUND MAJOR 4): exactly one
    // tier back.
    await enterDegradedRealistic(clientId, instanceId, 'watch', 2, clock);
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(1);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(1);
  });

  it('a_hard_restriction_signal_in_the_last_24h_blocks_advancement', async () => {
    const clock = makeClock(START_MS);
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(START_MS - 5 * DAY_MS), // day 6, tier 2 (dayFrom 3) is due
      warmupTierSince: new Date(START_MS - 5 * DAY_MS),
      healthBand: 'healthy',
    });
    const publish = noopPublish();

    await seedHardSignal(instanceId, clientId, 60 * 60 * 1000); // 1h old
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(1);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(0);

    // Same signal, now 25h old - no longer blocks.
    await pool.query(
      `UPDATE pacing_events SET created_at = now() - interval '25 hours'
        WHERE instance_id = $1 AND kind = 'hard_signal_pause'`,
      [instanceId],
    );
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ADVANCE')).toBe(1);
  });

  it('degraded_rolls_back_exactly_once_per_episode_not_per_tick', async () => {
    const clock = makeClock(START_MS);
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 3,
      warmupStartedAt: new Date(START_MS - 20 * DAY_MS),
      warmupTierSince: new Date(START_MS - 1 * DAY_MS),
      healthBand: 'healthy',
    });
    await enterDegradedRealistic(clientId, instanceId, 'healthy', 3, clock);
    const publish = noopPublish();

    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(1);

    // A SECOND consecutive tick, still degraded - must NOT roll back again.
    clock.advanceDays(1);
    await runOnePacingEvaluatorSweep({ pool, tenantDb, clock, publish, env: 'test' });
    expect(await readTier(instanceId)).toBe(2);
    expect(await countEvents(instanceId, 'WARMUP_ROLLBACK')).toBe(1);
  });
});
