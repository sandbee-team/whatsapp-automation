import { metrics as defaultMetrics, type MetricsRegistry } from '@wp/server-kit';

/**
 * platform/metrics/groups-metrics.ts (P24 step 10) - the two group metrics the
 * scope delta's "Observability (one rule, not two)" section names:
 *
 *   - `wp_group_sends_total{result}` (counter) - one increment per group-send
 *     result write: `sent` | `failed` | `group_forbidden`. `result` is on
 *     `ALLOWED_LABELS`; the value set is closed (see `GROUP_SEND_RESULTS`).
 *   - `wp_group_sync_seconds` (histogram, no label) - wall-clock seconds of one
 *     `groupFetchAllParticipating` sync for one instance.
 *
 * No `client_id`/`instance_id` label on either (10k-label rule) and never a
 * group subject or JID in a label value. Same idempotent-registration
 * `WeakMap` pattern as every other metrics module in this tree.
 */

export const GROUP_SEND_RESULTS = ['sent', 'failed', 'group_forbidden'] as const;
export type GroupSendResult = (typeof GROUP_SEND_RESULTS)[number];

export interface GroupsMetricsHandles {
  sendsTotal: ReturnType<MetricsRegistry['counter']>;
  syncSeconds: ReturnType<MetricsRegistry['histogram']>;
  incrementGroupSend: (result: GroupSendResult) => void;
  observeSyncSeconds: (seconds: number) => void;
}

const registeredMetrics = new WeakMap<MetricsRegistry, GroupsMetricsHandles>();

export function bindGroupsMetrics(
  registry: MetricsRegistry = defaultMetrics,
): GroupsMetricsHandles {
  const existing = registeredMetrics.get(registry);
  if (existing) {
    return existing;
  }

  const sendsTotal = registry.counter(
    'wp_group_sends_total',
    'Group message send results, by result (sent | failed | group_forbidden)',
    ['result'],
  );
  const syncSeconds = registry.histogram(
    'wp_group_sync_seconds',
    'Seconds taken by one wa_groups sync (groupFetchAllParticipating) for one instance',
  );

  const handles: GroupsMetricsHandles = {
    sendsTotal,
    syncSeconds,
    incrementGroupSend: (result) => {
      sendsTotal.inc({ result });
    },
    observeSyncSeconds: (seconds) => {
      syncSeconds.observe(seconds);
    },
  };
  registeredMetrics.set(registry, handles);
  return handles;
}
