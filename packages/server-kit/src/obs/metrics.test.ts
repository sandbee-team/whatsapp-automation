import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from './metrics.js';

describe('@wp/server-kit metrics registry', () => {
  it('a_metric_with_a_non_allow_listed_label_fails_at_registration', () => {
    const { counter } = createMetricsRegistry();

    // Fails at registration (boot), not at scrape - no metric is produced.
    expect(() =>
      counter('wp_jobs_total', 'total jobs processed', ['not_an_allowed_label']),
    ).toThrow(/not_an_allowed_label/);
  });

  it('only_four_gauges_may_carry_instance_id', () => {
    const { gauge } = createMetricsRegistry();

    // The four named gauges register successfully with instance_id.
    expect(() =>
      gauge('wp_instance_health_state', 'instance health state', ['instance_id']),
    ).not.toThrow();
    expect(() =>
      gauge('wp_instance_link_state', 'instance link state', ['instance_id']),
    ).not.toThrow();
    expect(() =>
      gauge('wp_instance_queue_depth', 'instance queue depth', ['instance_id']),
    ).not.toThrow();
    expect(() =>
      gauge('wp_instance_oldest_queued_seconds', 'instance oldest queued age', ['instance_id']),
    ).not.toThrow();

    // A fifth instance_id-labelled metric - not on the allow-list - fails.
    expect(() =>
      gauge('wp_instance_something_else', 'not on the allow-list', ['instance_id']),
    ).toThrow(/wp_instance_something_else/);
  });

  it('a_metric_name_missing_the_wp_prefix_fails_registration', () => {
    const { counter } = createMetricsRegistry();

    expect(() => counter('jobs_total', 'total jobs processed')).toThrow(/wp_/);
  });

  it('client_id_outside_the_four_gauge_allow_list_fails_even_on_a_gauge', () => {
    const { gauge } = createMetricsRegistry();

    expect(() => gauge('wp_client_activity', 'client activity', ['client_id'])).toThrow(
      /wp_client_activity/,
    );
  });

  it('a_counter_with_instance_id_fails_even_if_named_like_one_of_the_four_gauges', () => {
    const { counter } = createMetricsRegistry();

    expect(() =>
      counter('wp_instance_health_state', 'instance health state', ['instance_id']),
    ).toThrow(/wp_instance_health_state/);
  });

  it('registering_the_same_metric_name_twice_throws', () => {
    const { counter } = createMetricsRegistry();

    counter('wp_sends_total', 'total sends', ['worker_id']);

    expect(() => counter('wp_sends_total', 'total sends again', ['worker_id'])).toThrow();
  });

  it('a_metric_with_only_allow_listed_non_tenant_labels_registers_successfully', () => {
    const { histogram } = createMetricsRegistry();

    expect(() =>
      histogram('wp_send_duration_seconds', 'send duration', ['worker_id', 'status']),
    ).not.toThrow();
  });

  it('the_same_metric_name_on_two_different_registries_is_isolated_neither_throws', () => {
    // `createMetricsRegistry()` is explicitly documented as usable per-test
    // for isolation - registering the same name on two SEPARATE registries
    // must never collide, only the same-registry case (tested above) does.
    const registryOne = createMetricsRegistry();
    const registryTwo = createMetricsRegistry();

    expect(() =>
      registryOne.counter('wp_isolated_total', 'isolated counter', ['worker_id']),
    ).not.toThrow();
    expect(() =>
      registryTwo.counter('wp_isolated_total', 'isolated counter', ['worker_id']),
    ).not.toThrow();
  });

  it('label VALUES are never validated only label NAMES are - by design', async () => {
    // The policy (`assertMetricRegistrationAllowed`) checks label NAMES at
    // registration time; it never inspects the cardinality/content of label
    // VALUES supplied later at observation time. A caller can still hand an
    // unbounded-cardinality value (e.g. a raw error message) through an
    // allow-listed label name like `error_class` - this is a real, documented
    // limitation of name-only policing, pinned here rather than assumed.
    const { counter, registry } = createMetricsRegistry();
    const c = counter('wp_errors_total', 'errors', ['error_class']);

    expect(() =>
      c.inc({ error_class: 'literally-anything-unbounded-cardinality-here' }),
    ).not.toThrow();

    const text = await registry.metrics();
    expect(text).toContain('literally-anything-unbounded-cardinality-here');
  });
});
