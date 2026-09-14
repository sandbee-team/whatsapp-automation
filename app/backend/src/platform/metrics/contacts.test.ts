import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindContactsMetrics } from './contacts.js';

/**
 * contacts.test.ts (P20 Unit U5, step 5/6) - proves `bindContactsMetrics`
 * registers exactly the three named metrics with exactly these labels, and
 * that re-binding the same registry is a safe no-op (same idiom as
 * `wallet-metrics.test.ts`/`lease-metrics.test.ts`: a fresh
 * `createMetricsRegistry()` per test, never the shared `defaultMetrics`,
 * since duplicate registration in one `prom-client` `Registry` throws).
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

describe('bindContactsMetrics', () => {
  it('registers_exactly_the_three_named_metrics_with_the_documented_labels', () => {
    const registry = createMetricsRegistry();
    bindContactsMetrics(registry);

    const registered = registeredMetricsOf(registry);
    const byName = new Map(registered.map((m) => [m.name, m]));

    expect(byName.get('wp_contacts_imported_total')?.labelNames).toEqual(['result']);
    expect(byName.get('wp_contact_import_rows_total')?.labelNames).toEqual(['result']);
    expect(byName.get('wp_optout_mirror_drift_total')?.labelNames).toEqual([]);

    for (const metric of registered) {
      for (const label of metric.labelNames ?? []) {
        expect(label).not.toBe('client_id');
        expect(label).not.toBe('instance_id');
      }
    }
  });

  it('is_idempotent_for_the_same_registry', () => {
    const registry = createMetricsRegistry();
    const first = bindContactsMetrics(registry);
    const second = bindContactsMetrics(registry);

    expect(second).toBe(first);
    expect(registeredMetricsOf(registry).length).toBe(3);
  });

  it('increments_contactsImportedTotal_by_result_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindContactsMetrics(registry);
    expect(() => {
      handles.contactsImportedTotal.inc({ result: 'done' });
    }).not.toThrow();
  });

  it('increments_contactImportRowsTotal_by_result_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindContactsMetrics(registry);
    expect(() => {
      handles.contactImportRowsTotal.inc({ result: 'imported' });
    }).not.toThrow();
  });

  it('increments_optoutMirrorDriftTotal_with_no_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindContactsMetrics(registry);
    expect(() => {
      handles.optoutMirrorDriftTotal.inc();
    }).not.toThrow();
  });
});
