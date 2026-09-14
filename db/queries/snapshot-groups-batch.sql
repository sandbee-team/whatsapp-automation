-- snapshot-groups-batch.sql (P24 Unit U6, step 9) - Phase A's one-batch
-- keyset read over `wa_groups` for a `groups` campaign, the twin of
-- `snapshot-audience-batch.sql`. Keyset over `wa_groups.id` (reusing
-- `campaigns.snapshot_cursor_contact_id` as the cursor column - a campaign
-- is either `contacts` or `groups`, never both, so one uuid cursor column
-- safely serves either audience kind's keyset walk; see
-- `snapshot.repo.ts`'s own doc comment).
--
-- `$group_ids` is the audience JSON's own `groupIds` array (may be empty -
-- empty means every non-left group on the instance, matching
-- `snapshot-groups-count.sql`'s ceiling population exactly).
--
-- Every column the worker needs to run `canSendToGroup` and to build the
-- `campaign_recipients` insert row is selected directly - no derived
-- `trackedDevicesInstanceTotal` here (that is `groups-enabled-devices-
-- total.sql`, read once per batch by the caller, not per row).
--
-- client_id = $client_id (wa_groups is client- and instance-scoped).

-- name: snapshot-groups-batch
SELECT
  g.id AS group_id,
  g.group_jid,
  g.subject,
  g.participant_count,
  g.is_announce,
  g.our_role,
  g.send_enabled,
  g.tracked_participant_devices
FROM wa_groups g
WHERE g.client_id = $client_id
  AND g.instance_id = $instance_id
  AND g.left_at IS NULL
  AND g.id > $cursor_group_id
  AND (cardinality($group_ids::uuid[]) = 0 OR g.id = ANY($group_ids::uuid[]))
ORDER BY g.id
LIMIT $batch_size;
