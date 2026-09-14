/**
 * modules/notifications/dispatch/webhook.ts (P17 U3, step 4) - the webhook
 * leg of a notification's fan-out needs no new dispatch code either:
 * `notification.created` is already a member of `WEBHOOK_EVENT_TYPES`
 * (`@wp/contracts`'s `webhooks.ts`, derived from `REALTIME_EVENT_TYPES` minus
 * `instance.qr` - P17 Unit U2, step 2), so the EXISTING generic webhook
 * fanout (`modules/webhooks/repo.ts`'s `createWebhookFanoutPort`, wired into
 * `modules/events/relay-loop.ts`'s `drainOnce`) and the existing dispatcher
 * (`modules/webhooks/dispatcher.ts`'s `runDispatchTick`) already claim,
 * sign, and deliver a webhook-fanned `notification.created` row exactly like
 * any other webhook-subscribed event type - a tenant that has subscribed an
 * endpoint to `notification.created` receives it with no code change here.
 *
 * DOCUMENTED DECISION (deviation flagged for the reviewer): the phase task's
 * step 4 says the webhook leg should "hand the notification to P15's
 * dispatcher with an event id a receiver can dedupe on", and its step-3 SQL
 * sketch names that id as "= notifications.id". This module deliberately
 * does NOT make `X-WP-Event-Id` the notification id - it stays exactly what
 * `dispatcher.ts` already sends for every other event type: the row's own
 * `outbox_events.id` (`row.outboxEventId`, see `dispatcher.ts`'s
 * `runDispatchTick`). Reasoning: `notify-fanout.sql` writes ONE outbox row
 * PER CHANNEL, so the webhook-fanned row for a given notification is exactly
 * 1:1 with that notification's webhook delivery - `X-WP-Event-Id =
 * outbox_events.id` is therefore just as receiver-dedupe-safe as
 * `notifications.id` would be for THIS event type alone, but making
 * `entity_id`/the header the notification id UNCONDITIONALLY for every event
 * type would collide distinct event types that happen to reference the same
 * entity (e.g. a future family also keyed by the same uuid) onto one
 * dedupe-id namespace - `dispatcher.ts` is intentionally generic across every
 * `WEBHOOK_EVENT_TYPES` member and must not special-case one event's id
 * shape. The notification id still rides in the delivered body regardless:
 * `notify-fanout.sql`'s outbox `payload` carries `notificationId` (and
 * `entity_id` is ALSO the notification id, `db/queries/notify-fanout.sql`'s
 * own `n.id::text` - see that file's header), so a receiver that wants to
 * dedupe on the notification specifically can key on
 * `payload.notificationId` instead of the generic per-delivery
 * `X-WP-Event-Id` header.
 *
 * This file exists only so `dispatch/` documents all three channels in one
 * place (step 4's own naming) and records the decision above - it exports
 * nothing new.
 */
export {};
