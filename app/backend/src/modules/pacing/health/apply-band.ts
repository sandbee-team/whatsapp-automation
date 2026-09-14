import { randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import type { HealthBand as DomainHealthBand, Layers } from '@wp/domain';
import { emit } from '../../events/index.js';
import {
  updatePacingConfig,
  type PacingConfigQueryable,
  type UpdatePacingConfigResult,
} from '../../../engine/pacing/config-service.js';
import { bindHealthMetrics } from './metrics.js';
import type { HealthBand } from './bands.js';
import type { ScoreEvidence } from './score.js';

/**
 * apply-band.ts (P16 Unit C, step 6) - applies a `bands.ts` `decideBand`
 * result that CHANGED the band: rewrites `eff_*` via the existing
 * `updatePacingConfig({kind:'health_band'})` (which already writes the
 * `BAND_CHANGE` `pacing_events` row and the `pacing.config.change`
 * `audit_logs` row in the SAME statement group - see `config-service.ts`/
 * `config-service-warmup-write.ts`, reused here verbatim, never
 * duplicated), then adds the TWO things that module does not: an
 * `instance_health_samples` row (this evaluator tick's score/band/evidence
 * sparkline point) and an outbox `instance.pacing_changed` event (the same
 * event type/payload shape `warmup-evaluator.ts` already publishes on a
 * tier change - reused, not invented, per this unit's "reuse the resolver
 * layer set idiom" instruction).
 *
 * ONE-TRANSACTION CONTRACT: `sql` MUST be the evaluator's own `withTenant`
 * transaction handle - every statement below (the `eff_*`/audit/BAND_CHANGE
 * writes inside `updatePacingConfig`, the sample INSERT, the outbox INSERT)
 * runs on that SAME handle, so a failure anywhere before commit leaves NONE
 * of them (the "band change and limit rewrite are one transaction or the
 * band is a lie" rule - `eff_*` is read in-statement by `reserve()`).
 *
 * GRANT GAP (reported, not fixed here - out of this unit's file scope):
 * migration 0044 grants `instance_health_samples` INSERT to `wp_scheduler`
 * only, while `insertConfigAuditAndEvent`'s `audit_logs`/`pacing_events`
 * writes need `wp_app` (`audit_logs` INSERT is `wp_app`-only, migration
 * 0013). Whichever role the evaluator's cron/scheduler process actually
 * authenticates as must hold BOTH grants for this transaction to succeed in
 * production - a follow-up grants migration, not this unit's concern.
 */

export interface ApplyBandChangeInput {
  sql: PacingConfigQueryable & TenantQueryable;
  clientId: string;
  instanceId: string;
  fromBand: HealthBand | null;
  toBand: HealthBand;
  /** The FULL layer set (`systemProfile` + `warmupTier`, `healthBand` overridden below) - assembled by the caller the same way `warmup-evaluator.ts#evaluateOneInstance` assembles its own `Layers`, never re-resolved here. */
  layers: Omit<Layers, 'healthBand'>;
  score: number;
  evidence: ScoreEvidence;
  reason: string;
  clock: { now(): number };
}

export interface ApplyBandChangeResult {
  configResult: UpdatePacingConfigResult;
}

/** Applies one CHANGED band decision - never call this when `decideBand` reported `changed: false` (including a flap-suppressed loosening; the caller writes `BAND_CHANGE_SUPPRESSED` for that case instead, not this function). */
export async function applyBandChange(input: ApplyBandChangeInput): Promise<ApplyBandChangeResult> {
  const layers: Layers = { ...input.layers, healthBand: input.toBand as DomainHealthBand };

  const configResult = await updatePacingConfig({
    sql: input.sql,
    clientId: input.clientId,
    instanceId: input.instanceId,
    kind: 'health_band',
    reason: input.reason,
    layers,
    clock: input.clock,
    fromHealthBand: input.fromBand as DomainHealthBand | null,
  });

  await input.sql.query(
    `INSERT INTO instance_health_samples (id, client_id, instance_id, score, band, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     -- client_id = $2`,
    [
      randomUUID(),
      input.clientId,
      input.instanceId,
      input.score,
      input.toBand,
      JSON.stringify(input.evidence),
    ],
  );

  await emit(input.sql, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    type: 'instance.pacing_changed',
    entityId: input.instanceId,
    payload: {
      instanceId: input.instanceId,
      band: input.toBand,
      tier: null,
      effDailyCap: configResult.effective.eff_daily_cap,
      configVersion: configResult.configVersion,
    },
    fanout: ['sse'],
  });

  bindHealthMetrics().bandChangesTotal.inc({
    from: input.fromBand ?? 'healthy',
    to: input.toBand,
  });

  return { configResult };
}

/** Writes a `BAND_CHANGE_SUPPRESSED` row for a flap-suppressed would-be loosening (`bands.ts`'s `suppressedByFlap: true`) - never rewrites `eff_*`, never writes a sample, never publishes (this is a "nothing changed" event, not a state transition). */
export async function writeBandChangeSuppressed(
  sql: TenantQueryable,
  input: { clientId: string; instanceId: string; currentBand: HealthBand; reason: string },
): Promise<void> {
  await sql.query(
    `INSERT INTO pacing_events (id, client_id, instance_id, kind, from_value, to_value, reason_codes)
     VALUES ($1, $2, $3, 'BAND_CHANGE_SUPPRESSED', $4, $4, $5)
     -- client_id = $2`,
    [
      randomUUID(),
      input.clientId,
      input.instanceId,
      JSON.stringify({ band: input.currentBand }),
      [input.reason],
    ],
  );

  bindHealthMetrics().bandFlapsTotal.inc();
}
