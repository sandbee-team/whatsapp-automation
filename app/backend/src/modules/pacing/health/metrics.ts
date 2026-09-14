import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { HealthState } from './transitions.js';

/**
 * modules/pacing/health/metrics.ts (P16 Unit E, step 10) - the health
 * module's own metric set, following `engine/queue/metrics.ts`'s idempotent-
 * registration `WeakMap` pattern and `@wp/server-kit`'s `metric-policy.ts`
 * allow-list exactly.
 *
 *   - `wp_health_score` (gauge, NO labels) - the MINIMUM health score across
 *     every instance evaluated in the most recent evaluator-loop pass (the
 *     worst-instance fleet signal). `wp_instance_health_state` (one of the
 *     four INSTANCE_LABELLED_GAUGES, `@wp/server-kit`'s `metric-policy.ts`)
 *     is ALREADY SPENT for per-instance `instance_id` cardinality - a fifth
 *     instance-labelled gauge THROWS at registration (see this file's own
 *     test), so per-instance scores are read from PostgreSQL
 *     (`instance_pacing_state.health_score` / `instance_health_samples`)
 *     directly, never from Prometheus label cardinality. Set via
 *     `setHealthScoreGauge` after each `evaluator-loop.ts` sweep pass -
 *     never inside the pure `bands.ts`/`score.ts` modules.
 *   - `wp_health_band_changes_total{from,to}` - one increment per applied
 *     band change (`apply-band.ts#applyBandChange`), labelled by the FROM
 *     and TO band strings. `from`/`to` are closed 4-value sets (healthy,
 *     watch, degraded, critical) - added to `ALLOWED_LABELS` citing this
 *     phase (plan/v1/P16-health-signals-and-pause.md step 10), same
 *     precedent as P15's `fanout`/`topic_class` entry.
 *   - `wp_hard_signal_pauses_total{signal}` - one increment per applied
 *     hard-signal pause (`hard-signal-pause.ts#applyHardSignalPause`),
 *     labelled by the pause reason (`provider_restriction` /
 *     `health_critical` today - a small closed set, never tenant-scoped).
 *   - `wp_pacing_band_flaps_total` (counter, NO labels) - one increment per
 *     flap-suppressed loosening (`HealthEvaluator.ts`'s
 *     `writeBandChangeSuppressed` call, `bands.ts`'s `suppressedByFlap`).
 *
 * `wp_instance_health_state` (P16 gap-closer, item 2): registered and SET
 * here, not by a fleet-gauges refresh mechanism - investigation at the time
 * this gap was closed found `wp_instance_link_state`/`wp_instance_queue_depth`/
 * `wp_instance_oldest_queued_seconds` were ALSO never registered or set
 * anywhere in production code (each appears only in
 * `@wp/server-kit`'s `metric-policy.ts` allow-list and as a fixture literal
 * in `engine/fleet/metrics.test.ts`'s own policy-precedent test) - the whole
 * fleet-gauge refresh mechanism is a stub, not an existing pattern to
 * extend. Per this gap-closer's own instruction, no new mechanism is
 * invented: `wp_instance_health_state` is registered as a FIFTH handle on
 * THIS module's existing `HealthMetricsHandles`/`bindHealthMetrics` (it is
 * allow-listed for `instance_id`/`client_id` cardinality - see
 * `metric-policy.ts`'s `INSTANCE_LABELLED_GAUGES`) and set via
 * `setInstanceHealthStateGauge` at this module's own `whatsapp_instances.
 * health_state` write points: `hard-signal-pause.ts#applyHardSignalPause`
 * (-> 'paused') and `human-resume.ts#humanResume` (-> 'degraded'). `apply-
 * band.ts` never writes `health_state` (only `health_band` - a distinct
 * column/authority, see that module's own doc), so it has no call site here.
 *
 * NUMERIC ENCODING: `HEALTH_STATE_GAUGE_VALUES` mirrors `@wp/domain`'s
 * `WA_HEALTHS` array order (`never_linked, connected, degraded, paused,
 * logged_out` -> `0, 1, 2, 3, 4`) - a Prometheus gauge carries one number,
 * never a string, so the label-free VALUE encodes the enum position. Any
 * future dashboard/alert reading this gauge must use this exact mapping,
 * not re-derive its own.
 */

export const HEALTH_STATE_GAUGE_VALUES = {
  never_linked: 0,
  connected: 1,
  degraded: 2,
  paused: 3,
  logged_out: 4,
} as const satisfies Record<HealthState | 'never_linked', number>;

export interface HealthMetricsHandles {
  healthScore: ReturnType<MetricsRegistry['gauge']>;
  bandChangesTotal: ReturnType<MetricsRegistry['counter']>;
  hardSignalPausesTotal: ReturnType<MetricsRegistry['counter']>;
  bandFlapsTotal: ReturnType<MetricsRegistry['counter']>;
  /** Allow-listed instance-labelled gauge (`instance_id`, `client_id`) - see this module's own doc above for the numeric encoding and the two write points. */
  instanceHealthState: ReturnType<MetricsRegistry['gauge']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, HealthMetricsHandles>();

export function bindHealthMetrics(
  registry: MetricsRegistry = defaultMetrics,
): HealthMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const handles: HealthMetricsHandles = {
    healthScore: registry.gauge(
      'wp_health_score',
      'Minimum health score across instances evaluated in the most recent evaluator-loop pass (no labels - per-instance scores live in PostgreSQL)',
    ),
    bandChangesTotal: registry.counter(
      'wp_health_band_changes_total',
      'Applied health-band changes, by from/to band (label names: from, to)',
      ['from', 'to'],
    ),
    hardSignalPausesTotal: registry.counter(
      'wp_hard_signal_pauses_total',
      'Applied hard-signal pauses, by pause reason (label name: signal)',
      ['signal'],
    ),
    bandFlapsTotal: registry.counter(
      'wp_pacing_band_flaps_total',
      'Flap-suppressed band loosenings (bands.ts suppressedByFlap)',
    ),
    instanceHealthState: registry.gauge(
      'wp_instance_health_state',
      'Per-instance whatsapp_instances.health_state, numerically encoded (see HEALTH_STATE_GAUGE_VALUES; label names: instance_id, client_id)',
      ['instance_id', 'client_id'],
    ),
  };

  registeredMetrics.set(registry, handles);
  return handles;
}

/** Records one evaluator-loop pass's worst (minimum) health score - a no-op when the pass evaluated zero instances (nothing to report, never a fabricated 0/100). */
export function setHealthScoreGauge(
  scoresThisPass: readonly number[],
  registry: MetricsRegistry = defaultMetrics,
): void {
  if (scoresThisPass.length === 0) return;
  const handles = bindHealthMetrics(registry);
  handles.healthScore.set(Math.min(...scoresThisPass));
}

export interface SetInstanceHealthStateGaugeInput {
  clientId: string;
  instanceId: string;
  healthState: HealthState | 'never_linked';
}

/** Sets `wp_instance_health_state` to this instance's exact numerically-encoded `health_state` (see this module's own `HEALTH_STATE_GAUGE_VALUES` doc) - called from this module's own `whatsapp_instances.health_state` write points only (`hard-signal-pause.ts`, `human-resume.ts`). */
export function setInstanceHealthStateGauge(
  input: SetInstanceHealthStateGaugeInput,
  registry: MetricsRegistry = defaultMetrics,
): void {
  const handles = bindHealthMetrics(registry);
  handles.instanceHealthState.set(
    { instance_id: input.instanceId, client_id: input.clientId },
    HEALTH_STATE_GAUGE_VALUES[input.healthState],
  );
}
