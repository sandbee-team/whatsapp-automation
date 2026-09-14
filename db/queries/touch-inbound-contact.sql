-- touch-inbound-contact.sql (P21 Unit U4, step 5) - the `instance_recipient_
-- contacts` half of the two contact touch-points an attributed inbound
-- message makes (the OTHER half, the `contacts.last_inbound_at` UPDATE, is a
-- separate hand-written statement in `message-signals.ts` itself - only ONE
-- `-- name:` per plain `loadQuery` file, see `db/src/queries.ts`'s own doc).
--
-- UPSERT (the row may not exist yet for a sender who writes to us first,
-- before we have ever sent them anything): `first_inbound_at` is set ONCE,
-- on the very first inbound message for this `(client_id, instance_id,
-- recipient_hash)` tuple - `COALESCE(instance_recipient_contacts.
-- first_inbound_at, EXCLUDED.first_inbound_at)` on the UPDATE branch means a
-- SECOND inbound message never moves it forward again (`is_new_conversation`
-- pacing classification reads this column and must stay stable across
-- repeat inbound traffic from the same recipient).
--
-- IDEMPOTENT (core invariant 3): a repeat call with the row already carrying
-- a non-null `first_inbound_at` is a no-op write (COALESCE keeps the
-- existing value) - never a second "first" timestamp.

-- name: touch-inbound-contact
INSERT INTO instance_recipient_contacts (client_id, instance_id, recipient_hash, first_inbound_at)
VALUES ($client_id, $instance_id, $phone_hash, now())
-- client_id = $client_id
ON CONFLICT (client_id, instance_id, recipient_hash) DO UPDATE
   SET first_inbound_at = COALESCE(instance_recipient_contacts.first_inbound_at, EXCLUDED.first_inbound_at);
