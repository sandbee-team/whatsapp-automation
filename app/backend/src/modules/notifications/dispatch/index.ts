/**
 * modules/notifications/dispatch/index.ts (P17 U3, step 4) - the channel
 * dispatchers' public surface. `sse.ts`/`webhook.ts` export nothing (see
 * their own doc comments - both channels ride the EXISTING outbox pipeline
 * unchanged); `email.ts` is the one channel that needed new relay-side code.
 */
export {
  createEmailDispatchPort,
  HOURLY_CAP,
  CAP_WINDOW_SECONDS,
  type EmailDispatchPort,
  type EmailDispatchDeps,
  type EmailQueryClient,
  type EmailCapCounter,
  type EmailRecipient,
  type NotificationEmailRow,
} from './email.js';
// The relay role's production wiring for the email leg (moved out of
// src/roles/ at P17 close - check-role-boot treats every file there as a
// role entrypoint, and this is wiring).
export { createRelayEmailFanoutPort, createRedisEmailCapCounter } from './relay-email-fanout.js';
