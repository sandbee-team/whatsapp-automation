-- cancel-optout-jobs.sql (P14 Unit U3, phase step 4) - cancels every
-- currently-QUEUED job addressed to `$phone_hash`, the durable half of an
-- opt-out taking effect. NEVER `failed`: the older safe-mode design's §3.3
-- said `status='failed', last_error_class='OPT_OUT'` - the blueprint amends
-- that [R-28c]: an opt-out is not the tenant's send failure, it is the
-- recipient exercising their own right to stop receiving messages, and
-- `failed` would count it in every health/delivery-ratio denominator a
-- tenant sees. `status='cancelled'` + `cancel_reason='opt_out'` is a
-- DISTINCT terminal outcome, excluded from every health denominator by
-- construction (nothing ever reads `cancelled` rows into a rejected-send or
-- delivery-ratio calculation).
--
-- NEVER touches `attempts` - this is not a send attempt, retry, or failure;
-- the job simply stops being eligible to claim.
--
-- Scope: `$scope` is `'client'` or `'instance'` (mirrors `opt_outs.scope`).
-- `'client'`-scope cancels every queued job for `$phone_hash` across every
-- instance the client owns; `'instance'`-scope additionally requires
-- `instance_id = $instance_id` so an opt-out recorded against ONE instance
-- never cancels a queued job on a different instance of the same client.
--
-- Groups excluded (scope delta § Groups, binding): `recipient_jid NOT LIKE
-- '%@g.us'` - a group job's `recipient_hash` may coincidentally equal a
-- contact's hash (the same hashed value can appear on both a DM and a group
-- row if the caller ever mis-derives one from the other), but a contact-level
-- opt-out must NEVER cancel a group send; a WhatsApp group opt-out (if ever
-- supported) is a materially different feature with its own scope, not this
-- statement's concern.
--
-- IDEMPOTENT (core invariant 3): the WHERE clause only ever matches rows
-- still `status='queued'` - a second call against jobs already cancelled by
-- the first call matches zero rows (RETURNING is empty), never a second
-- write.

-- name: cancel-optout-jobs
UPDATE message_jobs
   SET status = 'cancelled',
       cancel_reason = 'opt_out',
       pacing_deny_reason = 'OPT_OUT',
       terminal_at = now(),
       updated_at = now()
 WHERE client_id = $client_id
   AND recipient_hash = $phone_hash
   AND status = 'queued'
   AND recipient_jid NOT LIKE '%@g.us'
   AND ($scope <> 'instance' OR instance_id = $instance_id)
RETURNING id;
