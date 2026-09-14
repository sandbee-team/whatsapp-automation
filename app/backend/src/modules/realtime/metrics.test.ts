import './__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { createRealtimeHub } from './hub.js';
import { bindRealtimeMetrics } from './metrics.js';
import { fakeSink } from './__tests__/hub-test-support.js';

/**
 * metrics.test.ts (P05 FIXA note-fix) - `bindRealtimeMetrics`'s idempotent
 * registration is documented as covering metric REGISTRATION (the `WeakMap`
 * short-circuits `registry.counter(...)`/`registry.gauge(...)` calls that
 * would otherwise throw "duplicate metric registration"), but a second call
 * for the SAME registry must ALSO be a true no-op for the hub event
 * callbacks (`hub.onConnectionCountChange`/`hub.onDrop`) - otherwise each
 * re-bind call accumulates ANOTHER pair of callbacks and a single hub event
 * increments/sets the same metric multiple times.
 */

async function counterValue(metricsText: string, metricName: string): Promise<number> {
  const line = metricsText.split('\n').find((l) => l.startsWith(metricName) && !l.startsWith('#'));
  if (!line) return 0;
  const value = line.split(' ').at(-1);
  return value ? Number(value) : 0;
}

describe('bindRealtimeMetrics - re-bind idempotency', () => {
  it('binding_the_same_hub_to_the_same_registry_twice_does_not_double_count_a_single_drop', async () => {
    const registry = createMetricsRegistry();
    const hub = createRealtimeHub({ replayRingSize: 10 });

    // Re-bind the SAME hub to the SAME registry - metric registration is
    // already documented idempotent; the hub event CALLBACKS must be too.
    bindRealtimeMetrics(hub, registry);
    bindRealtimeMetrics(hub, registry);

    const clientId = randomUUID();
    const connectionId = randomUUID();
    const sink = fakeSink();
    hub.connect({
      connectionId,
      userId: randomUUID(),
      sessionId: randomUUID(),
      clientId,
      epoch: 0,
      channels: [`client:${clientId}`],
      sink: sink.sink,
    });

    // Exactly ONE drop happens - `wp_sse_drops_total{reason="server_shutdown"}`
    // must read 1, not 2 (one increment per re-bind's own duplicate callback).
    hub.disconnect(connectionId, 'server_shutdown');

    const text = await registry.metricsText();
    const value = await counterValue(text, 'wp_sse_drops_total{reason="server_shutdown"}');
    expect(value).toBe(1);
  });
});
