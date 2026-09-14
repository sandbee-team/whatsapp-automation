-- recipient-frequency-window.sql (P14 Unit U5, step 6) - the rolling
-- 24h/7d recipient-frequency read. PER CLIENT deliberately, no instance
-- predicate: recipient_send_buckets is keyed (client_id, phone_hash,
-- hour_bucket) with no instance_id column, because splitting one
-- recipient's traffic across a second WhatsApp instance of the same client
-- must NEVER raise how often that person can be messaged - this is the
-- guard that keeps the product from ever nudging a tenant toward number
-- rotation to dodge a per-recipient cap (core invariant 6 / safety-
-- compliance).
--
-- BIND PARAMETERS (loadQuery('recipient-frequency-window').paramNames is
-- the authoritative runtime-verified order): client_id, phone_hash, now.
-- RETURNING columns, in order: hour_bucket, count, in_24h, in_7d - one row
-- per bucket that falls in EITHER window (a bucket only in the 7d window
-- still needs to be visible for the 7d expiry computation), ordered ASC by
-- hour_bucket so the caller can walk cumulative counts oldest-first.
--
-- WINDOW BOUNDARY (documented decision, exact-to-the-hour since buckets are
-- hour-granular): a bucket is IN the rolling window when
-- `hour_bucket > $now - interval` - i.e. strictly newer than the window's
-- trailing edge. A bucket exactly `interval` old (e.g. exactly 24h before
-- $now) is OUT of the 24h window. This matches "rolling window", not
-- "calendar window" - there is no local-midnight reset anywhere in this
-- query, so a bucket at 23:00 yesterday still counts toward a 00:30-today
-- evaluation (see the evaluator's own doc for the survives-midnight case).
SELECT
  hour_bucket,
  count,
  hour_bucket > ($now::timestamptz - interval '24 hours') AS in_24h,
  hour_bucket > ($now::timestamptz - interval '7 days') AS in_7d
FROM recipient_send_buckets
WHERE client_id = $client_id
  AND phone_hash = $phone_hash
  AND hour_bucket > ($now::timestamptz - interval '7 days')
  AND hour_bucket <= $now::timestamptz
ORDER BY hour_bucket ASC;
