/**
 * modules/notifications/index.ts (P17 U3, step 3/4) - the notifications
 * module's public surface: `notify()` (the one way any transaction writes a
 * notification + its per-channel outbox fan-out) plus the relay-side channel
 * dispatchers (`dispatch/`).
 */
export {
  notify,
  buildNotificationDedupeKey,
  type NotifyInput,
  type NotifyResult,
} from './notify.js';
export * from './dispatch/index.js';

// P17 Unit U6 (step 6): the in-app notifications list/unread-count/mark-read API.
export {
  registerNotificationsRoutes,
  type NotificationsRoutesDeps,
} from './notifications.routes.js';
