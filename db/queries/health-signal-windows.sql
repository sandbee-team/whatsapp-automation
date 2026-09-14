-- health-signal-windows.sql (P16 Unit B, step 3) - ONE round trip feeding
-- every one of the twelve health-signal collectors (signals/*.ts). Each
-- collector reads only the columns it needs from the single returned row;
-- windows are computed here (in SQL) so every collector shares the exact
-- same "now" and boundary semantics, never independent per-collector
-- queries that could observe slightly different snapshots under concurrent
-- writes.
--
-- BIND PARAMETERS (loadQuery('health-signal-windows').paramNames is the
-- authoritative runtime-verified order): client_id, instance_id, now.
--
-- CAST DISCIPLINE: `$instance_id` is reused across BOTH a `text` comparison
-- (`audit_logs.target_id`, a text column) and several `uuid` comparisons
-- (`instance_id`/`origin_instance_id`). Postgres's extended-query-protocol
-- planner infers ONE type per bind position from its FIRST usage and holds
-- every later bare usage to that same inferred type - so every uuid-column
-- comparison below is explicitly `$instance_id::uuid`, never bare, so the
-- statement's actual usage order can never silently flip which type wins
-- (verified live: an earlier bare-everywhere draft failed with "operator
-- does not exist: uuid = text" the moment the first usage happened to be
-- the text-cast one).
--
-- WINDOW BOUNDARY (same rolling-window convention as
-- recipient-frequency-window.sql): `<col> > ($now - interval)` - strictly
-- newer than the window's trailing edge, never a calendar/local-midnight
-- reset.
--
-- EXCLUSION RULE (binding, core invariant "opt-out excluded from every
-- denominator"): every message_jobs-derived aggregate below filters
-- `cancel_reason IS DISTINCT FROM 'opt_out'` - a job cancelled because the
-- recipient opted out must never inflate or deflate any signal's
-- numerator/denominator.
--
-- DISCONNECT/RECONNECT SOURCE (reported finding, see this unit's dispatch
-- report): no dedicated per-instance disconnect-event table exists.
-- `audit_logs` (migration 0013), written by `modules/instances/service.ts#
-- applyEngineTransition` on every transition OUT of 'connected', is the only
-- durable per-instance record of a disconnect/degrade/pause/reconnect
-- event - `action IN ('instance.degraded','instance.paused')` with
-- `target_type = 'instance'` and `target_id = <instanceId>` (text).
-- `metadata->>'reason'` carries the `UserActionReason` label
-- (`RESTRICTION_SIGNAL`, `RECONNECT_FAILED`, etc.) collectors use to
-- separate "restriction" / "our own restart" from a genuine disconnect.
SELECT
  -- disconnect_frequency (6h): every connected-exit action, EXCLUDING a
  -- restriction signal (hard_restriction owns that) and excluding our own
  -- deliberate restart bookkeeping (reason = 'SESSION_REPLACED' is an
  -- expected takeover, not an instability signal).
  (
    SELECT count(*) FROM audit_logs
    WHERE client_id = $client_id
      AND target_type = 'instance'
      AND target_id = $instance_id::text
      AND action IN ('instance.degraded', 'instance.paused')
      AND coalesce(metadata->>'reason', '') NOT IN ('RESTRICTION_SIGNAL', 'SESSION_REPLACED')
      AND created_at > ($now::timestamptz - interval '6 hours')
  ) AS disconnect_count_6h,

  -- reconnect_churn (6h): restart-shaped reasons only (restartRequired /
  -- connectionReplaced / QR-refresh loop reasons), a strict subset of the
  -- disconnect stream above.
  (
    SELECT count(*) FROM audit_logs
    WHERE client_id = $client_id
      AND target_type = 'instance'
      AND target_id = $instance_id::text
      AND action IN ('instance.degraded', 'instance.paused')
      AND coalesce(metadata->>'reason', '') IN
        ('SESSION_REPLACED', 'RECONNECT_FAILED', 'PAIRING_EXPIRED')
      AND created_at > ($now::timestamptz - interval '6 hours')
  ) AS reconnect_churn_count_6h,

  -- hard_restriction (event): most recent restriction-shaped audit row -
  -- the score.ts caller compares this timestamp against `now` itself for
  -- the override; the collector just surfaces the raw timestamp.
  (
    SELECT max(created_at) FROM audit_logs
    WHERE client_id = $client_id
      AND target_type = 'instance'
      AND target_id = $instance_id::text
      AND action IN ('instance.degraded', 'instance.paused')
      AND metadata->>'reason' = 'RESTRICTION_SIGNAL'
  ) AS last_hard_signal_audit_at,

  -- transient_failure_rate (1h): failed transient / attempted.
  (
    SELECT count(*) FROM send_attempts
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND dispatched_at > ($now::timestamptz - interval '1 hour')
  ) AS attempted_1h,
  (
    SELECT count(*) FROM send_attempts
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND state = 'failed' AND error_class = 'transient'
      AND dispatched_at > ($now::timestamptz - interval '1 hour')
  ) AS transient_failed_1h,

  -- rejected_send_rate (24h): failed rejected-by-provider / attempted.
  (
    SELECT count(*) FROM send_attempts
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND dispatched_at > ($now::timestamptz - interval '24 hours')
  ) AS attempted_24h,
  (
    SELECT count(*) FROM send_attempts
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND state = 'failed' AND error_class IN ('restricted', 'rate_limited')
      AND dispatched_at > ($now::timestamptz - interval '24 hours')
  ) AS rejected_failed_24h,

  -- invalid_jid_rate (24h): failed invalid-recipient / attempted (same
  -- attempted_24h denominator as rejected_send_rate).
  (
    SELECT count(*) FROM send_attempts
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND state = 'failed' AND error_class = 'invalid_recipient'
      AND dispatched_at > ($now::timestamptz - interval '24 hours')
  ) AS invalid_jid_failed_24h,

  -- delivery_ratio (24h): delivered / sent, only sends >= 30 minutes old
  -- (design: a just-sent message has not had time to deliver yet).
  (
    SELECT count(*) FROM message_jobs
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND status = 'sent'
      AND cancel_reason IS DISTINCT FROM 'opt_out'
      AND sent_at > ($now::timestamptz - interval '24 hours')
      AND sent_at <= ($now::timestamptz - interval '30 minutes')
  ) AS eligible_sent_24h,
  (
    SELECT count(*) FROM delivery_events de
    JOIN message_jobs mj
      ON mj.id = de.message_job_id AND mj.created_at = de.message_job_created_at
    WHERE de.client_id = $client_id AND de.instance_id = $instance_id::uuid
      AND de.event_type = 'delivered'
      AND mj.cancel_reason IS DISTINCT FROM 'opt_out'
      AND mj.sent_at > ($now::timestamptz - interval '24 hours')
      AND mj.sent_at <= ($now::timestamptz - interval '30 minutes')
  ) AS delivered_24h,

  -- read_ratio (24h): read / delivered.
  (
    SELECT count(*) FROM delivery_events de
    JOIN message_jobs mj
      ON mj.id = de.message_job_id AND mj.created_at = de.message_job_created_at
    WHERE de.client_id = $client_id AND de.instance_id = $instance_id::uuid
      AND de.event_type = 'read'
      AND mj.cancel_reason IS DISTINCT FROM 'opt_out'
      AND mj.sent_at > ($now::timestamptz - interval '24 hours')
  ) AS read_24h,

  -- recipient_block_indicator (24h): per-1000-sent block signal count - no
  -- v1 source (no block-signal table exists yet); sent_24h is still
  -- returned so the collector can apply its own min-evidence gate
  -- (100 sends) before reporting 'unmeasured' for the missing numerator.
  (
    SELECT count(*) FROM message_jobs
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND status = 'sent'
      AND cancel_reason IS DISTINCT FROM 'opt_out'
      AND sent_at > ($now::timestamptz - interval '24 hours')
  ) AS sent_24h,

  -- opt_out_rate (24h): opt_outs attributed to this instance per 1,000 sent.
  (
    SELECT count(*) FROM opt_outs
    WHERE client_id = $client_id AND origin_instance_id = $instance_id::uuid
      AND created_at > ($now::timestamptz - interval '24 hours')
  ) AS opt_outs_24h,

  -- reply_rate (72h): replies / new conversations - NO source in v1 (no
  -- inbound message table exists); new_convs_72h is still returned so a
  -- future collector can apply min-evidence once inbound storage lands
  -- (P21+). The collector itself always returns 'unmeasured' regardless of
  -- this count (see signals/reply-rate.ts's own header).
  (
    SELECT count(*) FROM message_jobs
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND is_new_conversation = true
      AND cancel_reason IS DISTINCT FROM 'opt_out'
      AND created_at > ($now::timestamptz - interval '72 hours')
  ) AS new_convs_72h,

  -- cold_outreach_ratio (24h): new_conv sends / total sends.
  (
    SELECT count(*) FROM message_jobs
    WHERE client_id = $client_id AND instance_id = $instance_id::uuid
      AND status = 'sent' AND is_new_conversation = true
      AND cancel_reason IS DISTINCT FROM 'opt_out'
      AND sent_at > ($now::timestamptz - interval '24 hours')
  ) AS cold_sent_24h;
