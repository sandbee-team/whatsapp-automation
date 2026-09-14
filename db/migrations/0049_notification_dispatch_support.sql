-- P17 (notifications-and-instance-card) follow-up - migration 0049.
-- Forward-only, additive-only: two new SECURITY DEFINER functions and one
-- new partial index. No table created/dropped, no column added/dropped/
-- retyped, no existing grant narrowed.
--
-- CONTEXT: the P17 relay email leg (`wp_relay` role) must resolve
-- notification email recipients and an instance label to render/send the
-- email, but `wp_relay`'s table grant surface is deliberately pinned to
-- EXACTLY five tables (audit_logs, notifications, outbox_events,
-- webhook_deliveries, webhook_endpoints - db/tests/wp-relay-role.test.ts's
-- `wp_relay_has_no_grant_on_any_table_beyond_the_five_it_owns`), per
-- migration 0048's own "WP_RELAY GAP" header note: `memberships`/`users`
-- were deliberately NOT granted there. This migration resolves that gap
-- with two narrow SECURITY DEFINER functions instead of widening wp_relay's
-- table grants - the same idiom migrations 0015 (wp_client_id_for_user) and
-- 0034 (wp_warmup_scan_due/wp_warmup_apply_tier_change) already established:
-- a definer function projects only the exact columns a caller needs,
-- callable via a narrow EXECUTE grant, with no broader table-level access.
--
--   1. wp_notification_email_recipients(p_client_id uuid)
--      RETURNS TABLE (user_id uuid, email citext) - STABLE. Users who hold
--      an ACTIVE membership in that client with role owner or admin, AND
--      whose email is verified. `memberships` (migration 0002) carries no
--      status/revoked/deleted column at all - role plus the row's mere
--      existence IS "active" membership (there is no soft-delete or
--      revocation flag on this table to check; confirmed by reading
--      migration 0002's CREATE TABLE and grepping every later migration for
--      an ALTER TABLE memberships - none exists). "Email verified" is
--      `users.email_verified_at IS NOT NULL` (migration 0013). Returns ONLY
--      user_id + email - no full_name, no phone_e164 - the relay's email
--      body template needs an address to send to, nothing else identifying.
--      Pinned search_path per the 0006/0015 precedent (mutable search_path
--      on a SECURITY DEFINER function is a privilege-escalation primitive).
--      Owned by wp_admin_app (BYPASSRLS) - same ownership rationale as
--      wp_client_id_for_user (0005 section 4 / 0015 header): a definer
--      function reading an RLS-protected table needs an owner that actually
--      bypasses RLS, or it inherits the "zero rows with no GUC set" problem
--      it exists to solve. GRANT EXECUTE to wp_relay only - wp_scheduler is
--      deliberately NOT granted this: no wp_scheduler-run caller in this
--      phase's dispatch resolves email recipients (that is exclusively the
--      relay's email-dispatch leg); if a future background caller needs it,
--      that is a new, deliberate grant in its own migration, not assumed
--      here. REVOKE ALL FROM PUBLIC per precedent.
--
--   2. wp_notification_instance_label(p_client_id uuid, p_instance_id uuid)
--      RETURNS text - STABLE. The `label` of that instance IFF it belongs
--      to p_client_id (defence in depth: a cross-tenant instance_id must
--      resolve to NULL, never another tenant's label), else NULL. Same
--      hardening (pinned search_path, wp_admin_app ownership, wp_relay-only
--      EXECUTE, REVOKE ALL FROM PUBLIC).
--
--   3. message_jobs_queued_created_idx - the instance-card endpoint's
--      oldest-queued probe (`SELECT MIN(created_at) ... WHERE client_id=$1
--      AND instance_id=$2 AND status='queued'`) has no index-ordered path
--      today: EXPLAIN (with enable_seqscan off, forcing an index-eligibility
--      comparison on the near-empty dev DB - see this migration's session
--      report for the verbatim plans) shows the existing
--      `message_jobs_recent_idx (client_id, instance_id, created_at DESC,
--      id DESC)` answers it via "Index Scan Backward ... Filter: (status =
--      'queued')" - the filter is applied AFTER the index walks backward
--      from the newest row of any status, so on a tenant/instance with many
--      non-queued rows newer than its oldest queued row this scan is not
--      index-ordered FOR THE QUEUED SUBSET and can walk arbitrarily many
--      non-matching rows before satisfying the MIN. A partial index whose
--      leading columns match the probe's equality predicate and whose
--      physical row set is ALREADY status='queued'-only lets this become a
--      pure forward Index (Only) Scan + Limit 1, no post-scan filter at
--      all. Declared on the parent (message_jobs is RANGE-partitioned by
--      created_at, migration 0007) so it recurses onto every existing
--      partition and is inherited by every partition created afterwards,
--      identical to how message_jobs' five existing indexes are declared.
--      Probe (a) (the bounded queued-depth count) needs NO new index:
--      EXPLAIN confirms it already resolves via
--      `message_jobs_claim_idx (client_id, instance_id, priority_rank,
--      next_attempt_at, id) WHERE status = 'queued'` as an Index Only Scan
--      (that index's leading columns and partial predicate already match
--      this probe's shape exactly) - see the session report's pasted plan.
--
-- ---------------------------------------------------------------------
-- 1. wp_notification_email_recipients(p_client_id uuid)
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_notification_email_recipients(p_client_id uuid)
RETURNS TABLE (
  user_id uuid,
  email   citext
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.client_id = p_client_id
     AND m.role IN ('owner', 'admin')
     AND u.email_verified_at IS NOT NULL
$$;

ALTER FUNCTION public.wp_notification_email_recipients(uuid) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_notification_email_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_notification_email_recipients(uuid) TO wp_relay;

-- ---------------------------------------------------------------------
-- 2. wp_notification_instance_label(p_client_id uuid, p_instance_id uuid)
-- ---------------------------------------------------------------------
CREATE FUNCTION public.wp_notification_instance_label(p_client_id uuid, p_instance_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.label
    FROM public.whatsapp_instances i
   WHERE i.id = p_instance_id
     AND i.client_id = p_client_id
$$;

ALTER FUNCTION public.wp_notification_instance_label(uuid, uuid) OWNER TO wp_admin_app;
REVOKE ALL ON FUNCTION public.wp_notification_instance_label(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wp_notification_instance_label(uuid, uuid) TO wp_relay;

-- ---------------------------------------------------------------------
-- 3. message_jobs_queued_created_idx - see header for why probe (b) needs
--    this and probe (a) does not.
-- ---------------------------------------------------------------------
CREATE INDEX message_jobs_queued_created_idx
  ON message_jobs (instance_id, created_at)
  WHERE status = 'queued';
