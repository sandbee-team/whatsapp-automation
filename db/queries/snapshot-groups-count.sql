-- snapshot-groups-count.sql (P24 Unit U6, step 9) - the groups-audience
-- ceiling-check twin of `snapshot-audience-count.sql`. Counts every
-- non-left `wa_groups` row of the campaign's own instance that the audience
-- JSON matches - `$group_ids` is the audience's own `groupIds` array (may be
-- empty; empty means "every send-enabled group", but the CEILING check
-- counts every MATCHED group regardless of send_enabled - the same group
-- population `snapshot-groups-batch.sql` will walk, skip precedence and
-- all, so this count never disagrees with what the batch actually inserts.
-- client_id = $client_id (wa_groups is client- and instance-scoped).

-- name: snapshot-groups-count
SELECT count(*)::text AS count
  FROM wa_groups g
 WHERE g.client_id = $client_id
   AND g.instance_id = $instance_id
   AND g.left_at IS NULL
   AND (cardinality($group_ids::uuid[]) = 0 OR g.id = ANY($group_ids::uuid[]));
