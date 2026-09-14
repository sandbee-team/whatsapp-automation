import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindFleetMetrics } from './metrics.js';
import { estimateSessionRssSlopeBytes } from './sampler.js';

/**
 * metrics.test.ts (P09 Unit U1) - the six worker/box-level fleet gauges +
 * histogram register cleanly (none of them carries `instance_id` - they are
 * worker/box-scoped, not per-instance), and the pre-existing four-gauge
 * `instance_id` allow-list in `@wp/server-kit`'s metric-policy still fires
 * when something tries to register a fifth instance_id-labelled gauge (this
 * unit adds no new fleet metric with that label - the allow-list itself
 * already exists and is exercised here, not re-implemented).
 */
describe('bindFleetMetrics', () => {
  it('registers_the_six_fleet_metrics_with_no_instance_id_label', () => {
    const registry = createMetricsRegistry();
    const handles = bindFleetMetrics(registry);

    expect(handles.workerSessions).toBeDefined();
    expect(handles.eventLoopLagP99).toBeDefined();
    expect(handles.sessionRssBytesEst).toBeDefined();
    expect(handles.boxRssBytes).toBeDefined();
    expect(handles.workerSessionCap).toBeDefined();
    expect(handles.sessionMeasuredMb).toBeDefined();
    expect(handles.connectBucketWaitSeconds).toBeDefined();
  });

  it('rebinding_the_same_registry_is_idempotent', () => {
    const registry = createMetricsRegistry();
    const first = bindFleetMetrics(registry);
    const second = bindFleetMetrics(registry);
    expect(second).toBe(first);
  });

  it('instance_id_label_is_allowed_on_at_most_four_gauges', () => {
    const registry = createMetricsRegistry();

    // The four allow-listed dashboard gauges register fine with instance_id.
    expect(() =>
      registry.gauge('wp_instance_health_state', 'health', ['instance_id']),
    ).not.toThrow();

    // A fifth instance_id-labelled gauge - none of this unit's fleet metrics,
    // which are worker/box-level and carry no instance_id - is rejected by
    // the existing server-kit policy.
    expect(() =>
      registry.gauge('wp_worker_sessions', 'sessions on this worker', ['instance_id']),
    ).toThrow(/wp_worker_sessions/);
  });
});

describe('estimateSessionRssSlopeBytes', () => {
  it('session_rss_estimate_is_a_slope_not_total_over_n', () => {
    // Fixed baseline (process overhead) + a per-session ramp: rss = 200MB +
    // 20MB * sessions. The slope estimate should recover ~20MB/session, NOT
    // rss/sessions (which would include the 200MB baseline and be wildly
    // higher, e.g. at sessions=5: rss=300MB -> rss/sessions=60MB, nowhere
    // near the true 20MB/session slope).
    const baselineBytes = 200 * 1024 * 1024;
    const perSessionBytes = 20 * 1024 * 1024;
    const points = [1, 2, 3, 4, 5].map((sessions) => ({
      sessions,
      rssBytes: baselineBytes + perSessionBytes * sessions,
    }));

    const slope = estimateSessionRssSlopeBytes(points);

    expect(slope).not.toBeNull();
    expect(slope as number).toBeGreaterThan(perSessionBytes * 0.99);
    expect(slope as number).toBeLessThan(perSessionBytes * 1.01);

    // total/N sanity check: confirm the slope is nowhere near this garbage
    // estimate, proving the function is not doing rss/sessions.
    const lastPoint = points[points.length - 1]!;
    const totalOverN = lastPoint.rssBytes / lastPoint.sessions;
    expect(Math.abs((slope as number) - totalOverN)).toBeGreaterThan(perSessionBytes);
  });

  it('near_zero_session_count_variance_yields_no_estimate', () => {
    // All points at the same session count - no variance to regress against,
    // must publish nothing (null) rather than a garbage division.
    const points = [
      { sessions: 12, rssBytes: 500_000_000 },
      { sessions: 12, rssBytes: 510_000_000 },
      { sessions: 12, rssBytes: 505_000_000 },
    ];

    expect(estimateSessionRssSlopeBytes(points)).toBeNull();
  });

  it('fewer_than_two_points_yields_no_estimate', () => {
    expect(estimateSessionRssSlopeBytes([])).toBeNull();
    expect(estimateSessionRssSlopeBytes([{ sessions: 5, rssBytes: 100 }])).toBeNull();
  });
});
