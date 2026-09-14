-- count-fingerprint-recipient.sql (P14 Unit U5, step 6) - the ONE statement
-- that both records a (fingerprint, recipient) evaluation and returns the
-- CURRENT distinct-recipient count for that fingerprint today, atomically.
--
-- BIND PARAMETERS (loadQuery('count-fingerprint-recipient').paramNames is
-- the authoritative runtime-verified order): client_id, local_date,
-- fingerprint, recipient_hash, now.
-- RETURNING columns, in order: recipient_count, ack_at.
--
-- SHAPE NOTE (load-bearing, do not "simplify" back to a 3-CTE parent/child/
-- bump form): Postgres data-modifying WITH clauses do NOT see each other's
-- effects on the SAME target table within one statement (per the Postgres
-- docs on WITH: "the effects of [] a data-modifying statement [] will not
-- be visible to other parts of the query"). A separate `parent` CTE that
-- INSERTs the content_fingerprints row and a separate `bumped` CTE that
-- UPDATEs it in the SAME statement therefore silently returns ZERO rows on
-- the very first evaluation of a new fingerprint (verified against real
-- Postgres while building this file - the bug this comment exists to
-- prevent reintroducing). The fix is ONE writer per target table:
-- `content_fingerprints` is written by exactly one
-- `INSERT ... ON CONFLICT DO UPDATE`, whose increment amount is
-- `(SELECT count(*) FROM recipient_ins)` - 1 when the recipient row was
-- newly inserted, 0 when it already existed (ON CONFLICT DO NOTHING on the
-- child left `recipient_ins` empty).
--
-- Two steps:
--   1. Insert the per-recipient row (content_fingerprint_recipients).
--      ON CONFLICT DO NOTHING - re-evaluating the SAME recipient against the
--      SAME fingerprint on a later claim attempt must never insert a second
--      row; `recipient_ins`'s row count (0 or 1) is what step 2 reads.
--   2. Upsert the CLIENT-level parent row (content_fingerprints), adding
--      EXACTLY `(SELECT count(*) FROM recipient_ins)` to `recipient_count`
--      - never an unconditional `+1` [R-27w: guards re-evaluate on every
--      claim attempt; an unconditional increment would inflate a
--      200-recipient campaign into NEEDS_HUMAN_ACK within one pass, since
--      the same recipient's job can be claimed, deferred by an unrelated
--      pacing reason, and re-evaluated many times before it ever sends].
--      `ON CONFLICT DO UPDATE` touches ONLY `recipient_count` - `ack_by`/
--      `ack_at` are never reset by this statement, so an already-acked
--      fingerprint stays acked across every later evaluation.
-- name: count-fingerprint-recipient
WITH recipient_ins AS (
  INSERT INTO content_fingerprint_recipients (client_id, local_date, fingerprint, recipient_hash, created_at)
  VALUES ($client_id, $local_date, $fingerprint, $recipient_hash, $now)
  -- client_id = $client_id
  ON CONFLICT (client_id, local_date, fingerprint, recipient_hash) DO NOTHING
  RETURNING client_id
),
upserted AS (
  INSERT INTO content_fingerprints (client_id, local_date, fingerprint, recipient_count)
  SELECT $client_id, $local_date, $fingerprint, (SELECT count(*)::int FROM recipient_ins)
  ON CONFLICT (client_id, local_date, fingerprint) DO UPDATE
    SET recipient_count = content_fingerprints.recipient_count + (SELECT count(*)::int FROM recipient_ins)
    WHERE content_fingerprints.client_id = $client_id
  RETURNING recipient_count, ack_at
)
SELECT recipient_count, ack_at FROM upserted;
