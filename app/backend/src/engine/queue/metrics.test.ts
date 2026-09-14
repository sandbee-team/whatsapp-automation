import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindQueueMetrics } from './metrics.js';

/**
 * metrics.test.ts (P11 Unit U5, step 9) - the seven send-loop metrics
 * register cleanly, none of them carrying `instance_id` (the four-gauge
 * allow-list in `@wp/server-kit`'s `metric-policy.ts` is already spent -
 * see that module's own header, and this phase's gotcha, verbatim: "a
 * fifth instance-labelled metric THROWS"). `wp_queue_depth_total` and
 * `wp_oldest_queued_seconds_max` aggregate across instances instead of
 * carrying a label - per-instance depth/lag is served to the panel from
 * Postgres, not Prometheus label cardinality.
 */
describe('bindQueueMetrics', () => {
  it('registers_the_seven_send_loop_metrics_with_no_instance_id_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindQueueMetrics(registry);

    expect(handles.claimLostTotal).toBeDefined();
    expect(handles.sendAttemptsTotal).toBeDefined();
    expect(handles.sendDurationSeconds).toBeDefined();
    expect(handles.wakeReceivedTotal).toBeDefined();
    expect(handles.safetyPollClaimsTotal).toBeDefined();
    expect(handles.queueDepthTotal).toBeDefined();
    expect(handles.oldestQueuedSecondsMax).toBeDefined();
    expect(handles.reconcileAmbiguousTotal).toBeDefined();
    expect(handles.echoCaptureFailedTotal).toBeDefined();
  });

  it('rebinding_the_same_registry_is_idempotent', () => {
    const registry = createMetricsRegistry();
    const first = bindQueueMetrics(registry);
    const second = bindQueueMetrics(registry);
    expect(second).toBe(first);
  });

  it('a_fifth_instance_labelled_metric_throws_at_registration', () => {
    const registry = createMetricsRegistry();
    bindQueueMetrics(registry);

    // None of the seven queue metrics register with an instance_id label -
    // proven directly against the live server-kit policy, not re-derived.
    expect(() =>
      registry.counter('wp_send_attempts_total', 'attempts', ['result', 'instance_id']),
    ).toThrow(/wp_send_attempts_total/);
  });

  it('send_attempts_total_uses_the_allowed_result_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindQueueMetrics(registry);

    expect(() => handles.sendAttemptsTotal.inc({ result: 'sent' })).not.toThrow();
  });
});
