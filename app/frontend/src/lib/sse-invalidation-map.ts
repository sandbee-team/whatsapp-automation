import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { RealtimeEvent, RealtimeEventType } from '@wp/contracts';
import { broadcastKeys } from '../features/broadcasts/keys.js';
import { dashboardKeys } from '../features/dashboard/keys.js';
import { instanceKeys } from '../features/instances/keys.js';
import { jobKeys } from '../features/jobs/keys.js';
import { notificationKeys } from '../features/notifications/keys.js';
import { webhookKeys } from '../features/webhooks/keys.js';

/**
 * lib/sse-invalidation-map.ts - the STATIC event -> query-key invalidation
 * map (canon, binding - see the phase spec's "Invalidation map" section).
 * Split out of `lib/sse.ts` to stay under the workspace's 300-line
 * max-lines lint rule. Every entry returns the EXACT key shape(s) that
 * event type invalidates - never a same-prefix catch-all - so
 * `invalidateQueries({ queryKey })` touches only the intended cache
 * entries.
 */
const INVALIDATION_MAP: Record<RealtimeEventType, (event: RealtimeEvent) => QueryKey[]> = {
  'instance.qr': (event) => {
    const e = event as Extract<RealtimeEvent, { type: 'instance.qr' }>;
    return [instanceKeys.qr(e.instanceId)];
  },
  'instance.health_changed': (event) => {
    const e = event as Extract<RealtimeEvent, { type: 'instance.health_changed' }>;
    return [
      instanceKeys.detail(e.instanceId),
      instanceKeys.card(e.instanceId),
      dashboardKeys.summary(),
    ];
  },
  'instance.pacing_changed': (event) => {
    const e = event as Extract<RealtimeEvent, { type: 'instance.pacing_changed' }>;
    return [instanceKeys.pacing(e.instanceId)];
  },
  'message.job.status_changed': (event) => {
    const e = event as Extract<RealtimeEvent, { type: 'message.job.status_changed' }>;
    return [jobKeys.detail(e.jobPublicId), jobKeys.list(e.instanceId), dashboardKeys.summary()];
  },
  'job.needs_user_action': () => [jobKeys.needsAction()],
  'campaign.progress': (event) => {
    const e = event as Extract<RealtimeEvent, { type: 'campaign.progress' }>;
    return [broadcastKeys.detail(e.campaignId), broadcastKeys.list()];
  },
  // P15 U5 added this event type AFTER U6 wrote this map (sequencing gap
  // caught at FIXA): a dispatcher-side auto-disable must refresh the
  // endpoint list so the disabled banner appears without a manual reload.
  'webhook.endpoint_disabled': () => [webhookKeys.list()],
  // P17 Unit U5 (this unit): a new notification row refreshes ONLY the
  // notification list/badge - never an instance/dashboard key. The bell's
  // own test (`bell.test.tsx`) asserts this map entry returns exactly these
  // two keys and touches nothing else.
  'notification.created': () => [notificationKeys.list(), notificationKeys.unreadCount()],
};

/** True if `type` is one of the six real event types the invalidation map covers. */
export function isKnownRealtimeEventType(type: string): type is RealtimeEventType {
  return Object.hasOwn(INVALIDATION_MAP, type);
}

/**
 * The query key(s) one event maps to, per the static map above. Split out
 * from `invalidateForRealtimeEvent` so `sse-stream-consumer.ts`'s `batch`
 * frame handling (P15 U6) can dedupe keys across up to 25 events BEFORE
 * calling `invalidateQueries`, instead of invalidating per-event.
 */
export function queryKeysForRealtimeEvent(event: RealtimeEvent): QueryKey[] {
  return INVALIDATION_MAP[event.type]?.(event) ?? [];
}

/** Invalidates every query key the given event's type maps to. */
export function invalidateForRealtimeEvent(queryClient: QueryClient, event: RealtimeEvent): void {
  for (const queryKey of queryKeysForRealtimeEvent(event)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
