import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../../engine/pacing/__tests__/pacing-test-helpers.js';
import { evaluate } from './HealthEvaluator.js';
import { EVALUATOR_FIXTURE_NOW_MS, primeInstanceToWatch } from './__tests__/evaluator-fixtures.js';

/**
 * evaluator.integration.test.ts (P16 Unit C, step 6) - real PG, fake clock
 * injected via `HealthEvaluatorClock`. `signal_driven_tightening_reduces_
 * caps`'s exact-score arithmetic (documented per-tick, not asserted as a
 * bound - see the test's own comment) is copied verbatim from this unit's
 * dispatch note: only `rejected_send_rate` (weight 12) and `delivery_ratio`
 * (weight 20) are SCORED in v1 (32 weighted points total); landing WATCH
 * (score < 70) within 2 ticks from a HEALTHY start requires pre-seeding
 * `last_evidence` with prior severities of 1.0 for both scored ratio
 * signals (the instance has already been degrading before this test
 * window) - a fresh single tick from prior severity 0 (EWMA alpha=0.3)
 * cannot cross the WATCH threshold in 2 ticks, confirmed by hand
 * arithmetic in the dispatch. The shared send_attempts/message_jobs/
 * delivery_events seed lives in `__tests__/evaluator-fixtures.ts` (also
 * used by `evaluator-atomicity.integration.test.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'health-eval-test',
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
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const NOW_MS = EVALUATOR_FIXTURE_NOW_MS;

function fakeClock(startMs: number): { now: () => number; advanceMs: (n: number) => void } {
  let current = startMs;
  return { now: () => current, advanceMs: (n: number) => (current += n) };
}

describe('HealthEvaluator (P16 Unit C, real Postgres)', () => {
  it('signal_driven_tightening_reduces_caps', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      healthBand: 'healthy',
      healthState: 'connected',
    });
    await primeInstanceToWatch(pool, clientId, instanceId, NOW_MS);

    const clock = fakeClock(NOW_MS);

    // Tick 1: exact expected score per the dispatch's own hand arithmetic -
    // smoothed rejected = 0.3*1 + 0.7*1 = 1.0, smoothed delivery =
    // 0.3*0.875 + 0.7*1 = 0.9625, penalty = 12*1.0 + 20*0.9625 = 31.25,
    // score = 68.75 (WATCH: 55 <= score < 70).
    const tick1 = await tenantDb.withTenant(clientId, (tx) =>
      evaluate({ sql: tx, clientId, clock }, instanceId),
    );
    expect(tick1.score).toBeCloseTo(68.75, 5);
    expect(tick1.band).toBe('watch');
    expect(tick1.changed).toBe(true);

    clock.advanceMs(60_000);

    // Tick 2: smoothed rejected = 0.3*1 + 0.7*1.0 = 1.0, smoothed delivery =
    // 0.3*0.875 + 0.7*0.9625 = 0.93625, penalty = 12 + 18.725 = 30.725,
    // score = 69.275 (still WATCH).
    const tick2 = await tenantDb.withTenant(clientId, (tx) =>
      evaluate({ sql: tx, clientId, clock }, instanceId),
    );
    expect(tick2.score).toBeCloseTo(69.275, 5);
    expect(tick2.band).toBe('watch');

    const effRow = await pool.query<{ eff_daily_cap: number; eff_gap_min_ms: number }>(
      `SELECT eff_daily_cap, eff_gap_min_ms FROM instance_pacing_state WHERE instance_id = $1`,
      [instanceId],
    );
    // system profile daily_cap_ceiling=1000, tier-1 dailyCap=20 -> min=20,
    // WATCH capMultiplier=0.7 -> floor(20*0.7) = 14 (exact).
    expect(effRow.rows[0]?.eff_daily_cap).toBe(14);
    // system profile gap_min_floor_ms=15000, tier-1 gapMinMs=45000 -> max=45000,
    // WATCH gapMultiplier=1.5 -> ceil(45000*1.5) = 67500 (exact).
    expect(effRow.rows[0]?.eff_gap_min_ms).toBe(67500);

    const samples = await pool.query<{ band: string }>(
      `SELECT band FROM instance_health_samples WHERE instance_id = $1 ORDER BY created_at`,
      [instanceId],
    );
    expect(samples.rows.length).toBeGreaterThanOrEqual(1);
    expect(samples.rows[0]?.band).toBe('watch');
  });
});
