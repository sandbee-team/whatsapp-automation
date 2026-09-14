-- instance-card-usage.sql (P17 Unit U4, step 7) - today's sent count,
-- new-conversation count, AND `next_eligible_at` for the card, read from the
-- SAME stored `pacing_ledger` row the reserve path maintains
-- (`db/queries/reserve-pacing.sql`) - NEVER a `count(*)` over `message_jobs`,
-- and NEVER a re-derived gap (the card "never re-implements gap
-- arithmetic" - task binding fact). `ledger_date` is resolved in-statement
-- from `instance_pacing_state.pacing_timezone`, the same per-instance-local-
-- day derivation `reserve-pacing.sql`'s own `d` CTE uses - never `now()::date`
-- in Node. A missing `pacing_ledger` row for today (the instance has not
-- sent yet today) is a normal zero-row outcome; card.service.ts treats a
-- missing row as `{consumedCount: 0, newConvCount: 0, nextEligibleAt: null}`,
-- never an error.

-- name: instance-card-usage
WITH s AS (
  SELECT pacing_timezone
    FROM instance_pacing_state
   WHERE instance_id = $instance_id AND client_id = $client_id
)
SELECT l.consumed_count AS consumed_count, l.new_conv_count AS new_conv_count,
       l.next_eligible_at AS next_eligible_at
  FROM pacing_ledger l, s
 WHERE l.client_id = $client_id
   AND l.instance_id = $instance_id
   AND l.ledger_date = (now() AT TIME ZONE s.pacing_timezone)::date;
