/**
 * Metrics registry: `counter`/`gauge`/`histogram` factories over one
 * `prom-client` `Registry`. No default global registry, no default process
 * metrics collection - every metric this module produces is one this repo
 * explicitly created and named. Registration is validated against the
 * policy in `./metric-policy.js` and throws at boot on a violation; see
 * that file for the cardinality rationale.
 *
 * This module does not import `./config.js` - metrics need no env, and
 * keeping it import-safe means it can be loaded before config is parsed
 * (e.g. in tests, or by tooling that only wants metric shape).
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { assertMetricRegistrationAllowed } from './metric-policy.js';
import type { MetricKind } from './metric-policy.js';

export type CounterMetric = Counter<string>;
export type GaugeMetric = Gauge<string>;
export type HistogramMetric = Histogram<string>;

export type MetricsRegistry = {
  registry: Registry;
  counter: (name: string, help: string, labelNames?: readonly string[]) => CounterMetric;
  gauge: (name: string, help: string, labelNames?: readonly string[]) => GaugeMetric;
  histogram: (
    name: string,
    help: string,
    labelNames?: readonly string[],
    buckets?: readonly number[],
  ) => HistogramMetric;
  metricsText: () => Promise<string>;
};

/**
 * Builds a fresh registry + factories. Used both for the shared
 * module-level instance below and directly by tests that need isolation
 * from one another (duplicate registration in one Registry throws, so
 * every test that registers a metric needs its own registry).
 */
export function createMetricsRegistry(): MetricsRegistry {
  const registry = new Registry();

  function checked(kind: MetricKind, name: string, labelNames: readonly string[]): void {
    assertMetricRegistrationAllowed(kind, name, labelNames);
  }

  function counter(name: string, help: string, labelNames: readonly string[] = []): CounterMetric {
    checked('counter', name, labelNames);
    return new Counter({ name, help, labelNames: [...labelNames], registers: [registry] });
  }

  function gauge(name: string, help: string, labelNames: readonly string[] = []): GaugeMetric {
    checked('gauge', name, labelNames);
    return new Gauge({ name, help, labelNames: [...labelNames], registers: [registry] });
  }

  function histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ): HistogramMetric {
    checked('histogram', name, labelNames);
    return new Histogram({
      name,
      help,
      labelNames: [...labelNames],
      ...(buckets !== undefined ? { buckets: [...buckets] } : {}),
      registers: [registry],
    });
  }

  async function metricsText(): Promise<string> {
    return registry.metrics();
  }

  return { registry, counter, gauge, histogram, metricsText };
}

/** The shared registry used by app/worker code outside tests. */
export const metrics: MetricsRegistry = createMetricsRegistry();
