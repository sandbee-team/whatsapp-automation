-- health-send-history-30d.sql (P16 fix round, CRITICAL 2) - a 30-day
-- sent/failed/delivered summary for ONE instance, read ONLY on the
-- hard-signal-pause path (fast-lane.ts#onConnectionUpdate,
-- HealthEvaluator.ts's CRITICAL->pause branch) - never on the 5-minute
-- evaluator tick's hot scoring path, so it is a SEPARATE statement from
-- health-signal-windows.sql rather than an added column there (that file's
-- own header: "ONE round trip feeding every one of the twelve health-signal
-- collectors" - a pause-time-only aggregate does not belong on that shared
-- hot path).
--
-- COUNTS/RATIOS/DATES ONLY (module doc of hard-signal-pause.ts: "NO PII IN
-- THE EVIDENCE ROW") - no phone number, JID, group subject, or message body
-- is read or projected here.
--
-- EXCLUSION RULE (same as health-signal-windows.sql): every message_jobs
-- aggregate filters `cancel_reason IS DISTINCT FROM 'opt_out'` - an
-- opt-out-cancelled job must never inflate or deflate this summary.
--
-- BIND PARAMETERS: client_id, instance_id, now.
SELECT
  (
    SELECT count(*) FROM message_jobs
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND status = 'sent'
      AND cancel_reason IS DISTINCT FROM 'opt_out'
      AND sent_at > ($now::timestamptz - interval '30 days')
  ) AS sent_30d,
  (
    SELECT count(*) FROM send_attempts
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND state = 'failed'
      AND dispatched_at > ($now::timestamptz - interval '30 days')
  ) AS failed_30d,
  (
    SELECT count(*) FROM delivery_events de
    JOIN message_jobs mj
      ON mj.id = de.message_job_id AND mj.created_at = de.message_job_created_at
    WHERE de.client_id = $client_id AND de.instance_id = $instance_id::uuid
      AND de.event_type = 'delivered'
      AND mj.cancel_reason IS DISTINCT FROM 'opt_out'
      AND mj.sent_at > ($now::timestamptz - interval '30 days')
  ) AS delivered_30d;
