import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';
import type { WaLinkState } from '@wp/domain';

/**
 * engine/session/metrics.ts (P25 observability-and-runbook, unit U1b) - the
 * session runner's own two gap-fill metrics, following the same idempotent-
 * registration `WeakMap` pattern as `platform/metrics/discovery-metrics.ts`/
 * `modules/pacing/health/metrics.ts`.
 *
 *   - `wp_instance_link_state{instance_id,client_id}` (gauge) - one of the
 *     four allow-listed `INSTANCE_LABELLED_GAUGES`
 *     (`@wp/server-kit`'s `metric-policy.ts`) - registered here for the
 *     first time (audit found it declared on the allow-list but never
 *     actually registered anywhere). NUMERIC ENCODING: `LINK_STATE_GAUGE_
 *     VALUES` mirrors `@wp/domain`'s `WA_LINK_STATES` array order exactly
 *     (`unlinked, pairing, linked` -> `0, 1, 2`), same discipline as
 *     `modules/pacing/health/metrics.ts`'s `HEALTH_STATE_GAUGE_VALUES`
 *     mirroring `WA_HEALTHS`. Set via `setInstanceLinkStateGauge` at
 *     `modules/instances/repo.ts`'s real `link_state` write points
 *     (`markLinkedConnected` -> 'linked', `markLoggedOut` -> 'unlinked',
 *     `applyTransitionWrite` -> `input.linkState` when non-null).
 *   - `wp_reconnect_attempts_total{reason}` (counter) - one increment per
 *     reconnect actually SCHEDULED (never per disconnect seen) by
 *     `runner-disconnect.ts#scheduleReconnectOrGiveUp`, labelled by a small
 *     closed reason set derived from what that function already has in
 *     scope: `restart515` (the immediate-retry 515 budget path),
 *     `multiplied_backoff` (a jittered delay with a non-default base
 *     multiplier), or `backoff` (the plain jittered delay). Never a raw
 *     numeric disconnect status code as the label value (`code` is not an
 *     allowed label) and never tenant-scoped.
 */

export const LINK_STATE_GAUGE_VALUES = {
  unlinked: 0,
  pairing: 1,
  linked: 2,
} as const satisfies Record<WaLinkState, number>;

export type ReconnectReason = 'restart515' | 'multiplied_backoff' | 'backoff';

export interface SessionMetricsHandles {
  instanceLinkState: ReturnType<MetricsRegistry['gauge']>;
  reconnectAttemptsTotal: ReturnType<MetricsRegistry['counter']>;
  credsSaveBufferTotal: ReturnType<MetricsRegistry['counter']>;
}

const registeredMetrics = new WeakMap<MetricsRegistry, SessionMetricsHandles>();

export function bindSessionMetrics(
  registry: MetricsRegistry = defaultMetrics,
): SessionMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const handles: SessionMetricsHandles = {
    instanceLinkState: registry.gauge(
      'wp_instance_link_state',
      'Per-instance whatsapp_instances.link_state, numerically encoded (0 unlinked, 1 pairing, 2 linked; label names: instance_id, client_id)',
      ['instance_id', 'client_id'],
    ),
    reconnectAttemptsTotal: registry.counter(
      'wp_reconnect_attempts_total',
      'Reconnect attempts actually scheduled, by disconnect reason class',
      ['reason'],
    ),
    // P26 U6a (chaos: Postgres outage) - `CredsSaveBufferEventKind` mapped
    // 1:1 onto the `result` label (`flush_failed_pg_unavailable` -> `flush_failed`).
    credsSaveBufferTotal: registry.counter(
      'wp_creds_save_buffer_total',
      'Creds-save-buffer outcomes (buffered/dropped/flushed/flush_failed) during a Postgres availability failure',
      ['result'],
    ),
  };

  registeredMetrics.set(registry, handles);
  return handles;
}

export interface SetInstanceLinkStateGaugeInput {
  instanceId: string;
  clientId: string;
  linkState: WaLinkState;
}

/** Sets `wp_instance_link_state` to this instance's exact numerically-encoded `link_state` (see this module's own `LINK_STATE_GAUGE_VALUES` doc) - called from `modules/instances/repo.ts`'s own `link_state` write points only. */
export function setInstanceLinkStateGauge(
  input: SetInstanceLinkStateGaugeInput,
  registry: MetricsRegistry = defaultMetrics,
): void {
  const handles = bindSessionMetrics(registry);
  handles.instanceLinkState.set(
    { instance_id: input.instanceId, client_id: input.clientId },
    LINK_STATE_GAUGE_VALUES[input.linkState],
  );
}

/** Confirms this scheduled reconnect at `runner-disconnect.ts#scheduleReconnectOrGiveUp` - never called for a disconnect that gave up instead of reconnecting. */
export function recordReconnectAttempt(
  reason: ReconnectReason,
  registry: MetricsRegistry = defaultMetrics,
): void {
  const handles = bindSessionMetrics(registry);
  handles.reconnectAttemptsTotal.inc({ reason });
}

/** `CredsSaveBufferEventKind` -> the `result` label (`flush_failed_pg_unavailable` collapses to `flush_failed`). */
export function recordCredsSaveBufferEvent(
  kind: 'buffered' | 'dropped' | 'flushed' | 'flush_failed_pg_unavailable',
  registry: MetricsRegistry = defaultMetrics,
): void {
  const handles = bindSessionMetrics(registry);
  const result = kind === 'flush_failed_pg_unavailable' ? 'flush_failed' : kind;
  handles.credsSaveBufferTotal.inc({ result });
}
