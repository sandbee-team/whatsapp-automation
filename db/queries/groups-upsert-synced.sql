-- groups-upsert-synced.sql (P24 Unit U3, step 4/5; P24 C2 fix round, Fix 4)
-- upsert of one discovered group's counts-only snapshot. NEVER touches
-- `send_enabled` - a sync only ever writes the provider-observed facts
-- (subject/counts/role/announce/joined_at) plus its own clock columns and
-- (on a REJOIN only) the left-state columns below. `joined_at` is
-- COALESCEd against the EXISTING row so a later re-sync never overwrites
-- the group's original join time with a fresher `creation` value some
-- providers omit on a repeat fetch. `next_sync_after = NULL` clears any
-- forbidden-triggered resync request this sync just satisfied (see the
-- forbidden hook, U4b's own file).
--
-- REJOIN (Fix 4): a group that reappears in the fetched set after having
-- been marked `left_at IS NOT NULL` is a rejoin, not a stale row - it comes
-- back VISIBLE (left_at/leave_requested_at cleared, so
-- `groups-leave-pending.sql`'s worker sweep never re-issues a leave for a
-- group the account is back in) but NOT send-enabled (the tenant must
-- re-opt-in; `send_enabled` itself is never touched by this statement,
-- upsert or not). `disabled_reason` is cleared ONLY on a rejoin (the CASE
-- below) - a group that was never left keeps whatever disabled_reason its
-- OWN send-enabled/disable path last set (e.g. `disabled_by_user`),
-- unaffected by an ordinary re-sync.
INSERT INTO wa_groups
  (client_id, instance_id, group_jid, subject, participant_count, is_announce,
   our_role, joined_at, tracked_participant_devices, last_synced_at, next_sync_after)
VALUES
  ($client_id, $instance_id, $group_jid, $subject, $participant_count, $is_announce,
   $our_role, $joined_at, $tracked_participant_devices, now(), NULL)
ON CONFLICT (client_id, instance_id, group_jid) DO UPDATE SET
  subject = EXCLUDED.subject,
  participant_count = EXCLUDED.participant_count,
  is_announce = EXCLUDED.is_announce,
  our_role = EXCLUDED.our_role,
  joined_at = COALESCE(wa_groups.joined_at, EXCLUDED.joined_at),
  tracked_participant_devices = EXCLUDED.tracked_participant_devices,
  last_synced_at = now(),
  next_sync_after = NULL,
  left_at = NULL,
  leave_requested_at = NULL,
  disabled_reason = CASE
    WHEN wa_groups.left_at IS NOT NULL THEN NULL
    ELSE wa_groups.disabled_reason
  END,
  updated_at = now();
-- client_id = $client_id (INSERT-only statement bound by VALUES, not a WHERE - see check-tenant-scope.ts's own INSERT convention, e.g. pacing-ensure-ledger-row.sql)
