-- instance-card.sql (P17 Unit U4, step 7) - the instance card's own
-- read model: one row joining `whatsapp_instances` (link/health/desired
-- state, needs_user_action, pause_reason) to `instance_pacing_state` (health
-- score/band, warm-up tier, effective caps/window, next_eligible_at).
-- Client-scoped (`client_id = $client_id`) on BOTH sides of the join - never
-- cross-tenant, so this query is deliberately NOT registered in
-- CROSS_TENANT_QUERIES (card.service.ts's own header has the full rationale).
--
-- Queue depth and oldest-queued-age are DELIBERATELY NOT part of this
-- statement - they are served by the two sibling bounded probes
-- (`instance-card-queue-depth.sql` / `instance-card-oldest-queued.sql`),
-- cached separately in Redis for 5s (card.service.ts). Folding an unbounded
-- `message_jobs` scan into this join would defeat the whole point of the
-- `LIMIT 10001` bound below.
--
-- `pacing_ledger` (today's sent / new-conversation counters, AND
-- `next_eligible_at` - the "card never re-implements gap arithmetic" column)
-- is read by a SEPARATE query (instance-card-usage.sql) - joining it here
-- would require resolving today's local ledger_date first, and that
-- derivation belongs to the SAME "read the stored counter, never recompute"
-- rule as the rest of this card (card.service.ts composes both).

-- name: instance-card
SELECT
  i.id                          AS instance_id,
  i.label                       AS label,
  i.link_state                  AS link_state,
  i.health_state                AS health_state,
  i.desired_state                AS desired_state,
  i.needs_user_action           AS needs_user_action,
  i.user_action_reason          AS user_action_reason,
  i.pause_reason                AS pause_reason,
  i.last_success_send_at        AS last_send_at,
  p.health_score                AS health_score,
  p.health_band                 AS health_band,
  p.warmup_tier                 AS warmup_tier,
  p.warmup_tier_since           AS warmup_tier_since,
  p.eff_daily_cap                AS eff_daily_cap,
  p.eff_new_conv_cap             AS eff_new_conv_cap,
  p.eff_window_start_local       AS eff_window_start_local,
  p.eff_window_end_local         AS eff_window_end_local,
  p.pacing_timezone              AS pacing_timezone
FROM whatsapp_instances i
JOIN instance_pacing_state p
  ON p.instance_id = i.id AND p.client_id = i.client_id
WHERE i.id = $instance_id
  AND i.client_id = $client_id
  AND i.deleted_at IS NULL;
