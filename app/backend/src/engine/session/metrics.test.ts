import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { WA_LINK_STATES } from '@wp/domain';
import {
  bindSessionMetrics,
  LINK_STATE_GAUGE_VALUES,
  recordCredsSaveBufferEvent,
  recordReconnectAttempt,
  setInstanceLinkStateGauge,
} from './metrics.js';

/**
 * metrics.test.ts (P25 observability-and-runbook, unit U1b) - proves the two
 * session-runner gap-fill metrics: `wp_instance_link_state` (the fourth
 * allow-listed instance-labelled gauge, never registered before this unit)
 * and `wp_reconnect_attempts_total{reason}`.
 */
describe('bindSessionMetrics', () => {
  it('link_state_gauge_values_mirror_wa_link_states_order', () => {
    expect(Object.keys(LINK_STATE_GAUGE_VALUES)).toEqual([...WA_LINK_STATES]);
    WA_LINK_STATES.forEach((state, index) => {
      expect(LINK_STATE_GAUGE_VALUES[state]).toBe(index);
    });
  });

  it('set_instance_link_state_gauge_sets_the_encoded_value_for_the_instance', async () => {
    const registry = createMetricsRegistry();

    setInstanceLinkStateGauge({ instanceId: 'i1', clientId: 'c1', linkState: 'linked' }, registry);

    const text = await registry.metricsText();
    expect(text).toContain('wp_instance_link_state{instance_id="i1",client_id="c1"} 2');
  });

  it('a_fifth_instance_labelled_gauge_still_throws', () => {
    const registry = createMetricsRegistry();
    bindSessionMetrics(registry);

    expect(() =>
      registry.gauge('wp_instance_link_state_two', 'not on the allow-list', ['instance_id']),
    ).toThrow(/wp_instance_link_state_two/);
  });

  it('reconnect_attempts_counter_has_only_the_reason_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindSessionMetrics(registry);

    expect(() => handles.reconnectAttemptsTotal.inc({ reason: 'backoff' })).not.toThrow();
  });

  it('rebinding_the_same_registry_is_idempotent', () => {
    const registry = createMetricsRegistry();
    const first = bindSessionMetrics(registry);
    const second = bindSessionMetrics(registry);
    expect(second).toBe(first);
  });
});

describe('recordReconnectAttempt', () => {
  it('increments_the_reason_labelled_counter', async () => {
    const registry = createMetricsRegistry();
    const handles = bindSessionMetrics(registry);

    recordReconnectAttempt('restart515', registry);

    const value = await handles.reconnectAttemptsTotal.get();
    const sample = value.values.find((v) => v.labels.reason === 'restart515');
    expect(sample?.value).toBe(1);
  });
});

describe('recordCredsSaveBufferEvent', () => {
  it('increments_the_result_labelled_counter_for_each_kind', async () => {
    const registry = createMetricsRegistry();
    const handles = bindSessionMetrics(registry);

    recordCredsSaveBufferEvent('buffered', registry);
    recordCredsSaveBufferEvent('dropped', registry);
    recordCredsSaveBufferEvent('flushed', registry);
    recordCredsSaveBufferEvent('flush_failed_pg_unavailable', registry);

    const value = await handles.credsSaveBufferTotal.get();
    expect(value.values.find((v) => v.labels.result === 'buffered')?.value).toBe(1);
    expect(value.values.find((v) => v.labels.result === 'dropped')?.value).toBe(1);
    expect(value.values.find((v) => v.labels.result === 'flushed')?.value).toBe(1);
    expect(value.values.find((v) => v.labels.result === 'flush_failed')?.value).toBe(1);
    expect(
      value.values.find((v) => v.labels.result === 'flush_failed_pg_unavailable'),
    ).toBeUndefined();
  });
});
