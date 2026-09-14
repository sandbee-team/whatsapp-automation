import type { AdminOverride, HealthBand, Layers, PacingLayer } from '@wp/domain';
import { resolveEffective } from '@wp/domain';
import { sysKey } from '../../platform/redis.js';
import {
  applyWarmupTierChangeAtomic,
  insertConfigAuditAndEvent,
  updateEffRow,
} from './config-service-warmup-write.js';

/**
 * engine/pacing/config-service.ts (P13 Unit U4, step 6; P13a Unit U1; FIX
 * ROUND CRITICAL 2 correction) - `updatePacingConfig()`, the ONE writer of
 * `instance_pacing_state.eff_*` (migration 0030: only `wp_app` may rewrite it).
 *
 * ATOMICITY CONTRACT (corrected - the old doc wrongly claimed "`sql` is the
 * caller's transaction handle" unconditionally, never enforced for warmup and
 * found live to be false, `warmup-evaluator.ts` always passed a raw pool):
 * for `kind: 'warmup_tier'` the ENTIRE transition (tier-guarded UPDATE +
 * `audit_logs` + `pacing_events`) is atomic BY ITSELF, inside `wp_warmup_
 * apply_tier_change` (migration 0034) - `sql` need not be a transaction for
 * this kind. Every OTHER kind still runs UPDATE/audit/event as separate
 * statements against whatever `sql` is; a caller wanting those atomic
 * together must supply a real transaction/`tenantDb.withTenant` handle.
 * `publishConfigInvalidate` must still only run AFTER any caller-owned
 * transaction commits. `reserve-pacing.sql` reads `eff_*` in-statement every
 * time, so a change is visible on the VERY NEXT reserve.
 */

export type PacingConfigQueryable = import('../../modules/pacing/pacing.repo.js').PacingQueryable;

export type ConfigChangeKind =
  'profile' | 'warmup_tier' | 'health_band' | 'tenant_tighten' | 'admin_relax' | 'timezone';

export interface UpdatePacingConfigInput {
  sql: PacingConfigQueryable;
  clientId: string;
  instanceId: string;
  kind: ConfigChangeKind;
  reason: string;
  actorUserId?: string | null;
  /** The four resolved-limits layers `resolveEffective()` folds - caller supplies the FULL layer set (system profile, warm-up tier, health band, optional tenant tightening / admin override) reflecting the change being applied. */
  layers: Layers;
  /** Required when `kind === 'timezone'` - the new IANA zone name. */
  newTimezone?: string;
  clock: { now(): number };
  /** P13a Unit U1, `kind === 'warmup_tier'` only: optimistic-concurrency guard (`AND warmup_tier = expectedFromWarmupTier`) plus the `warmup_tier`/`warmup_tier_since` write and the `WARMUP_ADVANCE`/`WARMUP_ROLLBACK` event (replaces `CONFIG_CHANGE` for this kind) - see `WarmupTierRaceLostError` below. */
  expectedFromWarmupTier?: number;
  toWarmupTier?: number;
  reasonCodes?: string[];
  evidence?: Record<string, unknown>;
  /** FIX ROUND MAJOR 4, `kind === 'health_band'` only: the band being LEFT (undefined/null for "no prior band on record") - written into the `BAND_CHANGE` event's `from_value` so `isDegradedRollbackDue`'s anchor query can tell a genuinely NEW degraded episode apart from a re-read of the same one. */
  fromHealthBand?: HealthBand | null;
}

/** Thrown when a `warmup_tier` change's `expectedFromWarmupTier` guard matches zero rows - another evaluator tick won the race first; the caller treats this as a clean no-op. */
export class WarmupTierRaceLostError extends Error {
  constructor(instanceId: string, expectedFromWarmupTier: number) {
    super(
      `PacingConfigService.update: instance ${instanceId} warmup_tier was not ${expectedFromWarmupTier} at update time - another evaluator tick already applied a change`,
    );
    this.name = 'WarmupTierRaceLostError';
  }
}

export class TenantTighteningLoosenedError extends Error {
  constructor(field: string) {
    super(
      `PacingConfigService.update: a tenant_tighten patch may only TIGHTEN - field "${field}" would loosen the resolved limit, rejected`,
    );
    this.name = 'TenantTighteningLoosenedError';
  }
}

export class AdminRelaxInvalidError extends Error {
  constructor(message: string) {
    super(`PacingConfigService.update: admin_relax rejected - ${message}`);
    this.name = 'AdminRelaxInvalidError';
  }
}

export class TimezoneChangeRateLimitedError extends Error {
  constructor(instanceId: string) {
    super(
      `PacingConfigService.update: instance ${instanceId} already changed pacing_timezone within the last 7 days - rejected (and audited)`,
    );
    this.name = 'TimezoneChangeRateLimitedError';
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** A tenant patch may only make a field STRICTER than what it would otherwise resolve to without the patch - checked per numeric cap/gap field the patch actually sets. */
function assertTenantPatchOnlyTightens(patch: PacingLayer, withoutPatch: PacingLayer): void {
  const tighterCapFields: (keyof PacingLayer)[] = [
    'dailyCap',
    'hourlyCap',
    'newConvCap',
    'coldRatioMax',
    'groupDailyCap',
  ];
  for (const field of tighterCapFields) {
    const patched = patch[field];
    const baseline = withoutPatch[field];
    if (typeof patched === 'number' && typeof baseline === 'number' && patched > baseline) {
      throw new TenantTighteningLoosenedError(field);
    }
  }
  const gapFields: (keyof PacingLayer)[] = ['gapMinMs', 'gapMaxMs'];
  for (const field of gapFields) {
    const patched = patch[field];
    const baseline = withoutPatch[field];
    if (typeof patched === 'number' && typeof baseline === 'number' && patched < baseline) {
      throw new TenantTighteningLoosenedError(field);
    }
  }
}

function assertAdminRelaxValid(override: AdminOverride, nowMs: number): void {
  if (!override.actorUserId || !override.reason) {
    throw new AdminRelaxInvalidError('actor and reason are both required');
  }
  if (override.expiresAt !== null && override.expiresAt > nowMs + THIRTY_DAYS_MS) {
    throw new AdminRelaxInvalidError('expiresAt must be <= now() + 30 days');
  }
}

export interface EffRow {
  eff_daily_cap: number;
  eff_hourly_cap: number;
  eff_new_conv_cap: number;
  eff_gap_min_ms: number;
  eff_gap_max_ms: number;
  eff_cold_ratio_max: number;
  eff_cold_ratio_floor: number;
  eff_window_start_local: string | undefined;
  eff_window_end_local: string | undefined;
  eff_group_daily_cap: number;
}

/**
 * A health-band multiplier (e.g. `degraded`'s 0.4x) can leave a fractional
 * value for an INTEGER column - caps round DOWN (`floor`), gaps round UP
 * (`ceil`, a longer gap is stricter).
 *
 * FIX ROUND MAJOR 6 correction: `eff_cold_ratio_floor` is NEITHER a cap NOR
 * a gap - "a longer floor is stricter" (the replaced comment's gap-borrowed
 * rationale) is WRONG for it. `resolveEffective()` folds it with `maxOf`
 * (packages/domain/src/pacing/resolve-effective.ts, read-only here) - the
 * HIGHEST layer value wins - and `Math.ceil` only ever rounds a fractional
 * result UP toward that already-highest value, so it agrees with the fold
 * and never produces a floor below it; that is the ONLY reason `ceil` is
 * correct. It is not because a higher floor is independently stricter at
 * the reserve statement: `reserve-pacing.sql`'s cold-ratio clause
 * (`l.consumed_count < s.eff_cold_ratio_floor OR (ratio) <= ...`) treats the
 * floor as a grace-count BELOW which the ratio check is skipped entirely, so
 * a HIGHER floor actually widens that early unconditional-allow window - if
 * anything the LOOSER direction. `toEffRow` only has to agree with
 * `resolveEffective`'s own fold, which it does.
 */
function toEffRow(resolved: ReturnType<typeof resolveEffective>): EffRow {
  return {
    eff_daily_cap: Math.floor(resolved.dailyCap),
    eff_hourly_cap: Math.floor(resolved.hourlyCap),
    eff_new_conv_cap: Math.floor(resolved.newConvCap),
    eff_gap_min_ms: Math.ceil(resolved.gapMinMs),
    eff_gap_max_ms: Math.ceil(resolved.gapMaxMs),
    eff_cold_ratio_max: resolved.coldRatioMax,
    eff_cold_ratio_floor: Math.ceil(resolved.coldRatioFloor),
    eff_window_start_local: resolved.windowStartLocal,
    eff_window_end_local: resolved.windowEndLocal,
    eff_group_daily_cap: Math.floor(resolved.groupDailyCap),
  };
}

export interface UpdatePacingConfigResult {
  configVersion: number;
  effective: EffRow;
}

/** Applies ONE pacing config change (see module doc for the atomicity contract). May throw any of the four error classes above, each documenting its own trigger; a `warmup_tier` race loss writes nothing (see `applyWarmupTierChangeAtomic`). */
export async function updatePacingConfig(
  input: UpdatePacingConfigInput,
): Promise<UpdatePacingConfigResult> {
  const nowMs = input.clock.now();

  if (input.kind === 'tenant_tighten' && input.layers.tenantTightening) {
    const withoutPatch = resolveEffective({
      ...input.layers,
      tenantTightening: undefined,
    });
    assertTenantPatchOnlyTightens(input.layers.tenantTightening, withoutPatch);
  }

  if (input.kind === 'admin_relax' && input.layers.adminOverride) {
    assertAdminRelaxValid(input.layers.adminOverride, nowMs);
  }

  if (input.kind === 'timezone') {
    const recent = await input.sql.query<{ changed_at: Date | null }>(
      `SELECT pacing_timezone_changed_at AS changed_at FROM instance_pacing_state
        WHERE instance_id = $1 AND client_id = $2`,
      [input.instanceId, input.clientId],
    );
    const lastChangedAt = recent.rows[0]?.changed_at;
    if (lastChangedAt && nowMs - lastChangedAt.getTime() < SEVEN_DAYS_MS) {
      throw new TimezoneChangeRateLimitedError(input.instanceId);
    }
    await input.sql.query(
      `UPDATE instance_pacing_state SET pacing_timezone = $3, pacing_timezone_changed_at = now()
        WHERE instance_id = $1 AND client_id = $2`,
      [input.instanceId, input.clientId, input.newTimezone],
    );
  }

  const resolved = resolveEffective(input.layers);
  const eff = toEffRow(resolved);
  const isWarmupTierChange =
    input.kind === 'warmup_tier' && input.expectedFromWarmupTier !== undefined;

  if (isWarmupTierChange) {
    // FIX ROUND CRITICAL 1/2: the ENTIRE guarded transition (tier-guarded
    // UPDATE + audit_logs INSERT + pacing_events INSERT) runs inside
    // `wp_warmup_apply_tier_change` (migration 0034) as one atomic
    // definer-function body - see config-service-warmup-write.ts's own doc.
    // This is why the warmup path returns HERE, before the generic
    // audit/pacing_events statements below: those two rows are already
    // written (or, on a lost race, deliberately NOT written) by the
    // function itself, never by this module directly.
    const configVersion = await applyWarmupTierChangeAtomic({
      sql: input.sql,
      instanceId: input.instanceId,
      clientId: input.clientId,
      eff,
      expectedFromWarmupTier: input.expectedFromWarmupTier as number,
      toWarmupTier: input.toWarmupTier as number,
      reason: input.reason,
      reasonCodes: input.reasonCodes ?? [],
      evidence: input.evidence ?? {},
      actorUserId: input.actorUserId,
    });
    if (configVersion === undefined) {
      throw new WarmupTierRaceLostError(input.instanceId, input.expectedFromWarmupTier as number);
    }
    return { configVersion, effective: eff };
  }

  const configVersion = await updateEffRow({
    sql: input.sql,
    instanceId: input.instanceId,
    clientId: input.clientId,
    eff,
    healthBand: input.kind === 'health_band' ? input.layers.healthBand : undefined,
  });

  if (configVersion === undefined) {
    throw new Error(
      `PacingConfigService.update: instance_pacing_state UPDATE matched zero rows for instance ${input.instanceId}`,
    );
  }

  // FIX ROUND MAJOR 4 dependency: insertConfigAuditAndEvent (sibling module)
  // writes BAND_CHANGE for kind:'health_band', CONFIG_CHANGE otherwise - see
  // its own doc. The cast below is safe: isWarmupTierChange's compound guard
  // (kind==='warmup_tier' && expectedFromWarmupTier!==undefined) already
  // returned above when true, but TS cannot narrow past a compound && guard.
  const nonWarmupKind = input.kind as Exclude<ConfigChangeKind, 'warmup_tier'>;
  await insertConfigAuditAndEvent({
    sql: input.sql,
    clientId: input.clientId,
    instanceId: input.instanceId,
    kind: nonWarmupKind,
    reason: input.reason,
    actorUserId: input.actorUserId,
    eff,
    fromHealthBand: input.fromHealthBand,
    toHealthBand: input.kind === 'health_band' ? input.layers.healthBand : undefined,
  });

  return { configVersion, effective: eff };
}

export interface PublishInvalidateDeps {
  publish(channel: string, message: string): Promise<unknown>;
}

/** `wp:{env}:pacing:config:invalidate:i:{instanceId}` - via `sysKey` (never a raw template literal). Called ONLY after the caller's transaction has committed (see module doc). */
export async function publishConfigInvalidate(
  redis: PublishInvalidateDeps,
  env: string,
  instanceId: string,
  version: number,
): Promise<void> {
  const channel = sysKey(env, 'pacing', 'config', 'invalidate', 'i', instanceId);
  try {
    await redis.publish(channel, JSON.stringify({ instance_id: instanceId, version }));
  } catch {
    // Fire-and-forget (wake.ts's publishWake pattern) - a dropped invalidate never causes a stale grant/deny, only a stale DISPLAY value.
  }
}
