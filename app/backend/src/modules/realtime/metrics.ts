import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { RealtimeHub } from './hub.js';

/**
 * modules/realtime/metrics.ts (P05 Unit U3b) - registers the four real-time
 * Prometheus metrics named by the phase's observability step:
 *   - `wp_sse_connections` (gauge, no label) - bound to
 *     `hub.onConnectionCountChange`. Registered NOW even though nothing
 *     alerts on it yet - ADR 0010's Centrifugo escalation trigger is
 *     "concurrent SSE connections per api process > ~4,000" (canon).
 *   - `wp_sse_drops_total{reason}` (counter) - bound to `hub.onDrop`.
 *   - `wp_sse_subscriptions_refused_total` (counter, no label) - bound to
 *     the `onSubscriptionRefused` port `RealtimeCtx` already carries
 *     (service.ts, U3a) - this unit wires it to something real instead of
 *     the no-op `roles/api.ts` had.
 *   - `wp_sse_authz_tick_errors_total` (counter, no label) - incremented by
 *     `authz-tick.ts` on every failed tick query (core invariant 2).
 *
 * `reason` is on `ALLOWED_LABELS` and is not one of the four
 * `INSTANCE_LABELLED_GAUGES`-only tenant-scoped labels, so `wp_sse_drops_total`
 * registers cleanly under `metric-policy.ts` as a plain counter.
 *
 * Idempotent registration: `bindRealtimeMetrics` is called once per process
 * in production (`roles/api.ts`), but tests re-import this module (and the
 * shared `@wp/server-kit` `metrics` singleton) across multiple test files in
 * the same process - a naive second `registry.counter(...)` call would throw
 * ("duplicate metric registration"). A `WeakMap` keyed by the registry
 * instance makes a second `bindRealtimeMetrics(hub, registry)` call for the
 * SAME registry a safe, idempotent no-op - registries built by
 * `createMetricsRegistry()` per-test (a NEW registry each time) are
 * unaffected and register normally.
 *
 * That idempotency covers metric REGISTRATION only unless the hub event
 * callbacks (`hub.onConnectionCountChange`/`hub.onDrop`) are ALSO gated on
 * the same `existing` check - otherwise every re-bind call for the same
 * registry (even with the SAME hub instance) adds another pair of
 * callbacks, and a single hub event then increments/sets the same metric
 * multiple times. `bindHubCallbacks` below runs exactly once per registry,
 * for whichever hub the FIRST `bindRealtimeMetrics(hub, registry)` call for
 * that registry was given - a later call with a DIFFERENT hub for the same
 * registry intentionally does not rebind (documented limitation: this
 * repo's only production call site binds one hub per process for the
 * process's lifetime, so this can't recur there; if a future caller needs
 * multiple hubs sharing one registry, it must pass distinct registries).
 */

export interface RealtimeMetricsHandles {
  connections: ReturnType<MetricsRegistry['gauge']>;
  dropsTotal: ReturnType<MetricsRegistry['counter']>;
  subscriptionsRefusedTotal: ReturnType<MetricsRegistry['counter']>;
  authzTickErrorsTotal: ReturnType<MetricsRegistry['counter']>;
  /** Pass straight through to `RealtimeCtx.onSubscriptionRefused`. */
  onSubscriptionRefused: () => void;
  /** Pass straight through to `authz-tick.ts`'s `AuthzTickMetricsPort`. */
  incrementAuthzTickErrors: () => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, RealtimeMetricsHandles>();

/**
 * Registers (or, on a repeat call for the SAME registry, reuses) the four
 * real-time metrics and wires them to `hub`'s own event hooks. Returns the
 * raw metric handles plus the two increment functions callers plug directly
 * into `RealtimeCtx.onSubscriptionRefused` / `AuthzTickMetricsPort`.
 */
export function bindRealtimeMetrics(
  hub: RealtimeHub,
  registry: MetricsRegistry = defaultMetrics,
): RealtimeMetricsHandles {
  const existing = registeredMetrics.get(registry);
  const handles: RealtimeMetricsHandles = existing ?? {
    connections: registry.gauge('wp_sse_connections', 'current open SSE connections'),
    dropsTotal: registry.counter('wp_sse_drops_total', 'SSE connections dropped, by reason', [
      'reason',
    ]),
    subscriptionsRefusedTotal: registry.counter(
      'wp_sse_subscriptions_refused_total',
      'SSE instance-channel subscription requests refused (not owned by caller)',
    ),
    authzTickErrorsTotal: registry.counter(
      'wp_sse_authz_tick_errors_total',
      'SSE re-authorisation tick query failures',
    ),
    onSubscriptionRefused: () => {},
    incrementAuthzTickErrors: () => {},
  };

  if (!existing) {
    handles.onSubscriptionRefused = () => {
      handles.subscriptionsRefusedTotal.inc();
    };
    handles.incrementAuthzTickErrors = () => {
      handles.authzTickErrorsTotal.inc();
    };
    registeredMetrics.set(registry, handles);

    // Hub event callbacks are bound exactly once per registry, alongside
    // metric registration itself (same `!existing` gate) - a re-bind call
    // for the same registry must be a true no-op here too, not just for the
    // `registry.counter(...)`/`registry.gauge(...)` calls above.
    hub.onConnectionCountChange((count) => {
      handles.connections.set(count);
    });
    hub.onDrop((reason) => {
      handles.dropsTotal.inc({ reason });
    });
  }

  return handles;
}
