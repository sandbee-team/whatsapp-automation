import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindBroadcastMetrics } from '../../platform/metrics/broadcast-metrics.js';
import {
  buildCancelBookkeepingOnBatch,
  buildExpansionOnBatch,
  buildSnapshotOnBatch,
} from './cron-wiring-broadcasts.js';

/**
 * cron-wiring-broadcasts-metrics.test.ts (P23 Unit U6b, follow-up to U6) -
 * proves the three `on*OnBatch` builders `cron-wiring-broadcasts.ts` wires
 * into `createBroadcastCronLoops`'s sweeps actually increment/observe
 * `bindBroadcastMetrics()`'s handles (U6 registered the metrics but never
 * incremented them - see the phase file's "Descoped by U6" note). Invokes
 * the built callbacks directly with exact inputs (never through the
 * single-flight lock/real pool machinery - that shape is proven by
 * `cron-loop.test.ts` and `single-flight.integration.test.ts` already), and
 * asserts EXACT counter/histogram values (core-invariants.md's "units and
 * quantities" rule - never a bound).
 */
describe('broadcast cron onBatch metric wiring', () => {
  it('a_snapshot_batch_of_pending_3_skipped_2_increments_recipients_total_by_exactly_those_amounts', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindBroadcastMetrics(registry);
    const onBatch = buildSnapshotOnBatch(metrics);

    onBatch({ campaignId: 'c1', pending: 3, skipped: 2 });

    const text = await registry.metricsText();
    expect(text).toContain('wp_broadcast_recipients_total{status="pending"} 3');
    expect(text).toContain('wp_broadcast_recipients_total{status="skipped"} 2');
  });

  it('an_expansion_batch_of_queued_500_failed_1_increments_recipients_total_and_observes_one_lag_sample', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindBroadcastMetrics(registry);
    const onBatch = buildExpansionOnBatch(metrics);

    onBatch({ campaignId: 'c1', inserted: 500, renderFailed: 1, statements: 1, lagSeconds: 4.2 });

    const text = await registry.metricsText();
    expect(text).toContain('wp_broadcast_recipients_total{status="queued"} 500');
    expect(text).toContain('wp_broadcast_recipients_total{status="failed"} 1');
    expect(text).toContain('wp_broadcast_expansion_lag_seconds_count 1');
    expect(text).toContain('wp_broadcast_expansion_lag_seconds_sum 4.2');
  });

  it('an_expansion_batch_with_no_lag_seconds_observes_nothing', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindBroadcastMetrics(registry);
    const onBatch = buildExpansionOnBatch(metrics);

    onBatch({ campaignId: 'c1', inserted: 10, renderFailed: 0, statements: 1 });

    const text = await registry.metricsText();
    expect(text).toContain('wp_broadcast_expansion_lag_seconds_count 0');
  });

  it('a_cancel_bookkeeping_batch_of_7_increments_recipients_total_cancelled_by_exactly_7', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindBroadcastMetrics(registry);
    const onBatch = buildCancelBookkeepingOnBatch(metrics);

    onBatch({ campaignId: 'c1', cancelledRecipients: 7 });

    const text = await registry.metricsText();
    expect(text).toContain('wp_broadcast_recipients_total{status="cancelled"} 7');
  });

  it('no_broadcast_metric_carries_a_client_id_or_instance_id_label', async () => {
    const registry = createMetricsRegistry();
    const metrics = bindBroadcastMetrics(registry);

    buildSnapshotOnBatch(metrics)({ campaignId: 'c1', pending: 1, skipped: 0 });
    buildExpansionOnBatch(metrics)({
      campaignId: 'c1',
      inserted: 1,
      renderFailed: 0,
      statements: 1,
      lagSeconds: 1,
    });
    buildCancelBookkeepingOnBatch(metrics)({ campaignId: 'c1', cancelledRecipients: 1 });

    const text = await registry.metricsText();
    expect(text).not.toMatch(/client_id=/);
    expect(text).not.toMatch(/instance_id=/);
  });
});
