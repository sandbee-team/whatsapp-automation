import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindWalletMetrics } from './wallet-metrics.js';

/**
 * wallet-metrics.test.ts (P18 Unit U2; P28 Unit U3a, step 4 - the
 * `wp_internal_audit_write_failures_total` case moved to
 * `staff-metrics.test.ts`'s replacement `wp_staff_mutations_total`, since
 * that metric is now removed - see `wallet-metrics.ts`'s own header) -
 * proves the five wallet metrics carry no `client_id`/`instance_id` label
 * and no per-client balance gauge (ADR 0019 S10: per-client figures come
 * from `wallet_daily_summary` over SQL, never a Prometheus label), and that
 * re-binding the same registry is a safe no-op (same idiom as
 * `lease-metrics.test.ts`).
 */

interface RegisteredMetric {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

function registeredMetricsOf(
  registry: ReturnType<typeof createMetricsRegistry>,
): RegisteredMetric[] {
  const list = registry.registry.getMetricsAsArray() as unknown as Array<{
    name: string;
    help: string;
    labelNames?: readonly string[];
  }>;
  return list.map((m) => ({ name: m.name, help: m.help, labelNames: m.labelNames ?? [] }));
}

describe('bindWalletMetrics', () => {
  it('wallet_metrics_carry_no_client_or_instance_label', () => {
    const registry = createMetricsRegistry();
    bindWalletMetrics(registry);

    const registered = registeredMetricsOf(registry);
    const walletMetrics = registered.filter((m) => m.name.startsWith('wp_wallet_'));

    expect(walletMetrics.length).toBe(5);
    for (const metric of walletMetrics) {
      for (const label of metric.labelNames ?? []) {
        expect(label).not.toBe('client_id');
        expect(label).not.toBe('instance_id');
        expect(['price_key', 'reason', 'status']).toContain(label);
      }
    }

    const hasBalanceMetric = registered.some((m) => m.name.toLowerCase().includes('balance'));
    expect(hasBalanceMetric).toBe(false);
  });

  it('rebinding_the_same_registry_is_a_no_op_and_returns_the_same_handles', () => {
    const registry = createMetricsRegistry();
    const first = bindWalletMetrics(registry);
    const second = bindWalletMetrics(registry);
    expect(second).toBe(first);
  });

  it('inc_topup_increments_the_exact_status_labelled_series_by_one', async () => {
    const registry = createMetricsRegistry();
    const handles = bindWalletMetrics(registry);

    handles.incTopup('pending');
    handles.incTopup('pending');
    handles.incTopup('approved');

    const pendingValue = await registry.registry.getSingleMetric('wp_wallet_topups_total')?.get();
    const pendingSample = pendingValue?.values.find((v) => v.labels.status === 'pending');
    const approvedSample = pendingValue?.values.find((v) => v.labels.status === 'approved');

    expect(pendingSample?.value).toBe(2);
    expect(approvedSample?.value).toBe(1);
  });

  it('a_tenant_scoped_label_on_a_non_allow_listed_metric_throws_at_registration', () => {
    const registry = createMetricsRegistry();
    expect(() => registry.counter('wp_wallet_probe_total', 'x', ['client_id'])).toThrow();
  });
});
