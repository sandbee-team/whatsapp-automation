import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * engine/fleet/metrics.ts (P09 Unit U1) - registers the six minimum
 * worker-fleet metrics (ADR 0018 S4/S7): five gauges plus one histogram.
 * None of them carries `instance_id` - they are worker- or box-scoped, not
 * per-instance (per-instance detail stays in the four dashboard gauges in
 * `@wp/server-kit`'s `INSTANCE_LABELLED_GAUGES` allow-list, which this
 * module does not touch or extend):
 *
 *   - `wp_worker_sessions` (gauge) - sessions currently held by this worker.
 *   - `wp_worker_eventloop_lag_p99` (gauge) - p99 event-loop delay (ms),
 *     from `perf_hooks.monitorEventLoopDelay()`.
 *   - `wp_session_rss_bytes_est` (gauge) - the SLOPE of RSS vs session count
 *     over the sampler's ring buffer, not total RSS / session count (see
 *     `sampler.ts`'s `estimateSessionRssSlopeBytes`). Never set from a
 *     garbage division - the sampler skips the `.set()` call entirely when
 *     the estimate is unavailable.
 *   - `wp_box_rss_bytes` (gauge) - HOST-level `os.totalmem() - os.freemem()`,
 *     not this process's own RSS - many per-worker-healthy processes can
 *     still OOM the box together.
 *   - `wp_worker_session_cap` (gauge) - this worker's `deriveSessionCap()`
 *     output, so operators can see budget vs actual sessions on one graph.
 *   - `wp_session_measured_mb` (gauge) - P10 U6 step 9's production feedback
 *     loop: the accepted 24h-trimmed-mean measured per-session mb
 *     (`session-cost-feedback.ts`'s `computeSessionCostFeedback` output),
 *     worker-scoped like every other gauge here - never `instance_id`
 *     labelled (four-gauge allow-list in `@wp/server-kit` stays untouched).
 *   - `wp_connect_bucket_wait_seconds` (histogram) - wait time in the
 *     connect-rate bucket/gate before a session is allowed to link.
 *
 * Same idempotent-registration pattern as `platform/metrics/lease-metrics.ts`:
 * a `WeakMap` keyed by the registry makes re-binding the SAME registry a
 * no-op (production binds once per process; tests re-import across files
 * sharing the default registry).
 */

export interface FleetMetricsHandles {
  workerSessions: ReturnType<MetricsRegistry['gauge']>;
  eventLoopLagP99: ReturnType<MetricsRegistry['gauge']>;
  sessionRssBytesEst: ReturnType<MetricsRegistry['gauge']>;
  boxRssBytes: ReturnType<MetricsRegistry['gauge']>;
  workerSessionCap: ReturnType<MetricsRegistry['gauge']>;
  sessionMeasuredMb: ReturnType<MetricsRegistry['gauge']>;
  connectBucketWaitSeconds: ReturnType<MetricsRegistry['histogram']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, FleetMetricsHandles>();

export function bindFleetMetrics(registry: MetricsRegistry = defaultMetrics): FleetMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const handles: FleetMetricsHandles = {
    workerSessions: registry.gauge('wp_worker_sessions', 'Sessions currently held by this worker'),
    eventLoopLagP99: registry.gauge(
      'wp_worker_eventloop_lag_p99',
      'p99 event-loop delay in milliseconds for this worker',
    ),
    sessionRssBytesEst: registry.gauge(
      'wp_session_rss_bytes_est',
      'Estimated per-session RSS footprint (slope of RSS vs session count), in bytes',
    ),
    boxRssBytes: registry.gauge(
      'wp_box_rss_bytes',
      'Host-level used memory (os.totalmem() - os.freemem()), in bytes',
    ),
    workerSessionCap: registry.gauge(
      'wp_worker_session_cap',
      "This worker's derived session cap (deriveSessionCap output)",
    ),
    sessionMeasuredMb: registry.gauge(
      'wp_session_measured_mb',
      'Accepted 24h-trimmed-mean measured per-session RSS footprint, in MB (session-cost-feedback loop)',
    ),
    connectBucketWaitSeconds: registry.histogram(
      'wp_connect_bucket_wait_seconds',
      'Time a session waited in the connect-rate bucket before being allowed to link, in seconds',
    ),
  };

  registeredMetrics.set(registry, handles);
  return handles;
}
