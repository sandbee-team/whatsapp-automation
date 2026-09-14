import { describe, expect, it } from 'vitest';
import { ABSOLUTE_DAILY_CEILING, ABSOLUTE_GAP_MIN_MS } from './constants.js';
import { resolveEffective, type Layers, type PacingLayer } from './resolve-effective.js';
import type { HealthBand } from './warmup-ladder.js';

/** mulberry32 - small, deterministic, seeded PRNG (see gap-jitter.test.ts for the same idiom). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SYSTEM_PROFILE: PacingLayer = {
  dailyCap: 1_000,
  hourlyCap: 80,
  newConvCap: 150,
  gapMinMs: 15_000,
  gapMaxMs: 60_000,
  coldRatioMax: 0.8,
  coldRatioFloor: 5,
  perRecipient24h: 1,
  groupDailyCap: 50,
  window: { startLocal: '08:00', endLocal: '20:00' },
  blockLinkFirst: false,
  blockGroupActions: false,
};

const BASE_WARMUP_TIER: PacingLayer = {
  dailyCap: 600,
  hourlyCap: 80,
  newConvCap: 150,
  gapMinMs: 15_000,
  gapMaxMs: 60_000,
  coldRatioMax: 0.8,
  coldRatioFloor: 5,
  groupDailyCap: 30,
  window: { startLocal: '08:00', endLocal: '20:00' },
  blockLinkFirst: false,
  blockGroupActions: false,
};

const BANDS: readonly HealthBand[] = ['healthy', 'watch', 'degraded', 'critical'];

describe('resolveEffective', () => {
  it('tenant_can_tighten_never_loosen', () => {
    const rng = mulberry32(1234);
    const iterations = 2_000;

    for (let i = 0; i < iterations; i += 1) {
      const band = BANDS[Math.floor(rng() * BANDS.length)] ?? 'healthy';

      // A random tenant patch: only ever TIGHTENS (lower caps, longer gaps)
      // relative to the system profile ceiling - modelling what the API
      // layer is allowed to accept from a tenant.
      const tenantTightening: PacingLayer = {
        dailyCap: Math.floor(rng() * BASE_SYSTEM_PROFILE.dailyCap!),
        gapMinMs: BASE_SYSTEM_PROFILE.gapMinMs! + Math.floor(rng() * 50_000),
      };

      // A random admin override, which MAY try to loosen past the ceiling
      // (that is exactly the case the absolute clamp must still catch).
      const adminOverride =
        rng() < 0.5
          ? undefined
          : {
              actorUserId: 'admin-1',
              reason: 'load test',
              expiresAt: null,
              dailyCap: Math.floor(rng() * 5_000), // may exceed ABSOLUTE_DAILY_CEILING
              gapMinMs: Math.floor(rng() * 20_000), // may be below the floor
            };

      const layers: Layers = {
        systemProfile: BASE_SYSTEM_PROFILE,
        warmupTier: BASE_WARMUP_TIER,
        healthBand: band,
        tenantTightening,
        adminOverride,
      };

      const result = resolveEffective(layers);

      expect(result.dailyCap).toBeLessThanOrEqual(ABSOLUTE_DAILY_CEILING);
      expect(result.gapMinMs).toBeGreaterThanOrEqual(ABSOLUTE_GAP_MIN_MS);
    }
  });

  it('folds_strictest_wins_across_layers_exact_values', () => {
    const layers: Layers = {
      systemProfile: {
        dailyCap: 1_000,
        hourlyCap: 80,
        newConvCap: 150,
        gapMinMs: 15_000,
        gapMaxMs: 60_000,
        coldRatioFloor: 5,
        coldRatioMax: 0.8,
        groupDailyCap: 50,
      },
      warmupTier: {
        dailyCap: 600,
        hourlyCap: 80,
        newConvCap: 150,
        gapMinMs: 20_000,
        gapMaxMs: 60_000,
        coldRatioFloor: 5,
        coldRatioMax: 0.75,
        groupDailyCap: 30,
      },
      healthBand: 'healthy',
      tenantTightening: { dailyCap: 400, gapMinMs: 18_000 },
    };
    const result = resolveEffective(layers);
    // strictest: min(1000,600,400)=400; max(15000,20000,18000)=20000; min cold ratio max 0.75.
    expect(result.dailyCap).toBe(400);
    expect(result.gapMinMs).toBe(20_000);
    expect(result.coldRatioMax).toBe(0.75);
    expect(result.coldRatioFloor).toBe(5);
  });

  it('health_band_multiplier_applies_exact_value_watch', () => {
    const layers: Layers = {
      systemProfile: {
        dailyCap: 1_000,
        hourlyCap: 80,
        newConvCap: 150,
        gapMinMs: 15_000,
        gapMaxMs: 60_000,
        coldRatioFloor: 5,
        coldRatioMax: 0.8,
        groupDailyCap: 50,
      },
      warmupTier: {
        dailyCap: 600,
        hourlyCap: 80,
        newConvCap: 150,
        gapMinMs: 15_000,
        gapMaxMs: 60_000,
        coldRatioFloor: 5,
        coldRatioMax: 0.8,
        groupDailyCap: 30,
      },
      healthBand: 'watch',
    };
    const result = resolveEffective(layers);
    // watch: capMultiplier 0.7 on warmupTier's 600 -> 420; system profile's 1000 -> 700.
    // strictest wins: min(700, 420) = 420.
    expect(result.dailyCap).toBe(420);
    // gapMultiplier 1.5 on both 15000 -> 22500; strictest (max) = 22500.
    expect(result.gapMinMs).toBe(22_500);
  });

  it('admin_override_cannot_exceed_absolute_daily_ceiling', () => {
    const layers: Layers = {
      systemProfile: BASE_SYSTEM_PROFILE,
      warmupTier: BASE_WARMUP_TIER,
      healthBand: 'healthy',
      adminOverride: {
        actorUserId: 'admin-1',
        reason: 'special case',
        expiresAt: null,
        dailyCap: 999_999,
      },
    };
    const result = resolveEffective(layers);
    expect(result.dailyCap).toBe(ABSOLUTE_DAILY_CEILING);
  });

  it('admin_override_cannot_push_gap_min_below_absolute_floor', () => {
    const layers: Layers = {
      systemProfile: BASE_SYSTEM_PROFILE,
      warmupTier: BASE_WARMUP_TIER,
      healthBand: 'healthy',
      adminOverride: {
        actorUserId: 'admin-1',
        reason: 'special case',
        expiresAt: null,
        gapMinMs: 1,
      },
    };
    const result = resolveEffective(layers);
    expect(result.gapMinMs).toBe(ABSOLUTE_GAP_MIN_MS);
  });

  it('admin_override_cannot_exceed_absolute_group_daily_ceiling', () => {
    const layers: Layers = {
      systemProfile: BASE_SYSTEM_PROFILE,
      warmupTier: BASE_WARMUP_TIER,
      healthBand: 'healthy',
      adminOverride: {
        actorUserId: 'admin-1',
        reason: 'special case',
        expiresAt: null,
        groupDailyCap: 10_000,
      },
    };
    const result = resolveEffective(layers);
    expect(result.groupDailyCap).toBe(50);
  });

  it('engagement_exempt_changes_no_effective_limit', () => {
    const layers: Layers = {
      systemProfile: BASE_SYSTEM_PROFILE,
      warmupTier: BASE_WARMUP_TIER,
      healthBand: 'healthy',
    };
    const withoutFlag = resolveEffective(layers);

    // The `Layers` type has no `engagementExempt` field at all - proven
    // structurally: a caller cannot even express it via the type. This
    // cast simulates a caller ignoring the type (e.g. a stray property from
    // a wider object) to prove the runtime is ALSO indifferent to it, not
    // just the compiler.
    const layersWithStrayFlag = {
      ...layers,
      engagementExempt: true,
    } as Layers & { engagementExempt: boolean };
    const withFlagTrue = resolveEffective(layersWithStrayFlag);

    const layersWithStrayFlagFalse = {
      ...layers,
      engagementExempt: false,
    } as Layers & { engagementExempt: boolean };
    const withFlagFalse = resolveEffective(layersWithStrayFlagFalse);

    expect(withFlagTrue).toEqual(withoutFlag);
    expect(withFlagFalse).toEqual(withoutFlag);
    expect(JSON.stringify(withFlagTrue)).toBe(JSON.stringify(withoutFlag));
  });

  it('throws_when_no_layer_supplies_a_required_field', () => {
    const layers: Layers = {
      systemProfile: {},
      warmupTier: {},
      healthBand: 'healthy',
    };
    expect(() => resolveEffective(layers)).toThrow(RangeError);
  });
});
