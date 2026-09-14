-- groups-cap-today.sql (P24 Unit U3, step 4) - the list route's
-- `groupCap` block: `warmup_tier`/`health_band`/`eff_group_daily_cap` from
-- `instance_pacing_state`, plus TODAY's `pacing_ledger.group_sent_count` for
-- the instance's LOCAL ledger day - computed the SAME way
-- `reserve-pacing.sql`'s own `d` CTE derives `ledger_date`
-- (`(now() AT TIME ZONE pacing_timezone)::date`), never `now()::date`
-- (timezone cannot be used to reset a cap - reserve-pacing.sql note 3).
-- `sent_today` is 0 when no `pacing_ledger` row exists yet for today (a
-- LEFT JOIN, not an inner join - a fresh instance/day has never reserved).
WITH s AS (
  SELECT warmup_tier, health_band, eff_group_daily_cap, pacing_timezone
    FROM instance_pacing_state
   WHERE client_id = $client_id AND instance_id = $instance_id
)
SELECT s.warmup_tier, s.health_band, s.eff_group_daily_cap,
       coalesce(l.group_sent_count, 0) AS sent_today
  FROM s
  LEFT JOIN pacing_ledger l
    ON l.client_id = $client_id
   AND l.instance_id = $instance_id
   AND l.ledger_date = (now() AT TIME ZONE s.pacing_timezone)::date;
