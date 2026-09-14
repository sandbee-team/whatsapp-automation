/**
 * modules/notifications/dispatch/sse.ts (P17 U3, step 4) - the SSE leg of a
 * notification's fan-out needs NO new code: `notify()`'s own SQL
 * (`db/queries/notify-fanout.sql`) writes an `outbox_events` row whose
 * `fanout` includes `'sse'` and `event_type = 'notification.created'`
 * exactly like any other sse-fanned event, and the EXISTING outbox pipeline
 * already carries it end to end -
 *
 *   - `@wp/contracts`'s `realtimeEventSchema` already recognises
 *     `notification.created` (P17 Unit U2, step 2) - `relay-loop-poison.ts`'s
 *     `toOutboxRow` parses every claimed row through it before it ever
 *     reaches the coalescer, so a malformed notification row is quarantined
 *     the same as any other event family, never a special case here.
 *   - `@wp/domain`'s `REALTIME_PAYLOAD_KEYS['notification.created']`
 *     (`['notificationId', 'kind', 'severity', 'instanceId']`) is already the
 *     allow-list `emit()`-shaped ids-only enforcement would use - `notify()`
 *     writes exactly that shape directly in its own SQL (see the query's own
 *     header), so there is nothing for a second, app-side validation layer to
 *     add here.
 *   - `@wp/domain`'s `coalesceKeyFor` already derives `n:<notificationId>`
 *     for this type - `notify()` computes it once (Node-side) and binds it
 *     as `$sse_coalesce_key` in the same statement, so a retried/duplicate
 *     relay claim of the SAME notification's outbox row still coalesces to a
 *     single winner per the relay's ordinary "newest id per key wins" rule
 *     (`coalescer.ts`), even though in practice a given notification only
 *     ever produces one sse-fanned row (dedupe happens one level up, at
 *     `notify()`'s own INSERT).
 *
 * This file exists only so the notifications module's `dispatch/` directory
 * documents all three channels in one place (step 4's own naming), matching
 * the phase task's own file list - it exports nothing, because publishing an
 * sse-fanned `notification.created` row is entirely the relay drain loop's
 * EXISTING responsibility (`modules/events/relay-loop.ts`), never a second,
 * parallel publish path (ADR 0010: nothing is ever published from inside a
 * business transaction, and there is exactly one publisher, the relay).
 */
export {};
