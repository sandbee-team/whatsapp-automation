import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { ALLOWED_LABELS, createMetricsRegistry } from '@wp/server-kit';
import { bindPacingMetrics } from './metrics.js';

/**
 * `labelNames` is a REAL runtime property on every prom-client `Counter`/
 * `Histogram` instance (verified live) but is NOT part of prom-client's
 * public `.d.ts` (pre-existing gap this file's own typecheck already hit -
 * fixed here as part of this fix round's ladder, not a new finding). This
 * narrow helper is the ONLY place that reaches past the public type.
 */
function labelNamesOf(metric: unknown): readonly string[] {
  const labelNames = (metric as { labelNames?: unknown }).labelNames;
  return Array.isArray(labelNames) ? (labelNames as readonly string[]) : [];
}

/**
 * metrics.test.ts (P13a Unit U2, step 10) - registration-time policy check
 * over the four pacing metric names (`wp_pacing_reserve_seconds`,
 * `wp_pacing_deferrals_total{reason}`, `wp_pacing_denies_total{reason}`,
 * `wp_warmup_tier_changes_total{result}`). Every declared label must be on
 * `@wp/server-kit`'s `ALLOWED_LABELS`, and neither `instance_id` nor
 * `client_id` may appear on any of the four (P13a's own carried-over
 * blocker: `direction` is not an allowed label name, so the tier-change
 * metric uses `result` with values `advance`/`rollback` - the
 * `wp_reaper_repairs_total{result}` precedent from P12).
 */
describe('bindPacingMetrics', () => {
  it('every_pacing_metric_label_is_on_the_allow_list_and_none_is_instance_scoped', () => {
    const registry = createMetricsRegistry();
    const handles = bindPacingMetrics(registry);

    const declared: Array<{ name: string; labelNames: readonly string[] }> = [
      { name: 'wp_pacing_reserve_seconds', labelNames: labelNamesOf(handles.reserveSeconds) },
      { name: 'wp_pacing_deferrals_total', labelNames: labelNamesOf(handles.deferralsTotal) },
      { name: 'wp_pacing_denies_total', labelNames: labelNamesOf(handles.deniesTotal) },
      {
        name: 'wp_warmup_tier_changes_total',
        labelNames: labelNamesOf(handles.tierChangesTotal),
      },
    ];

    for (const metric of declared) {
      for (const label of metric.labelNames) {
        expect(ALLOWED_LABELS.has(label)).toBe(true);
      }
      expect(metric.labelNames).not.toContain('instance_id');
      expect(metric.labelNames).not.toContain('client_id');
    }

    const tierChangeLabels = labelNamesOf(handles.tierChangesTotal);
    expect(tierChangeLabels).toEqual(['result']);
    expect(tierChangeLabels).not.toContain('direction');
  });

  it('rebinding_the_same_registry_is_idempotent', () => {
    const registry = createMetricsRegistry();
    const first = bindPacingMetrics(registry);
    const second = bindPacingMetrics(registry);
    expect(second).toBe(first);
  });

  it('warmup_metrics_seam_records_advance_and_rollback_via_the_result_label', async () => {
    // FIX ROUND MINOR 10 correction: read the counter back from the
    // registry (prom-client's `getSingleMetric(...).get()` idiom) instead
    // of only asserting "does not throw" - the seam recording a value into
    // the WRONG label (or not incrementing at all) would still pass a
    // does-not-throw-only assertion.
    const registry = createMetricsRegistry();
    const handles = bindPacingMetrics(registry);

    handles.warmupMetrics.tierChange('advance');

    const metric = registry.registry.getSingleMetric('wp_warmup_tier_changes_total');
    expect(metric).toBeDefined();
    const snapshot = await metric!.get();
    const advanceSample = snapshot.values.find((v) => v.labels.result === 'advance');
    expect(advanceSample?.value).toBe(1);

    handles.warmupMetrics.tierChange('rollback');
    const snapshotAfterRollback = await metric!.get();
    const rollbackSample = snapshotAfterRollback.values.find((v) => v.labels.result === 'rollback');
    expect(rollbackSample?.value).toBe(1);
    // The advance count is untouched by the rollback call.
    const advanceAfterRollback = snapshotAfterRollback.values.find(
      (v) => v.labels.result === 'advance',
    );
    expect(advanceAfterRollback?.value).toBe(1);
  });
});
