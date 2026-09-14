-- groups-touch-last-message.sql (P24 Unit U4b, step 8) - advances
-- `wa_groups.last_message_at` to the inbound event's own timestamp, for a
-- group chat message that passed the message-scope filter
-- (`shouldIgnoreJid`'s allow-list check already ran before this statement is
-- reached). `GREATEST(COALESCE(last_message_at, '-infinity'), $at)` makes the
-- write MONOTONIC (never moves the clock backwards on an out-of-order/older
-- event) and idempotent on replay (a repeat of the same or an older event is
-- a same-value no-op, not a second logical write). Scoped by (client_id,
-- instance_id, group_jid) - a group not yet synced into `wa_groups` matches
-- zero rows, which is fine (the message itself was still processed; this is
-- best-effort metadata, never a required side effect of message processing).
--
-- Never stores message text or any participant identity - one timestamp
-- column only (migration 0066's "counts/timestamps only, forever" rule).

-- name: groups-touch-last-message
UPDATE wa_groups
   SET last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'), $at),
       updated_at = now()
 WHERE client_id = $client_id
   AND instance_id = $instance_id
   AND group_jid = $group_jid;
