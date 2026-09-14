import { createMetricsRegistry } from '@wp/server-kit';
import { describe, expect, it } from 'vitest';
import { bindRelayMetrics } from './relay-metrics.js';

/**
 * relay-metrics.test.ts (P15 U4, step 5) - registration-time smoke: every
 * one of the five metrics the phase task names verbatim registers without
 * throwing (proves `fanout`/`topic_class` are accepted by
 * `@wp/server-kit`'s label allow-list), and a second bind against the SAME
 * registry is a safe no-op (idempotent-registration convention shared by
 * every sibling metrics module).
 */
describe('bindRelayMetrics', () => {
  it('registers_all_five_metrics_without_throwing', () => {
    const registry = createMetricsRegistry();
    expect(() => bindRelayMetrics(registry)).not.toThrow();
  });

  it('a_second_bind_for_the_same_registry_is_a_safe_no_op', () => {
    const registry = createMetricsRegistry();
    const first = bindRelayMetrics(registry);
    const second = bindRelayMetrics(registry);
    expect(second).toBe(first);
  });

  it('increments_and_observations_do_not_throw', () => {
    const registry = createMetricsRegistry();
    const handles = bindRelayMetrics(registry);

    expect(() => {
      handles.setOutboxDepth(42);
      handles.observePublishLagSeconds(1.5);
      handles.incrementEventsPublished('sse');
      handles.incrementEventsPublished('webhook');
      handles.incrementSseCoalesced(3);
      handles.incrementDropped('instance.pacing_changed', 2);
    }).not.toThrow();
  });
});
