import { createPool } from '@wp/db';
import { WARMUP_LADDER, type Layers, type PacingLayer } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { reserve } from './index.js';
import { updatePacingConfig } from './config-service.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * config-service.integration.test.ts (P13 Unit U4, step 6) - the two named
 * tests: a committed config change takes effect on the VERY NEXT reserve
 * (no cache window, because `reserve-pacing.sql` reads `eff_*` in-statement
 * every time), and every config change writes an audit row + bumps
 * `config_version` - no silent limit change anywhere.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-config-tests',
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

const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

const tier1 = WARMUP_LADDER[0]!;

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

describe('PacingConfigService.update()', () => {
  it('tightening_takes_effect_on_the_very_next_reserve', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 20,
    });

    // Consume the seeded cap (20) is unnecessary - directly tighten to 1
    // and prove the reserve that follows IMMEDIATELY (same connection, no
    // wait, no cache warmup) obeys the new cap with no transition window.
    const result = await updatePacingConfig({
      sql: pool,
      clientId,
      instanceId,
      kind: 'warmup_tier',
      reason: 'test: tighten to 1/day',
      layers: layers(1),
      clock: fixedClock,
    });
    expect(result.effective.eff_daily_cap).toBe(1);

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

    // The SECOND reserve, on the SAME connection, immediately after -
    // no cache, no delay - must already see the tightened cap=1 and deny.
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
  });

  it('every_config_change_writes_an_audit_row_and_bumps_config_version', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 20,
    });

    const before = await pool.query<{ config_version: number }>(
      'SELECT config_version FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(before.rows[0]?.config_version).toBe(1);

    const result = await updatePacingConfig({
      sql: pool,
      clientId,
      instanceId,
      kind: 'warmup_tier',
      reason: 'test: advance tier',
      actorUserId: null,
      layers: layers(50),
      clock: fixedClock,
    });
    expect(result.configVersion).toBe(2);

    const after = await pool.query<{ config_version: number; eff_daily_cap: number }>(
      'SELECT config_version, eff_daily_cap FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(after.rows[0]?.config_version).toBe(2);
    expect(after.rows[0]?.eff_daily_cap).toBe(50);

    const audit = await pool.query<{ action: string; target_id: string; metadata: unknown }>(
      `SELECT action, target_id, metadata FROM audit_logs
        WHERE client_id = $1 AND action = 'pacing.config.change' ORDER BY created_at DESC LIMIT 1`,
      [clientId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.target_id).toBe(instanceId);
    const metadata = audit.rows[0]?.metadata as { field: string; reason: string } | undefined;
    expect(metadata?.field).toBe('warmup_tier');
    expect(metadata?.reason).toBe('test: advance tier');

    const events = await pool.query<{ kind: string }>(
      `SELECT kind FROM pacing_events WHERE client_id = $1 AND instance_id = $2 AND kind = 'CONFIG_CHANGE'`,
      [clientId, instanceId],
    );
    expect(events.rows).toHaveLength(1);

    // A SECOND change bumps the version again - never a silent no-op.
    const secondResult = await updatePacingConfig({
      sql: pool,
      clientId,
      instanceId,
      kind: 'warmup_tier',
      reason: 'test: advance tier again',
      layers: layers(80),
      clock: fixedClock,
    });
    expect(secondResult.configVersion).toBe(3);
  });
});
