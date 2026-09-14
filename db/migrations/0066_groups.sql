-- P24 (groups-messaging) Unit U1 - migration 0066. Creates `wa_groups` (the
-- group registry the send-loop/session worker/panel read to know which
-- groups exist, whether sending into them is enabled, and when they last
-- synced) and adds three sync-clock columns to `whatsapp_instances`.
--
-- COUNTS ONLY, FOREVER: `wa_groups` stores `participant_count` (an int) and
-- `tracked_participant_devices` (an int) and NOTHING else participant-shaped
-- - no participant table, no participant/member/admin-list column of any
-- kind, no jsonb, no array, no bytea column, ever (ADR 0017 SS2). A group's
-- member list is third-party personal data this product has no consent to
-- retain, and a stored member list is exactly the raw material for number
-- harvesting (core invariant 6 / safety-compliance). `subject_owner_jid_hash`
-- named in the scope-delta DDL sketch is DELIBERATELY OMITTED here - it is a
-- participant-derived identity hash with no v1 consumer; adding it back
-- needs its own ADR, not a "might as well" line in this migration.
--
-- Shape notes:
--   - `id` is `uuid DEFAULT gen_random_uuid()` - the app-generated-id
--     convention this schema uses elsewhere (`contacts.id`,
--     `contact_tags.id`) is for tables where the API mints the id before
--     insert; `wa_groups` rows are discovered by the session worker's group
--     sync (never client-supplied), so a server-side default is the better
--     fit here, same as `contact_imports.id`/`topup_requests.id` (migration
--     0060/0058, both DEFAULT gen_random_uuid()).
--   - `wa_groups_client_instance_jid_uq` is this table's uniqueness
--     authority: one row per (client, instance, group). It leads with
--     client_id, so it needs no SUITE_A_INDEX_EXEMPTIONS/
--     CANONICAL_AUTHORITY_KEYS entry - the PK (a surrogate uuid) is the only
--     non-client_id-leading index here, registered in
--     CANONICAL_AUTHORITY_KEYS same class as topup_requests/contacts.
--   - `wa_groups_send_enabled_idx` is the send-loop's own discovery index
--     (tenant-scoped: which groups in this instance are enabled to send
--     into).
--   - `wa_groups_pending_idx` is deliberately NOT client_id-leading: it is
--     the worker's cross-tenant discovery sweep for instances with pending
--     group-leave requests or a due resync, same "deliberately global sweep
--     index" class as `campaigns_worker_discovery_idx` /
--     `message_jobs_lease_expiry_idx` - registered in
--     CANONICAL_AUTHORITY_KEYS below (leading_column: instance_id) rather
--     than a fifth SUITE_A_INDEX_EXEMPTIONS entry (that registry is for
--     UNIQUE-index authorities only, and this index is non-unique).
--
-- RLS + grants idiom: ENABLE + FORCE + the standard `tenant_isolation`
-- policy, exactly migration 0063/0064's shape. Three roles run tenant code
-- paths against this table (verified against 0064's campaigns/
-- campaign_recipients grants, the closest precedent for a table touched by
-- both the API and the scheduler-role worker):
--   - wp_app: the API's read of the group list/detail and its write of the
--     user-facing send-enable toggle (send_enabled, send_enabled_at,
--     send_enabled_by_user_id, disabled_reason) and the leave-request flag
--     (leave_requested_at). SELECT, INSERT, UPDATE (INSERT is included
--     because the API also owns ad-hoc group creation/refresh paths that
--     don't strictly require the worker, same INSERT+UPDATE breadth 0064
--     grants wp_app on campaign_recipients rather than a column-narrowed
--     grant, since no column here is safety-sensitive the way message_jobs'
--     status/lease columns are).
--   - wp_scheduler: the session worker's group sync (upsert on discovery)
--     and the send-loop's own result path (send_enabled/disabled_reason/
--     next_sync_after on a send failure that indicates the group is gone or
--     we were removed) and left_at on a confirmed leave. SELECT, INSERT,
--     UPDATE - same table-level breadth 0064 grants wp_scheduler on
--     campaigns/campaign_recipients/campaign_counters (no column here needs
--     narrower isolation than that precedent's own tables).
--   - wp_admin_app: SELECT only (staff/ops visibility), same as every other
--     tenant table's admin-app grant.
-- No DELETE grant to any role - a group leaving is recorded via left_at, not
-- a row delete (same "no DELETE grant to any role" rule as
-- campaign_recipients/campaign_counters, migration 0064).
--
-- whatsapp_instances gains three sync-clock columns (groups_next_sync_after/
-- groups_sync_requested_at/groups_last_synced_at) read/written by the same
-- wp_scheduler worker - wp_app's existing grants on whatsapp_instances are
-- column-scoped (migrations 0021/0023), so these three are explicit,
-- additive column grants below, mirroring migration 0063's
-- `GRANT UPDATE (replayed_at)` idiom: wp_app gets SELECT (read-only display
-- of "last synced"/"sync requested" in the panel) and wp_scheduler gets
-- SELECT + UPDATE (it both reads the due-for-sync clock and advances it).

CREATE TABLE wa_groups (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                     uuid NOT NULL REFERENCES clients(id),
  instance_id                   uuid NOT NULL REFERENCES whatsapp_instances(id),
  group_jid                     text NOT NULL,
  subject                       text,
  participant_count             int,
  is_announce                   boolean NOT NULL DEFAULT false,
  our_role                      text CHECK (our_role IN ('member', 'admin', 'superadmin')),
  joined_at                     timestamptz,
  last_synced_at                timestamptz,
  last_message_at               timestamptz,
  send_enabled                  boolean NOT NULL DEFAULT false,
  send_enabled_at               timestamptz,
  send_enabled_by_user_id       uuid,
  disabled_reason               text,
  tracked_participant_devices   int NOT NULL DEFAULT 0,
  next_sync_after               timestamptz,
  leave_requested_at            timestamptz,
  left_at                       timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_groups_client_instance_jid_uq UNIQUE (client_id, instance_id, group_jid),
  CONSTRAINT wa_groups_jid_shape CHECK (group_jid LIKE '%@g.us'),
  CONSTRAINT wa_groups_counts_nonneg
    CHECK (coalesce(participant_count, 0) >= 0 AND tracked_participant_devices >= 0)
);

CREATE INDEX wa_groups_send_enabled_idx ON wa_groups (client_id, instance_id, send_enabled);

-- worker sync/leave discovery: instances with pending leave or forbidden-triggered resync
CREATE INDEX wa_groups_pending_idx ON wa_groups (instance_id)
  WHERE leave_requested_at IS NOT NULL AND left_at IS NULL OR next_sync_after IS NOT NULL;

ALTER TABLE wa_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_groups FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON wa_groups FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE wa_groups OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON wa_groups TO wp_app;
GRANT SELECT, INSERT, UPDATE ON wa_groups TO wp_scheduler;
GRANT SELECT ON wa_groups TO wp_admin_app;

ALTER TABLE whatsapp_instances
  ADD COLUMN groups_next_sync_after timestamptz,
  ADD COLUMN groups_sync_requested_at timestamptz,
  ADD COLUMN groups_last_synced_at timestamptz;

GRANT SELECT (groups_next_sync_after, groups_sync_requested_at, groups_last_synced_at)
  ON whatsapp_instances TO wp_app;
GRANT SELECT, UPDATE (groups_next_sync_after, groups_sync_requested_at, groups_last_synced_at)
  ON whatsapp_instances TO wp_scheduler;
