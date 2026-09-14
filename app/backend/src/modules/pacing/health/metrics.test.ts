import '../../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import {
  bindHealthMetrics,
  HEALTH_STATE_GAUGE_VALUES,
  setHealthScoreGauge,
  setInstanceHealthStateGauge,
} from './metrics.js';

/**
 * metrics.test.ts (P16 Unit E, step 10) - the four health-module metrics
 * register cleanly with the allowed `from`/`to`/`signal` labels, and
 * `wp_health_score` (a label-free gauge) never joins the four-gauge
 * `INSTANCE_LABELLED_GAUGES` allow-list - registering it (or any other
 * health metric) as a FIFTH instance_id-labelled gauge throws.
 */
describe('bindHealthMetrics', () => {
  it('registers_the_four_health_metrics', () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);

    expect(handles.healthScore).toBeDefined();
    expect(handles.bandChangesTotal).toBeDefined();
    expect(handles.hardSignalPausesTotal).toBeDefined();
    expect(handles.bandFlapsTotal).toBeDefined();
  });

  it('registers_wp_instance_health_state_as_an_allow_listed_instance_labelled_gauge', () => {
    const registry = createMetricsRegistry();

    expect(() => bindHealthMetrics(registry)).not.toThrow();
    const handles = bindHealthMetrics(registry);
    expect(handles.instanceHealthState).toBeDefined();
  });

  it('rebinding_the_same_registry_is_idempotent', () => {
    const registry = createMetricsRegistry();
    const first = bindHealthMetrics(registry);
    const second = bindHealthMetrics(registry);
    expect(second).toBe(first);
  });

  it('band_changes_total_uses_the_allowed_from_and_to_labels', () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);

    expect(() => handles.bandChangesTotal.inc({ from: 'healthy', to: 'watch' })).not.toThrow();
  });

  it('hard_signal_pauses_total_uses_the_allowed_signal_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);

    expect(() =>
      handles.hardSignalPausesTotal.inc({ signal: 'provider_restriction' }),
    ).not.toThrow();
  });

  it('instance_id_label_is_not_added_to_a_fifth_gauge', () => {
    const registry = createMetricsRegistry();
    bindHealthMetrics(registry);

    // wp_health_score itself never carries instance_id (see this module's
    // own doc) - proven directly: attempting to register ANY fifth
    // instance_id-labelled gauge (health or otherwise) against the live
    // server-kit policy throws, since the four-gauge allow-list is already
    // spent by the P09 dashboard gauges.
    expect(() =>
      registry.gauge('wp_health_score_per_instance', 'not on the allow-list', ['instance_id']),
    ).toThrow(/wp_health_score_per_instance/);
  });
});

describe('setHealthScoreGauge', () => {
  it('sets_the_gauge_to_the_minimum_score_across_the_pass', async () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);

    setHealthScoreGauge([91, 42, 77], registry);

    const value = await handles.healthScore.get();
    expect(value.values[0]?.value).toBe(42);
  });

  it('is_a_no_op_when_the_pass_evaluated_zero_instances', async () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);
    handles.healthScore.set(55); // a prior pass's real value.

    expect(() => setHealthScoreGauge([], registry)).not.toThrow();

    // A zero-instance pass leaves the PRIOR value untouched - never clobbers
    // a real prior reading with a fabricated 0/100 (fail-safe, same rule as
    // discovery-wiring.ts's own "never clobber a real prior reading" idiom).
    const value = await handles.healthScore.get();
    expect(value.values[0]?.value).toBe(55);
  });
});

describe('setInstanceHealthStateGauge', () => {
  it('sets_the_exact_encoded_value_for_a_transition_write', async () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);

    setInstanceHealthStateGauge(
      { clientId: 'client-1', instanceId: 'instance-1', healthState: 'paused' },
      registry,
    );

    const value = await handles.instanceHealthState.get();
    const sample = value.values.find(
      (v) => v.labels.instance_id === 'instance-1' && v.labels.client_id === 'client-1',
    );
    expect(sample?.value).toBe(HEALTH_STATE_GAUGE_VALUES.paused);
    expect(HEALTH_STATE_GAUGE_VALUES.paused).toBe(3);
  });

  it('sets_a_different_exact_value_for_a_different_health_state', async () => {
    const registry = createMetricsRegistry();
    const handles = bindHealthMetrics(registry);

    setInstanceHealthStateGauge(
      { clientId: 'client-2', instanceId: 'instance-2', healthState: 'degraded' },
      registry,
    );

    const value = await handles.instanceHealthState.get();
    const sample = value.values.find(
      (v) => v.labels.instance_id === 'instance-2' && v.labels.client_id === 'client-2',
    );
    expect(sample?.value).toBe(HEALTH_STATE_GAUGE_VALUES.degraded);
    expect(HEALTH_STATE_GAUGE_VALUES.degraded).toBe(2);
  });
});
