import { describe, expect, it } from 'vitest';
import type { Rng } from '../src/ports.js';
import {
  ABSOLUTE_DAILY_CEILING,
  ABSOLUTE_GAP_MIN_MS,
  ABSOLUTE_GROUP_DAILY_CEILING,
} from '../src/pacing/constants.js';
import { resolveEffective, type PacingLayer } from '../src/pacing/resolve-effective.js';
import {
  clampAdminRelax,
  MAX_ADMIN_RELAX_MS,
  AdminRelaxExpiryError,
  AdminRelaxEmptyPatchError,
  AdminRelaxInvalidValueError,
  type AdminRelaxPatch,
} from '../src/pacing/relax-bounds.js';

/**
 * pacing-relax-bounds.test.ts (P28 Unit U2, step 3) - `clampAdminRelax` unit
 * + a property test over random patches (mulberry32 seeded PRNG, the exact
 * idiom `gap-jitter.test.ts` established), asserting the clamped result
 * feeds `resolveEffective` (admin_override layer) and NEVER yields
 * `dailyCap > ABSOLUTE_DAILY_CEILING` or `gapMinMs < ABSOLUTE_GAP_MIN_MS` -
 * pacing design §4.1's suite test 22 (the absolute-bound property test)
 * extended here to admin relax patches specifically.
 */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return {
    random(): number {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

const NOW_MS = 1_735_689_600_000;

function permissiveSystemProfile(): PacingLayer {
  return {
    dailyCap: ABSOLUTE_DAILY_CEILING,
    hourlyCap: ABSOLUTE_DAILY_CEILING,
    newConvCap: ABSOLUTE_DAILY_CEILING,
    gapMinMs: ABSOLUTE_GAP_MIN_MS,
    gapMaxMs: ABSOLUTE_GAP_MIN_MS,
    coldRatioMax: 1,
    coldRatioFloor: 0,
    groupDailyCap: ABSOLUTE_GROUP_DAILY_CEILING,
  };
}

describe('clampAdminRelax', () => {
  it('an_in_bounds_patch_passes_through_unclamped', () => {
    const patch: AdminRelaxPatch = { dailyCap: 500, gapMinMs: 20_000 };
    const result = clampAdminRelax({
      patch,
      expiresAtMs: NOW_MS + 60_000,
      nowMs: NOW_MS,
    });
    expect(result.patch).toEqual({ dailyCap: 500, gapMinMs: 20_000 });
    expect(result.clampedFields).toEqual([]);
  });

  it('exceeding_a_ceiling_clamps_to_the_ceiling_and_records_the_field', () => {
    const result = clampAdminRelax({
      patch: { dailyCap: 5_000, groupDailyCap: 999 },
      expiresAtMs: NOW_MS + 60_000,
      nowMs: NOW_MS,
    });
    expect(result.patch.dailyCap).toBe(ABSOLUTE_DAILY_CEILING);
    expect(result.patch.groupDailyCap).toBe(ABSOLUTE_GROUP_DAILY_CEILING);
    expect(result.clampedFields.sort()).toEqual(['dailyCap', 'groupDailyCap']);
  });

  it('a_gap_below_the_floor_clamps_up_to_the_floor', () => {
    const result = clampAdminRelax({
      patch: { gapMinMs: 1_000, gapMaxMs: 2_000 },
      expiresAtMs: NOW_MS + 60_000,
      nowMs: NOW_MS,
    });
    expect(result.patch.gapMinMs).toBe(ABSOLUTE_GAP_MIN_MS);
    expect(result.patch.gapMaxMs).toBe(ABSOLUTE_GAP_MIN_MS);
    expect(result.clampedFields.sort()).toEqual(['gapMaxMs', 'gapMinMs']);
  });

  it('gapMaxMs_is_raised_to_at_least_the_clamped_gapMinMs', () => {
    const result = clampAdminRelax({
      patch: { gapMinMs: 50_000, gapMaxMs: 30_000 },
      expiresAtMs: NOW_MS + 60_000,
      nowMs: NOW_MS,
    });
    expect(result.patch.gapMinMs).toBe(50_000);
    expect(result.patch.gapMaxMs).toBe(50_000);
    expect(result.clampedFields).toContain('gapMaxMs');
  });

  it('expiry_at_exactly_now_throws_AdminRelaxExpiryError', () => {
    expect(() =>
      clampAdminRelax({ patch: { dailyCap: 100 }, expiresAtMs: NOW_MS, nowMs: NOW_MS }),
    ).toThrow(AdminRelaxExpiryError);
  });

  it('expiry_at_exactly_thirty_days_is_accepted', () => {
    const result = clampAdminRelax({
      patch: { dailyCap: 100 },
      expiresAtMs: NOW_MS + MAX_ADMIN_RELAX_MS,
      nowMs: NOW_MS,
    });
    expect(result.patch.dailyCap).toBe(100);
  });

  it('expiry_at_thirty_days_plus_one_ms_throws_AdminRelaxExpiryError', () => {
    expect(() =>
      clampAdminRelax({
        patch: { dailyCap: 100 },
        expiresAtMs: NOW_MS + MAX_ADMIN_RELAX_MS + 1,
        nowMs: NOW_MS,
      }),
    ).toThrow(AdminRelaxExpiryError);
  });

  it('an_empty_patch_throws_AdminRelaxEmptyPatchError', () => {
    expect(() =>
      clampAdminRelax({ patch: {}, expiresAtMs: NOW_MS + 60_000, nowMs: NOW_MS }),
    ).toThrow(AdminRelaxEmptyPatchError);
  });

  it('a_negative_value_throws_AdminRelaxInvalidValueError', () => {
    expect(() =>
      clampAdminRelax({
        patch: { dailyCap: -5 },
        expiresAtMs: NOW_MS + 60_000,
        nowMs: NOW_MS,
      }),
    ).toThrow(AdminRelaxInvalidValueError);
  });

  it('a_non_integer_value_throws_AdminRelaxInvalidValueError', () => {
    expect(() =>
      clampAdminRelax({
        patch: { dailyCap: 1.5 },
        expiresAtMs: NOW_MS + 60_000,
        nowMs: NOW_MS,
      }),
    ).toThrow(AdminRelaxInvalidValueError);
  });

  it('no_admin_patch_can_break_the_absolute_floor_or_ceiling', () => {
    const seeds = [1, 2, 3, 42, 12345];
    const fields: Array<keyof AdminRelaxPatch> = [
      'dailyCap',
      'hourlyCap',
      'newConvCap',
      'gapMinMs',
      'gapMaxMs',
      'groupDailyCap',
    ];
    const ceilingByField: Record<string, number> = {
      dailyCap: ABSOLUTE_DAILY_CEILING,
      hourlyCap: ABSOLUTE_DAILY_CEILING,
      newConvCap: ABSOLUTE_DAILY_CEILING,
      groupDailyCap: ABSOLUTE_GROUP_DAILY_CEILING,
    };
    const floorByField: Record<string, number> = {
      gapMinMs: ABSOLUTE_GAP_MIN_MS,
      gapMaxMs: ABSOLUTE_GAP_MIN_MS,
    };

    for (const seed of seeds) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 2_000; i += 1) {
        const patch: AdminRelaxPatch = {};
        for (const field of fields) {
          if (rng.random() < 0.7) continue; // some fields omitted
          const isGap = field === 'gapMinMs' || field === 'gapMaxMs';
          const baseCeiling = isGap ? ABSOLUTE_GAP_MIN_MS : (ceilingByField[field] ?? 1);
          // span 1 .. 10x the relevant absolute bound
          const value = Math.max(1, Math.floor(rng.random() * baseCeiling * 10) + 1);
          patch[field] = value;
        }
        if (Object.keys(patch).length === 0) {
          patch.dailyCap = 1;
        }

        const result = clampAdminRelax({
          patch,
          expiresAtMs: NOW_MS + 60_000,
          nowMs: NOW_MS,
        });

        for (const field of fields) {
          const value = result.patch[field];
          if (value === undefined) continue;
          const ceiling = ceilingByField[field];
          const floor = floorByField[field];
          if (ceiling !== undefined) expect(value).toBeLessThanOrEqual(ceiling);
          if (floor !== undefined) expect(value).toBeGreaterThanOrEqual(floor);
        }
        if (result.patch.gapMinMs !== undefined && result.patch.gapMaxMs !== undefined) {
          expect(result.patch.gapMaxMs).toBeGreaterThanOrEqual(result.patch.gapMinMs);
        }

        const effective = resolveEffective({
          systemProfile: permissiveSystemProfile(),
          warmupTier: permissiveSystemProfile(),
          healthBand: 'healthy',
          adminOverride: {
            ...result.patch,
            actorUserId: 'staff-1',
            reason: 'property test',
            expiresAt: NOW_MS + 60_000,
          },
        });

        expect(effective.dailyCap).toBeLessThanOrEqual(ABSOLUTE_DAILY_CEILING);
        expect(effective.gapMinMs).toBeGreaterThanOrEqual(ABSOLUTE_GAP_MIN_MS);
        expect(effective.groupDailyCap).toBeLessThanOrEqual(ABSOLUTE_GROUP_DAILY_CEILING);
      }
    }
  });
});
