-- group-disable-on-forbidden.sql (P24 Unit U4b, step 7) - the ONE write that
-- disables send into a SINGLE `wa_groups` row after a `group_forbidden`
-- terminal send failure (a @g.us authorisation rejection: not-admin,
-- announce-mode, or not-participant). Scoped by (client_id, instance_id,
-- group_jid) - never touches a sibling group on the same instance, and never
-- touches `whatsapp_instances`, the per-instance pacing-state row, or the
-- pacing-events table (core invariant 2's group carve-out: this is terminal
-- for ONE job/group only). Scanned structurally by `forbidden.integration.
-- test.ts`'s own health-writers check - keep this comment free of the
-- literal column/table names that scan greps for.
--
-- `group_jid` is bound as the CANONICAL hash-input jid
-- (`groupRecipientHashInput(recipientJid)`, `@wp/domain`), matching how
-- `wa_groups.group_jid` is stored (see `group-jid.ts`'s own header) - never
-- the raw provider-supplied jid, which may carry a device/agent suffix.
--
-- IDEMPOTENT + CONDITIONAL (core invariant 3): `left_at IS NULL` excludes a
-- meanwhile-left group (a leave already recorded the group as gone; this
-- statement must never resurrect it). A group not yet synced into
-- `wa_groups` (never seen by the session worker's group sync) matches ZERO
-- rows - the caller treats that as "skip audit/notify, still return", never
-- an error (a race between "we just sent a job to a group" and "the sync
-- hasn't discovered it yet" is possible and handled, not guarded against
-- here). `RETURNING ... (xmax IS NOT NULL) AS already_disabled` lets the
-- caller distinguish "this call just disabled it" from "it was already
-- disabled" WITHOUT a second read - `xmax` is bumped by Postgres's own MVCC
-- machinery on every row version this UPDATE actually rewrites, including a
-- no-op-content rewrite, so it is always non-null on any matched row; the
-- caller's own idempotent-audit/notify decision is driven by
-- `notify()`'s dedupe row count, not by this flag, but it is still useful
-- test/debug evidence and is included per the phase task's own SQL shape.
--
-- ENABLE-CYCLE BUCKET (P24 C2 fix round, Fix 6): `RETURNING
-- enabled_epoch` is the row's `send_enabled_at` AS IT WAS BEFORE this
-- disable (captured via the `before` CTE, read under the SAME row lock
-- this UPDATE takes), never the post-disable value. The caller folds this
-- into `notify()`'s dedupe key as `bucket` - a forbidden signal against the
-- SAME group, in the SAME enable cycle, still dedupes (identical bucket);
-- a re-enable (a fresh `send_enabled_at`) followed by another forbidden
-- produces a DIFFERENT bucket, so the tenant is notified again.

-- name: group-disable-on-forbidden
WITH before AS (
  SELECT id, send_enabled_at
    FROM wa_groups
   WHERE client_id = $client_id
     AND instance_id = $instance_id
     AND group_jid = $group_jid
     AND left_at IS NULL
   FOR UPDATE
)
UPDATE wa_groups g
   SET send_enabled = false,
       disabled_reason = 'group_forbidden',
       next_sync_after = now(),
       updated_at = now()
  FROM before b
 WHERE g.id = b.id
RETURNING g.id, (g.xmax IS NOT NULL) AS already_disabled, b.send_enabled_at AS enabled_epoch;
