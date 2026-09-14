-- expand-campaign-batch.sql (P23 Unit U4, step 5) - Phase B's one-batch,
-- set-based, REF-FIRST expansion of up to 500 `campaign_recipients` rows
-- into real `message_jobs` (see this phase's canon: the ref gates the job,
-- never the reverse - a job-first insert produced an unaddressable,
-- undeduped duplicate in the design that predates this one).
--
-- Every array below is positionally aligned by `unnest(...)` - caller builds
-- one array per column, all the same length, in the SAME row order as the
-- `campaign_recipients` rows it read.
--
-- REPO REALITY corrections (migration 0064 header, restated here since this
-- file is the one that actually has to get them right):
--   (a) `mjr_dedupe_uq` is a PARTIAL unique INDEX, not a named constraint -
--       `ON CONFLICT (client_id, instance_id, dedupe_key) WHERE dedupe_key
--       IS NOT NULL DO NOTHING` (index inference), never `ON CONSTRAINT`.
--   (b) `message_jobs.id` is `GENERATED ALWAYS AS IDENTITY` - ids are
--       pre-allocated per row via `nextval(pg_get_serial_sequence(
--       'message_jobs','id'))` in the `alloc` CTE, and the INSERT uses
--       `OVERRIDING SYSTEM VALUE`.
--   (c) `message_job_refs.message_job_created_at` and `message_jobs.
--       created_at` are bound from the SAME in-SQL `now()` value
--       (`alloc.job_created_at`), computed once per row, never a JS `Date`.
--
-- client_id = $client_id (message_job_refs, message_jobs, campaign_recipients
-- all scoped).
--
-- OUTPUT: `inserted` is the ref rows THIS call's statement actually created
-- (0 on a pure replay - the dedupe conflict fired for every row); `stamped`
-- is the `upd` CTE's row count - recipients this call moved `pending` ->
-- `queued`, whether via a fresh ref or a resolved pre-existing one. Callers
-- driving `campaign_counters` MUST use `stamped`, never `inserted` - see
-- `expansion.repo.ts#bumpExpansionCounters`'s own doc comment for why.
--
-- The `resolved` CTE's LEFT JOIN back onto `message_job_refs` is scoped only
-- to THIS campaign because `dedupe_key = sha256(campaign_id || ':' ||
-- recipient_jid)` (built in `expansion.repo.ts#runExpandBatchStatement`) -
-- if the dedupe-key format ever drops `campaign_id` (e.g. to dedupe a
-- recipient across campaigns), this join's `(client_id, instance_id,
-- dedupe_key)` predicate would start resolving ANOTHER campaign's ref onto
-- this one's recipient row. Keep the key campaign-scoped, or widen this
-- join's predicate deliberately, in the same change.

-- name: expand-campaign-batch
WITH input AS (
  SELECT *
    FROM unnest(
      $recipient_ids::bigint[],
      $public_ids::uuid[],
      $recipient_jids::text[],
      $recipient_e164s::text[],
      $recipient_hashes::bytea[],
      $payloads::jsonb[],
      $dedupe_keys::text[]
    ) AS t(recipient_id, public_id, recipient_jid, recipient_e164, recipient_hash, payload, dedupe_key)
),
alloc AS (
  SELECT
    input.*,
    nextval(pg_get_serial_sequence('message_jobs', 'id')) AS job_id,
    now() AS job_created_at
  FROM input
),
ref AS (
  INSERT INTO message_job_refs
    (public_id, client_id, instance_id, message_job_id, message_job_created_at, dedupe_key)
  SELECT public_id, $client_id, $instance_id, job_id, job_created_at, dedupe_key
    FROM alloc
  ON CONFLICT (client_id, instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL
  DO NOTHING
  RETURNING public_id, message_job_id, message_job_created_at, dedupe_key
),
job AS (
  INSERT INTO message_jobs
    (id, created_at, client_id, instance_id, session_epoch, campaign_id,
     recipient_jid, recipient_e164, recipient_hash, payload, payload_kind,
     priority, priority_rank, status, scheduled_at, next_attempt_at, send_origin)
  OVERRIDING SYSTEM VALUE
  SELECT
    r.message_job_id, r.message_job_created_at, $client_id, $instance_id, $session_epoch,
    $campaign_id, a.recipient_jid, a.recipient_e164, a.recipient_hash, a.payload, $payload_kind,
    $priority, $priority_rank, 'queued', $scheduled_at, $scheduled_at, 'campaign'
  FROM ref r
  JOIN alloc a ON a.dedupe_key = r.dedupe_key
  RETURNING id, created_at, client_id, instance_id
),
ev_ids AS (
  INSERT INTO delivery_event_ids (provider_event_id, client_id, message_job_id, message_job_created_at)
  SELECT 'enqueue:' || r.public_id || ':created', $client_id, r.message_job_id, r.message_job_created_at
    FROM ref r
  UNION ALL
  SELECT 'enqueue:' || r.public_id || ':queued', $client_id, r.message_job_id, r.message_job_created_at
    FROM ref r
  RETURNING 1
),
ev AS (
  INSERT INTO delivery_events
    (client_id, instance_id, message_job_id, message_job_created_at, event_type, provider_event_id)
  SELECT $client_id, $instance_id, r.message_job_id, r.message_job_created_at, 'created'::event_type,
         'enqueue:' || r.public_id || ':created'
    FROM ref r
  UNION ALL
  SELECT $client_id, $instance_id, r.message_job_id, r.message_job_created_at, 'queued'::event_type,
         'enqueue:' || r.public_id || ':queued'
    FROM ref r
  RETURNING 1
),
-- Resolves the winning public_id for EVERY row in this batch, whether this
-- call's own `ref` insert just created it (a fresh expansion) or an EARLIER,
-- already-committed call already owns the dedupe_key (a genuine replay of an
-- already-expanded recipient - the dedupe guard fired, no new job, but the
-- recipient row must still be stamped with the EXISTING public_id, never
-- left unaddressable). Never a guess: read back from message_job_refs by the
-- same (client_id, instance_id, dedupe_key) the ON CONFLICT target uses.
resolved AS (
  SELECT a.recipient_id, a.dedupe_key,
         coalesce(r.public_id, mjr.public_id) AS public_id
    FROM alloc a
    LEFT JOIN ref r ON r.dedupe_key = a.dedupe_key
    LEFT JOIN message_job_refs mjr
      ON mjr.client_id = $client_id AND mjr.instance_id = $instance_id AND mjr.dedupe_key = a.dedupe_key
),
upd AS (
  UPDATE campaign_recipients cr
     SET status = 'queued', queued_at = now(), message_job_public_id = resolved.public_id
    FROM resolved
   WHERE cr.id = resolved.recipient_id
     AND cr.campaign_id = $campaign_id
     AND cr.client_id = $client_id
     AND resolved.public_id IS NOT NULL
  RETURNING cr.id
)
SELECT (SELECT count(*) FROM ref) AS inserted, (SELECT count(*) FROM upd) AS stamped;
