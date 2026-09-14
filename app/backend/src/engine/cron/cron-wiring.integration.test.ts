import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from '../pacing/__tests__/pacing-test-helpers.js';
import { runOnePacingEvaluatorSweep } from '../pacing/warmup-evaluator.js';
import { buildOutboxPacingPublish, type CronWiringPool } from './cron-wiring.js';

/**
 * cron-wiring.integration.test.ts (P17 U6, step 8) - proves
 * `buildOutboxPacingPublish` (the pacing-evaluator loop's default
 * `pacingPublish`, no longer `NOOP_PACING_PUBLISH`) actually lands an
 * `outbox_events` row for `instance.pacing_changed` on a real tier change,
 * against real Postgres. Drives `runOnePacingEvaluatorSweep` directly with
 * an injected fixed clock (never a real wall clock - `wp_warmup_scan_due`'s
 * own cross-tenant, unscoped-by-client scan means this suite must never
 * assert on the SCAN's total row count, only on THIS fixture's own
 * client_id/instance_id-scoped rows, exactly like every other cross-tenant-
 * scan test in this tree).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'cron-wiring-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

describe('buildOutboxPacingPublish (P17 U6, real Postgres)', () => {
  it('a_real_tier_change_lands_an_outbox_row_for_instance_pacing_changed', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 1,
      warmupStartedAt: new Date(FIXED_NOW_MS - 4 * DAY_MS),
      warmupTierSince: new Date(FIXED_NOW_MS - 4 * DAY_MS),
      healthBand: 'healthy',
    });

    // wp_warmup_scan_due's own scan is cross-tenant and unscoped (migration
    // 0034's own header) - this suite therefore never asserts on the
    // sweep's aggregate outcome (another concurrently-running suite's own
    // leftover/mid-transaction row could legitimately count as an `errors`
    // increment that has nothing to do with THIS fixture); only the two
    // client_id/instance_id-scoped queries below are the real proof.
    await runOnePacingEvaluatorSweep({
      pool,
      tenantDb,
      clock: { now: () => FIXED_NOW_MS },
      publish: buildOutboxPacingPublish(pool as unknown as CronWiringPool),
      env: 'test',
      limit: 5000,
    });

    const tierRow = await pool.query<{ warmup_tier: number }>(
      'SELECT warmup_tier FROM instance_pacing_state WHERE instance_id = $1 AND client_id = $2',
      [instanceId, clientId],
    );
    expect(tierRow.rows[0]?.warmup_tier).toBe(2);

    const outboxRows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events
        WHERE client_id = $1 AND instance_id = $2 AND event_type = 'instance.pacing_changed'`,
      [clientId, instanceId],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0]?.payload).toMatchObject({ instanceId });
  }, 30_000);
});
