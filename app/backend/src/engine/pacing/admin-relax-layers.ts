import type { TenantQueryable } from '@wp/db';
import type { AdminOverride, HealthBand, Layers, PacingLayer } from '@wp/domain';
import { readSystemProfileLayer } from './warmup-evaluator.js';
import { warmupTierLayer } from './warmup-evaluator-row.js';

/**
 * engine/pacing/admin-relax-layers.ts (P28 Unit U3b, step 5) -
 * `loadInstanceLayers`, the ONE loader that assembles a complete `Layers`
 * object for ONE instance from its stored state, so both the admin-relax
 * WRITE path (`modules/internal/routes/pacing.ts`) and the admin-relax
 * EXPIRY path (`admin-relax-expiry.ts`) feed `updatePacingConfig` the same
 * baseline.
 *
 * WHY THIS EXISTS RATHER THAN EACH CALLER BUILDING `Layers` BY HAND: the
 * three layers below are already loaded, in exactly this combination, by
 * `warmup-evaluator-apply.ts`, `modules/pacing/health/fast-lane.ts` and
 * `HealthEvaluator.ts` (each via `readSystemProfileLayer` +
 * `warmupTierLayer` + the row's own `health_band`). A fourth and fifth
 * hand-rolled copy in the admin-relax paths is exactly how the two would
 * drift apart - and a drifted baseline is silent: `resolveEffective()` would
 * happily fold a WRONG systemProfile ceiling into a real `eff_*` write, so
 * an expiry sweep could "restore" a strict value that was never the strict
 * value.
 *
 * `tenantTightening` is deliberately NOT loaded here: no phase writes a
 * `tenant_tighten` override row yet (see `pacing-overrides.repo.ts`'s own
 * header), so loading it would be loading a column nothing populates. When
 * one does, THIS is the single place that changes.
 */

interface LayersStateRow extends Record<string, unknown> {
  warmup_tier: number;
  health_band: string;
}

export interface LoadInstanceLayersInput {
  clientId: string;
  instanceId: string;
  /** The admin-relax layer to fold in - `undefined` both for "no override" and for the expiry path's deliberate removal of one. */
  adminOverride?: AdminOverride;
}

/** Loads `{systemProfile, warmupTier, healthBand}` for one instance and attaches `adminOverride` - see module doc. */
export async function loadInstanceLayers(
  tx: TenantQueryable,
  input: LoadInstanceLayersInput,
): Promise<Layers> {
  const stateResult = await tx.query<LayersStateRow>(
    `SELECT warmup_tier, health_band FROM instance_pacing_state
      WHERE instance_id = $1 AND client_id = $2`,
    [input.instanceId, input.clientId],
  );
  const state = stateResult.rows[0];
  if (!state) {
    throw new Error(
      `loadInstanceLayers: no instance_pacing_state row for instance ${input.instanceId}`,
    );
  }

  const systemProfile: PacingLayer = await readSystemProfileLayer(
    tx,
    input.clientId,
    input.instanceId,
  );

  return {
    systemProfile,
    warmupTier: warmupTierLayer(state.warmup_tier),
    healthBand: state.health_band as HealthBand,
    adminOverride: input.adminOverride,
  };
}
