import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@wp/contracts';
import { queryKeysForRealtimeEvent } from '../../../lib/sse-invalidation-map.js';
import { notificationKeys } from '../keys.js';
import { instanceKeys } from '../../instances/keys.js';
import { dashboardKeys } from '../../dashboard/keys.js';
import { jobKeys } from '../../jobs/keys.js';

/**
 * bell.test.tsx (P17 U5) - drives `lib/sse-invalidation-map.ts`'s static
 * map DIRECTLY (never through a rendered component/SSE stream) with a
 * `notification.created` event, and asserts it invalidates EXACTLY the two
 * notification query keys - never an instance/dashboard/job key. This is
 * the binding fact the phase spec calls out by name:
 * `a_notification_created_event_invalidates_only_the_notification_keys`.
 */
describe('notification.created invalidation scoping', () => {
  it('a_notification_created_event_invalidates_only_the_notification_keys', () => {
    const event: RealtimeEvent = {
      type: 'notification.created',
      notificationId: '22222222-2222-2222-2222-222222222222',
      kind: 'instance_paused',
      severity: 'critical',
      instanceId: '11111111-1111-1111-1111-111111111111',
    };

    const invalidatedKeys = queryKeysForRealtimeEvent(event);

    expect(invalidatedKeys).toEqual([notificationKeys.list(), notificationKeys.unreadCount()]);

    // Explicit negative proof: no instance/dashboard/job key of any shape
    // appears among the invalidated keys, even though this event carries an
    // `instanceId` - a notification is a "go look at the notification
    // surface" hint only, never a shortcut to invalidate the instance/
    // dashboard caches too.
    const serialized = invalidatedKeys.map((key) => JSON.stringify(key));
    expect(serialized).not.toContain(JSON.stringify(instanceKeys.detail(event.instanceId ?? '')));
    expect(serialized).not.toContain(JSON.stringify(instanceKeys.card(event.instanceId ?? '')));
    expect(serialized).not.toContain(JSON.stringify(dashboardKeys.summary()));
    expect(serialized).not.toContain(JSON.stringify(jobKeys.needsAction()));
  });
});
