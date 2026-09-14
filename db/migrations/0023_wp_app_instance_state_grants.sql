-- P08 (session-lifecycle) - migration 0023.
-- wp_app currently has only SELECT (id, client_id, session_epoch) and
-- UPDATE (session_epoch, updated_at) on `whatsapp_instances` (migration
-- 0021, P07 FIX-B CRITICAL - deliberately narrow, scoped to the auth-store
-- epoch predicates only, explicitly deferring the rest of this table's
-- surface to P08). P08's own connect/pair/pause API + engine paths need to
-- read and write far more of this table, and P08 also implements real
-- instance creation (`POST /v1/instances`, replacing the P04b 501 stub) -
-- this migration grants exactly that surface, still column-level
-- (0021 precedent), still nothing new for wp_admin_app/wp_scheduler.

-- ---------------------------------------------------------------------
-- ITEM 1 - SELECT: the columns the P08 API + engine legitimately read
-- (dispatch-enumerated list), added to the existing id/client_id/
-- session_epoch (both still needed by the P07 auth-store predicates and
-- left untouched here - a GRANT is additive, never a REVOKE).
-- ---------------------------------------------------------------------
GRANT SELECT (
  label,
  phone_e164,
  owner_jid,
  provider_kind,
  connection_status,
  desired_state,
  link_state,
  health_state,
  needs_user_action,
  user_action_reason,
  qr_attempts,
  pairing_started_at,
  pause_reason,
  paused_at,
  paused_by_user_id,
  disconnection_reason_code,
  disconnection_reason_label,
  disconnection_reason_at,
  last_connected_at,
  last_success_send_at,
  last_error_class,
  created_at,
  updated_at,
  deleted_at
) ON whatsapp_instances TO wp_app;

-- ---------------------------------------------------------------------
-- ITEM 2 - UPDATE: the state-transition columns P08's connect/pair/pause/
-- soft-delete endpoints write, added to the existing session_epoch/
-- updated_at (both already granted by migration 0021; re-listing
-- updated_at here would be a harmless no-op re-grant, so it is omitted -
-- see the dispatch's own "include updated_at only if not already granted"
-- condition). `deleted_at` is included here, not omitted: this table's
-- deletes are soft (a UPDATE ... SET deleted_at = now() ...), never a hard
-- DELETE - see ITEM 4 below for why DELETE itself stays revoked.
-- ---------------------------------------------------------------------
GRANT UPDATE (
  desired_state,
  link_state,
  health_state,
  needs_user_action,
  user_action_reason,
  qr_attempts,
  pairing_started_at,
  pause_reason,
  paused_at,
  paused_by_user_id,
  disconnection_reason_code,
  disconnection_reason_label,
  disconnection_reason_at,
  last_connected_at,
  owner_jid,
  phone_e164,
  deleted_at
) ON whatsapp_instances TO wp_app;

-- ---------------------------------------------------------------------
-- ITEM 3 - INSERT: P08 implements real instance creation
-- (`POST /v1/instances` replaces the P04b 501 stub). Full-row INSERT, not
-- a column-level list: every existing wp_app INSERT grant in this schema
-- (migrations 0005, 0007, 0008, 0009, 0013, 0014, 0018, 0020) is full-row -
-- there is no column-level INSERT precedent anywhere in this repo to
-- follow, and Postgres has no ADR here authorizing a divergent style.
-- Tenant binding does not depend on this grant's shape either way: the
-- table's `tenant_isolation` policy (migration 0010) is `FORCE ROW LEVEL
-- SECURITY` with `WITH CHECK (client_id = current_setting('app.client_id',
-- true))`, so any row wp_app inserts must already carry the session's own
-- `app.client_id` regardless of which columns the GRANT names - verified
-- live below. A minimal insert (id, client_id, label, provider_kind,
-- desired_state, link_state, health_state, created_at, updated_at) already
-- succeeds off this table's existing DEFAULTs (link_state 'unlinked',
-- health_state 'never_linked', desired_state 'offline', session_epoch 0,
-- qr_attempts 0 - all set in migration 0010's CREATE TABLE; no DEFAULT gap
-- found, so no ALTER COLUMN ... SET DEFAULT is needed in this migration).
-- ---------------------------------------------------------------------
GRANT INSERT ON whatsapp_instances TO wp_app;

-- ---------------------------------------------------------------------
-- ITEM 4 - deliberate omissions. This is the minimum P08 surface, not the
-- full table:
--   - No DELETE: this table's deletes are soft, via the UPDATE (deleted_at)
--     grant in ITEM 2 above - a hard DELETE stays revoked from wp_app, same
--     as every other soft-deletable table in this schema.
--   - No `session_epoch` in the ITEM 2 UPDATE list: migration 0021 already
--     granted it, scoped to the P07 auth-store epoch-bump predicate only;
--     P08 does not need to (and must not) write it directly - re-listing it
--     here would blur that boundary without adding any privilege.
--   - No `capture_groups`/`capture_media`: those columns are P23/broadcast-
--     scope surface (campaign snapshot config), not P08 connect/pair/pause
--     surface - out of scope for this migration.
--   - Nothing for wp_admin_app (already holds table-level SELECT from
--     migration 0010, untouched here) or wp_scheduler (its narrow claim-join
--     SELECT list from migration 0010 is untouched here) - neither role's
--     surface changes in this migration.
-- ---------------------------------------------------------------------
