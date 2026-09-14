import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../../../engine/pacing/__tests__/pacing-test-helpers.js';
import { evaluate } from './HealthEvaluator.js';
import { EVALUATOR_FIXTURE_NOW_MS } from './__tests__/evaluator-fixtures.js';

/**
 * evaluator-loosening.integration.test.ts (P16 fix round, WARNING 5 - split
 * out of evaluator-atomicity.integration.test.ts for max-lines discipline,
 * same sibling-module split idiom as session-worker-discovery-wiring.ts -
 * not a behavioural boundary) - real PG, fake clock. Proves
 * `HealthEvaluator.ts#writeBookkeeping` now writes `last_band_improved_at`
 * on a real LOOSENING tick decided through `evaluate()`'s own scoring +
 * `bands.ts#decideBand` path (never a direct `applyBandChange` call).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'health-eval-loosening-test',
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
  }
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const NOW_MS = EVALUATOR_FIXTURE_NOW_MS;

function fakeClock(startMs: number): { now: () => number } {
  return { now: () => startMs };
}

describe('HealthEvaluator loosening bookkeeping (P16 fix round, real Postgres)', () => {
  it('a_loosening_tick_writes_last_band_improved_at', async () => {
    // WARNING 5 fix: `last_band_improved_at` is read by HealthEvaluator.ts
    // but was never written anywhere - denormalized display data only (the
    // budget authority for the anti-flap caps stays `pacing_events`
    // BAND_CHANGE rows, read via `recentBandChanges`, module doc unchanged).
    // Seed the instance already at WATCH, with its own band-since 2h in the
    // past (dwell satisfied) and no hard signal, then give it a perfectly
    // clean (zero-send) evidence window - every ratio signal is
    // 'unmeasured', the three always-measured count signals score 0
    // severity, so this tick's score is exactly 100 (>= 78, the WATCH ->
    // HEALTHY hysteresis floor) - a real loosening decision, not a direct
    // `applyBandChange` call.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      healthBand: 'watch',
      healthState: 'connected',
    });
    await pool.query(
      `UPDATE instance_pacing_state SET health_band_since = $2 WHERE instance_id = $1`,
      [instanceId, new Date(NOW_MS - 3 * 60 * 60 * 1000)],
    );

    const tick = await tenantDb.withTenant(clientId, (tx) =>
      evaluate({ sql: tx, clientId, clock: fakeClock(NOW_MS) }, instanceId),
    );
    expect(tick.score).toBe(100);
    expect(tick.band).toBe('healthy');
    expect(tick.changed).toBe(true);

    const stateRow = await pool.query<{ last_band_improved_at: Date | null }>(
      `SELECT last_band_improved_at FROM instance_pacing_state WHERE instance_id = $1`,
      [instanceId],
    );
    expect(stateRow.rows[0]?.last_band_improved_at?.getTime()).toBe(NOW_MS);
  });
});
