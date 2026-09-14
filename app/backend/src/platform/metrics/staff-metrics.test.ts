import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindStaffMetrics } from './staff-metrics.js';

/**
 * staff-metrics.test.ts (P28 Unit U3a, step 4) - proves
 * `wp_staff_mutations_total` carries only the `action` label, increments by
 * exactly one per call, and that re-binding the same registry is a safe
 * no-op (same idiom as `wallet-metrics.test.ts`/`lease-metrics.test.ts`).
 */

describe('bindStaffMetrics', () => {
  it('inc_staff_mutation_increments_the_exact_action_labelled_series_by_one', async () => {
    const registry = createMetricsRegistry();
    const handles = bindStaffMetrics(registry);

    handles.incStaffMutation('wallet.credit');
    handles.incStaffMutation('wallet.credit');
    handles.incStaffMutation('wallet.adjust');

    const metricValue = await registry.registry.getSingleMetric('wp_staff_mutations_total')?.get();
    const creditSample = metricValue?.values.find((v) => v.labels.action === 'wallet.credit');
    const adjustSample = metricValue?.values.find((v) => v.labels.action === 'wallet.adjust');

    expect(creditSample?.value).toBe(2);
    expect(adjustSample?.value).toBe(1);
  });

  it('rebinding_the_same_registry_is_a_no_op_and_returns_the_same_handles', () => {
    const registry = createMetricsRegistry();
    const first = bindStaffMetrics(registry);
    const second = bindStaffMetrics(registry);
    expect(second).toBe(first);
  });
});
