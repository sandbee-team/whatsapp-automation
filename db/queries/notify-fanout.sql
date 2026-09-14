-- notify-fanout.sql (P17 U3, step 3) - `notify()`'s ONE statement: insert a
-- `notifications` row (dedupe by `notifications_dedupe_uq (client_id,
-- dedupe_key)` - migration 0048's own unique constraint is the sole dedupe
-- authority, core invariant 3), then fan out ONE `outbox_events` row PER
-- CHANNEL the caller resolved from `NOTIFICATION_KIND_REGISTRY` for this
-- kind (`$channels`, a text[] bind - e.g. ARRAY['sse','email','webhook']).
--
-- `ON CONFLICT ON CONSTRAINT notifications_dedupe_uq DO NOTHING RETURNING`
-- means a deduped call's `n` CTE returns ZERO rows - the outbox INSERT's
-- SELECT ... FROM n then also selects zero rows, so a dedupe fans out
-- NOTHING (never a duplicate outbox row for a notification that was itself
-- suppressed). The caller (`notify.ts`) tells created vs deduped apart by
-- how many rows THIS statement's own RETURNING carries.
--
-- Per-channel row shape:
--   - event_type is always 'notification.created', entity_id is always the
--     new notification's own id (never a business entity id - the outbox
--     row's job is "go look at this new notification", not the underlying
--     pause/etc).
--   - payload is the same ids-only {notificationId, kind, severity,
--     instanceId} triple on every channel row (REALTIME_PAYLOAD_KEYS'
--     'notification.created' allow-list) - never PII, regardless of which
--     channel eventually renders it.
--   - coalesce_key is `$sse_coalesce_key` (the coalesceKeyFor derivation,
--     computed by the caller in Node - this module never re-derives it) for
--     the 'sse' channel ROW ONLY, and NULL for every other channel row: the
--     DB CHECK (outbox_events_sse_requires_coalesce_key) requires a
--     non-null key exactly when fanout includes 'sse', and a per-row CASE
--     keeps a webhook/email row's coalesce_key NULL as migration 0041
--     already expects for those channels.
--   - fanout is a ONE-ELEMENT array naming just that row's own channel -
--     each channel gets its own outbox row here (never one row whose
--     fanout array lists all three), matching the relay's per-fanout claim
--     and per-channel dispatch legs (sse/webhook/email each read their own
--     rows).

-- name: notify-fanout
WITH n AS (
  INSERT INTO notifications
    (id, client_id, instance_id, kind, severity, dedupe_key, payload, requires_user_action)
  VALUES
    ($id, $client_id, $instance_id, $kind, $severity, $dedupe_key, $payload, $requires_user_action)
  ON CONFLICT ON CONSTRAINT notifications_dedupe_uq DO NOTHING
  RETURNING id, client_id, instance_id, kind, severity
  -- client_id = $client_id
)
INSERT INTO outbox_events
  (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout)
SELECT
  n.client_id,
  n.instance_id,
  'notification.created',
  n.id::text,
  jsonb_build_object(
    'notificationId', n.id,
    'kind', n.kind,
    'severity', n.severity,
    'instanceId', n.instance_id
  ),
  CASE WHEN ch.channel = 'sse' THEN $sse_coalesce_key ELSE NULL END,
  ARRAY[ch.channel]::text[]
FROM n
CROSS JOIN unnest($channels::text[]) AS ch(channel)
-- client_id = n.client_id
RETURNING id, client_id, entity_id, fanout;
