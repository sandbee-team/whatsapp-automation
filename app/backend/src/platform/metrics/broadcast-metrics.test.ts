import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindBroadcastMetrics } from './broadcast-metrics.js';

/**
 * broadcast-metrics.test.ts (P23 Unit U6, step 7) - asserts the three
 * metric names, the label set, and that a recount of N sets the gauge to
 * EXACTLY N (never a bound - see core-invariants.md's "units and
 * quantities" rule).
 */
describe('bindBroadcastMetrics', () => {
  it('registers_the_three_metrics_with_the_right_names_and_labels', async () => {
    const registry = createMetricsRegistry();
    bindBroadcastMetrics(registry);

    const text = await registry.metricsText();

    expect(text).toContain('# TYPE wp_stranded_epoch_jobs gauge');
    expect(text).toContain('# TYPE wp_broadcast_recipients_total counter');
    expect(text).toContain('# TYPE wp_broadcast_expansion_lag_seconds histogram');
  });

  it('a_recount_of_320_sets_the_gauge_to_exactly_320_not_a_bound', async () => {
    const registry = createMetricsRegistry();
    const handles = bindBroadcastMetrics(registry);

    handles.setStrandedEpochJobs(320);

    const text = await registry.metricsText();
    expect(text).toContain('wp_stranded_epoch_jobs 320');
  });

  it('a_second_recount_of_0_resets_the_gauge_to_exactly_0', async () => {
    const registry = createMetricsRegistry();
    const handles = bindBroadcastMetrics(registry);

    handles.setStrandedEpochJobs(320);
    handles.setStrandedEpochJobs(0);

    const text = await registry.metricsText();
    expect(text).toContain('wp_stranded_epoch_jobs 0');
  });

  it('increments_recipients_total_by_status_label', async () => {
    const registry = createMetricsRegistry();
    const handles = bindBroadcastMetrics(registry);

    handles.incrementRecipients('queued', 500);
    handles.incrementRecipients('failed', 3);

    const text = await registry.metricsText();
    expect(text).toContain('wp_broadcast_recipients_total{status="queued"} 500');
    expect(text).toContain('wp_broadcast_recipients_total{status="failed"} 3');
  });

  it('observes_expansion_lag_seconds', async () => {
    const registry = createMetricsRegistry();
    const handles = bindBroadcastMetrics(registry);

    handles.observeExpansionLagSeconds(4.2);

    const text = await registry.metricsText();
    expect(text).toContain('wp_broadcast_expansion_lag_seconds_sum 4.2');
  });

  it('registering_twice_against_the_same_registry_returns_the_same_handles', () => {
    const registry = createMetricsRegistry();
    const first = bindBroadcastMetrics(registry);
    const second = bindBroadcastMetrics(registry);
    expect(second).toBe(first);
  });

  it('neither_metric_carries_client_id_or_instance_id_labels', async () => {
    const registry = createMetricsRegistry();
    bindBroadcastMetrics(registry);

    const text = await registry.metricsText();
    expect(text).not.toMatch(/client_id=/);
    expect(text).not.toMatch(/instance_id=/);
  });
});
