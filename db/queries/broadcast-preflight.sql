-- broadcast-preflight.sql (P23a Unit U1a, step 2) - the pre-flight quote's
-- own SQL: the instance's effective pacing-profile thresholds (mirrors
-- `send-loop-guard-pipeline-wiring.ts#readGuardPipelineState`'s shape,
-- widened with `whatsapp_instances.label` and `eff_daily_cap`) and the
-- CLIENT-level rolling frequency-deferral count over one batch of
-- `phone_hash` values (mirrors `recipient-frequency-window.sql`'s own
-- 24h/7d windows and DENY-at->= convention, aggregated instead of walked
-- per-recipient since the quote only needs a count, never a retryAt).
--
-- Both sections are scoped by client_id (core invariant 4); the frequency
-- section is deliberately PER CLIENT with no instance predicate - see
-- `recipient-frequency-window.sql`'s own header for why (a second instance
-- of the same client must never raise how often one recipient is messaged).

-- name: preflight-instance-thresholds
SELECT w.label AS label,
       s.warmup_tier AS warmup_tier,
       s.eff_daily_cap AS eff_daily_cap,
       p.dup_fanout_warn AS dup_fanout_warn,
       p.dup_fanout_ack AS dup_fanout_ack,
       p.per_recipient_24h AS per_recipient_24h,
       p.per_recipient_7d AS per_recipient_7d
  FROM instance_pacing_state s
  JOIN pacing_profiles p ON p.key = s.profile_key
  JOIN whatsapp_instances w ON w.id = s.instance_id
 WHERE s.instance_id = $instance_id AND s.client_id = $client_id
   -- client_id = $client_id
;

-- name: preflight-frequency-deferrals
-- Counts DISTINCT phone_hash values (out of $phone_hashes) whose recorded
-- 24h or 7d rolling sum is already >= the instance's per-recipient limit -
-- the same "deny at >=, not >" convention `evaluateRecipientFrequency` uses,
-- since the buckets hold sends already recorded and the broadcast's send is
-- the NEXT one, not yet recorded.
SELECT count(*)::text AS deferred_count
  FROM (
    SELECT h.phone_hash
      FROM unnest($phone_hashes::bytea[]) AS h(phone_hash)
      LEFT JOIN recipient_send_buckets b
        ON b.client_id = $client_id
       AND b.phone_hash = h.phone_hash
       AND b.hour_bucket > (now() - interval '7 days')
       AND b.hour_bucket <= now()
       -- client_id = $client_id
     GROUP BY h.phone_hash
    HAVING coalesce(sum(b.count) FILTER (WHERE b.hour_bucket > now() - interval '24 hours'), 0)
             >= $per_recipient_24h
        OR coalesce(sum(b.count), 0) >= $per_recipient_7d
  ) AS deferred;
