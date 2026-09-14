import { createPool } from '@wp/db';
import { WARMUP_LADDER, type PacingLayer } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mulberry32 } from '../../modules/queue/__tests__/crash-injector.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';
import { updatePacingConfig, type ConfigChangeKind } from './config-service.js';

/**
 * warmup-no-path-skip.integration.test.ts (P13a warmup-ladder, FIX ROUND
 * MINOR 8) - split from `warmup-episodes-and-guards.integration.test.ts`
 * (300-line file cap): the `no_path_skips_the_ramp` static+property test on
 * its own, since its property-half body (one `updatePacingConfig` call per
 * `ConfigChangeKind` other than `warmup_tier`) is large enough alone to need
 * the split.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'warmup-no-path-skip-tests',
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

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 0, 1, 3, 0, 0);

function makeClock(startMs: number): { now: () => number } {
  return { now: () => startMs };
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

describe('no_path_skips_the_ramp', () => {
  it('no_path_skips_the_ramp', async () => {
    // Static half (FIX ROUND MINOR 8 correction, narrowed P17 U6): the
    // invariant this guards is "no API field SETS warmup_tier outside the
    // audited `updatePacingConfig({kind:'warmup_tier'})` path" (P13a) - i.e.
    // no MUTATION-INPUT contract may carry a `warmupTier`/`warmup_tier`
    // field a caller could populate. It is not about read-only response
    // data: `GET /v1/instances/:id/card` (`instanceCardDataSchema`,
    // P17 U2/U4) legitimately exposes the current tier for display,
    // exactly like it already exposes `healthBand`/`healthScore`/
    // `effDailyCap` - all internal pacing state, read-only. Walk every
    // exported Zod schema whose OWN export name marks it as an input
    // contract (`*InputSchema`, this package's consistent convention - see
    // `ackFanoutInputSchema`, `createMessageInputSchema`, etc.) and assert
    // none of them carry the field, by shape and by name.
    const contractsModule = await import('@wp/contracts');
    const inputSchemaEntries = Object.entries(contractsModule).filter(([exportName, value]) => {
      return (
        exportName.endsWith('InputSchema') &&
        !!value &&
        typeof value === 'object' &&
        'safeParse' in value
      );
    });
    expect(inputSchemaEntries.length).toBeGreaterThan(0);
    for (const [exportName, value] of inputSchemaEntries) {
      const shape = (value as { shape?: unknown }).shape;
      if (shape && typeof shape === 'object') {
        const keys = Object.keys(shape).map((k) => k.toLowerCase());
        expect(keys, exportName).not.toContain('warmuptier');
        expect(keys, exportName).not.toContain('warmup_tier');
      }
    }
    const inputSchemaNames = JSON.stringify(inputSchemaEntries.map(([exportName]) => exportName));
    expect(inputSchemaNames.toLowerCase()).not.toContain('warmuptier');

    // Property half (FIX ROUND MINOR 8 correction): iterate every
    // `ConfigChangeKind` EXCEPT `warmup_tier` with seeded-PRNG-generated
    // layer/patch inputs (mulberry32, this repo's own deterministic-PRNG
    // idiom - modules/queue/__tests__/crash-injector.ts) through
    // `updatePacingConfig` directly, and assert `warmup_tier` is
    // byte-identical after each - only a `kind: 'warmup_tier'` call (the
    // evaluator's own path) may ever move it.
    const rng = mulberry32(0xc0ffee);
    const randInt = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      warmupTier: 3,
      warmupStartedAt: new Date(START_MS - 100 * DAY_MS),
      warmupTierSince: new Date(START_MS - 100 * DAY_MS),
      healthBand: 'healthy',
    });
    const clock = makeClock(START_MS);
    const baseProfile = systemProfileLayer();
    const baseWarmup = warmupTierLayerForTier(3);

    const otherKinds: Exclude<ConfigChangeKind, 'warmup_tier'>[] = [
      'profile',
      'health_band',
      'tenant_tighten',
      'admin_relax',
      'timezone',
    ];

    for (const kind of otherKinds) {
      const dailyCapJitter = randInt(1, 50);
      if (kind === 'health_band') {
        await updatePacingConfig({
          sql: pool,
          clientId,
          instanceId,
          kind,
          reason: `test: random ${kind}`,
          layers: { systemProfile: baseProfile, warmupTier: baseWarmup, healthBand: 'watch' },
          clock,
          fromHealthBand: 'healthy',
        });
      } else if (kind === 'tenant_tighten') {
        await updatePacingConfig({
          sql: pool,
          clientId,
          instanceId,
          kind,
          reason: `test: random ${kind}`,
          layers: {
            systemProfile: baseProfile,
            warmupTier: baseWarmup,
            healthBand: 'healthy',
            tenantTightening: { dailyCap: baseWarmup.dailyCap! - dailyCapJitter },
          },
          clock,
        });
      } else if (kind === 'admin_relax') {
        await updatePacingConfig({
          sql: pool,
          clientId,
          instanceId,
          kind,
          reason: `test: random ${kind}`,
          actorUserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          layers: {
            systemProfile: baseProfile,
            warmupTier: baseWarmup,
            healthBand: 'healthy',
            adminOverride: {
              ...baseWarmup,
              dailyCap: baseWarmup.dailyCap! + dailyCapJitter,
              actorUserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              reason: 'randomised admin relax probe',
              expiresAt: null,
            },
          },
          clock,
        });
      } else if (kind === 'timezone') {
        await updatePacingConfig({
          sql: pool,
          clientId,
          instanceId,
          kind,
          reason: `test: random ${kind}`,
          layers: { systemProfile: baseProfile, warmupTier: baseWarmup, healthBand: 'healthy' },
          newTimezone: rng() > 0.5 ? 'Asia/Kolkata' : 'America/Sao_Paulo',
          clock,
        }).catch(() => undefined); // may hit the 7-day rate limit on a repeat seed - irrelevant to this assertion
      } else {
        await updatePacingConfig({
          sql: pool,
          clientId,
          instanceId,
          kind,
          reason: `test: random ${kind}`,
          layers: { systemProfile: baseProfile, warmupTier: baseWarmup, healthBand: 'healthy' },
          clock,
        });
      }
      expect(await readTier(instanceId), kind).toBe(3);
    }

    // Every recorded audit row is actor-attributable (system or a real user).
    const audit = await pool.query<{ actor_type: string }>(
      `SELECT actor_type FROM audit_logs WHERE target_id = $1 AND action = 'pacing.config.change'`,
      [instanceId],
    );
    for (const row of audit.rows) {
      expect(['user', 'system']).toContain(row.actor_type);
    }
  });
});
