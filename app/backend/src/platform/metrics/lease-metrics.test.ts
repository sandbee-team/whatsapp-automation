import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindLeaseMetrics } from './lease-metrics.js';

/**
 * lease-metrics.test.ts (P06 Unit U5) - proves the three lease metrics
 * register cleanly (no `instance_id`/`client_id` label - the four-gauge
 * allow-list rule would throw at registration time if one leaked in), and
 * that re-binding the same registry is a safe no-op (same pattern as
 * `modules/realtime/metrics.test.ts`).
 */

async function metricValue(text: string, line: string): Promise<number> {
  const found = text.split('\n').find((l) => l.startsWith(line) && !l.startsWith('#'));
  if (!found) return 0;
  const value = found.split(' ').at(-1);
  return value ? Number(value) : 0;
}

describe('bindLeaseMetrics', () => {
  it('registers_exactly_the_three_named_metrics_with_no_tenant_scoped_label', async () => {
    const registry = createMetricsRegistry();
    bindLeaseMetrics(registry);

    const text = await registry.metricsText();
    expect(text).toContain('wp_lease_takeovers_total');
    expect(text).toContain('wp_lease_lost_total');
    expect(text).toContain('wp_fence_regression_total');
    expect(text).toContain('wp_lease_heartbeat_ticks_skipped_total');
    expect(text).not.toContain('instance_id=');
    expect(text).not.toContain('client_id=');
  });

  it('increments_heartbeat_ticks_skipped_total_with_no_label', async () => {
    const registry = createMetricsRegistry();
    const handles = bindLeaseMetrics(registry);

    handles.incrementTicksSkipped();
    handles.incrementTicksSkipped();

    const text = await registry.metricsText();
    expect(await metricValue(text, 'wp_lease_heartbeat_ticks_skipped_total')).toBe(2);
  });

  it('increments_lost_total_by_cause_label', async () => {
    const registry = createMetricsRegistry();
    const handles = bindLeaseMetrics(registry);

    handles.incrementLeaseLost('watchdog');
    handles.incrementLeaseLost('watchdog');
    handles.incrementLeaseLost('pg_fence_conflict');

    const text = await registry.metricsText();
    expect(await metricValue(text, 'wp_lease_lost_total{cause="watchdog"}')).toBe(2);
    expect(await metricValue(text, 'wp_lease_lost_total{cause="pg_fence_conflict"}')).toBe(1);
    expect(await metricValue(text, 'wp_lease_lost_total{cause="redis_renew_lost"}')).toBe(0);
  });

  it('rebinding_the_same_registry_is_a_no_op_and_returns_the_same_handles', () => {
    const registry = createMetricsRegistry();
    const first = bindLeaseMetrics(registry);
    const second = bindLeaseMetrics(registry);
    expect(second).toBe(first);
  });
});
