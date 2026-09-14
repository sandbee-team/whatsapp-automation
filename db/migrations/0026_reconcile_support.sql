-- P12 (queue-recovery-and-echo-spike) Unit U1 - migration 0026.
-- Forward-only, additive-only. No column dropped, no type changed, no data
-- rewritten, no `messages` table (there is no inbox in v1 - ADR 0021), no
-- `ambiguous_send_policy` column (the phase file forbids it - v1 ships
-- `ask_me` human-review behaviour only, never an automatic requeue), no
-- body/JID/phone/preview column anywhere in this file.
--
-- P21 (v2 inbox) owns the inbound body path built on top of
-- `message_wa_ids`/`message_jobs` and must `ALTER` these tables, never
-- `CREATE` a competing one - the echo evidence added here (`content_hash`,
-- `observed_at`) lives on the SAME single id authority `message_wa_ids`
-- already is, exactly per the scope delta's "a separate evidence table
-- would be a second authority for one question" ruling.
--
-- WHY each column exists:
--   message_wa_ids.content_hash   - the same content hash the dispatch path
--     computes (send_attempts.content_hash, migration 0008), recorded off a
--     `fromMe` echo so the reconciler (P12 step 6) can match unresolved
--     `send_attempts`/`message_jobs` rows to a provider-confirmed echo by
--     hash within a time window, without ever storing the message body.
--   message_wa_ids.observed_at    - when the echo was captured; the
--     reconciler's ±5 minute tolerance window and the eventual `sent_at`
--     (set to this value on a resolved match) both key off it.
--   message_jobs.unresolved_reason - session-open correction C1:
--     `needs_user_action` is `boolean NOT NULL DEFAULT false` (migration
--     0007) and is NOT converted to a text/enum label here - it is left
--     exactly as shipped. The human-readable reason a job landed in
--     `blocked_needs_review` (e.g. `'no_echo_evidence'`) goes in this new
--     column instead; `needs_user_action` is simply set `true` alongside it.
--   message_jobs.unresolved_at    - when the job was moved into the
--     unresolved/needs-human-review state, for panel sorting and the
--     72-simulated-hour no-auto-requeue test's staleness math.
--
-- INDEXES:
--   message_jobs_review_idx already exists (migration 0007) as
--     `(client_id, instance_id, terminal_at) WHERE status IN
--     ('needs_reconcile', 'blocked_needs_review')` - P03 already created
--     exactly the partial index this phase's step 2 asked for, so nothing
--     is added here; re-issuing an identical CREATE INDEX would only be a
--     no-op statement with no snapshot effect (same reasoning migration
--     0012 used to skip a redundant whatsapp_instances re-grant).
--   message_wa_ids_evidence_idx - the reconciler's own lookup: unresolved
--     echo evidence (`message_id IS NULL`) for a given
--     `(client_id, instance_id, content_hash)` ordered/filtered by
--     `observed_at` for the ±5 minute window match.
--   message_wa_ids_message_id_uq - session-open correction C2, the single
--     most important object in this migration: `message_wa_ids` carries NO
--     unique index on `message_id` today (its only key is the PK
--     `(client_id, instance_id, direction, wa_msg_id)`, migration 0008), so
--     the reconciler's "1:1 assignment enforced by the unique key"
--     (phase file step 6) has nothing enforcing it without this index. A
--     PARTIAL unique index (`WHERE message_id IS NOT NULL`) is required,
--     not a plain unique index, because `message_id` is legitimately NULL
--     for every unresolved-evidence row and for every inbound (v2) row.
--
-- GRANTS - additive column grants, closing the gaps `0012_scheduler_
-- column_grants.sql:50-55` explicitly reserved for "the reaper's own
-- migration". COLUMN LISTS ARE DERIVED DIRECTLY FROM this phase file's
-- step 3 (the reaper) and step 6 (the reconciler) statement descriptions,
-- NOT GUESSED - same discipline as migration 0025's header:
--   message_jobs SELECT (lease_expires_at, leased_at, lease_owner,
--                         owner_fence, terminal_at, sent_at)
--     - the reaper's statement (`db/queries/reap-expired-leases.sql`,
--       blueprint verbatim) selects/orders by `lease_expires_at` under
--       `FOR UPDATE OF j SKIP LOCKED`, and its repair branches read
--       `leased_at`/`lease_owner`/`owner_fence` to decide/report which
--       lease is being reclaimed. `terminal_at`/`sent_at` are read back by
--       the repaired-send-sink idempotency check (step 4: "idempotent
--       across a re-run") before it emits a work item, and by the
--       reconciler's evidence-window comparison against a job's existing
--       terminal state.
--   message_jobs UPDATE (needs_user_action, unresolved_reason,
--                         unresolved_at)
--     - the reaper's `dispatched -> needs_reconcile` repair and the
--       reconciler's window-expiry branch (step 6: "job -> blocked_needs_
--       review, unresolved_reason='no_echo_evidence',
--       needs_user_action='unresolved_send'" - session-open correction C1
--       reinterprets the RHS as `needs_user_action = true` with the label
--       moved to the new `unresolved_reason` column) both write all three
--       columns. wp_scheduler already holds table-level UPDATE on none of
--       these three (0012's grant list omitted them by name).
--   message_wa_ids UPDATE (message_id, message_created_at)
--     - the reconciler's 1:1 assignment write (step 6: "1:1 enforced by
--       setting message_wa_ids.message_id under its unique key"). No role
--       has ANY UPDATE grant on this table today (migration 0008 granted
--       only SELECT/INSERT) - wp_scheduler is the reconciler's role
--       (registered as a cross-tenant background-path query, same class as
--       the reaper, per session-open correction C6).
--
-- NOT GRANTED, deliberately: no UPDATE on message_jobs.status here even
-- though the reaper/reconciler both write it - migration 0012 already
-- grants wp_scheduler table-level UPDATE-by-column on `status`
-- (`GRANT UPDATE (status, ...) ON message_jobs TO wp_scheduler`), so
-- re-granting it would be a no-op statement; same reasoning applies to
-- `attempts`/`next_attempt_at` (already granted by 0012/0025).

-- ---------------------------------------------------------------------
-- message_wa_ids - echo evidence columns.
-- ---------------------------------------------------------------------
ALTER TABLE message_wa_ids ADD COLUMN content_hash bytea;
ALTER TABLE message_wa_ids ADD COLUMN observed_at timestamptz;

-- Reconciler lookup: unresolved evidence for a (client_id, instance_id,
-- content_hash), ordered/filtered by observed_at for the tolerance window.
CREATE INDEX message_wa_ids_evidence_idx
  ON message_wa_ids (client_id, instance_id, content_hash, observed_at)
  WHERE message_id IS NULL;

-- The 1:1 assignment authority (session-open correction C2) - partial
-- because message_id is legitimately NULL for unresolved evidence and for
-- every inbound (v2) row.
CREATE UNIQUE INDEX message_wa_ids_message_id_uq
  ON message_wa_ids (client_id, instance_id, message_id)
  WHERE message_id IS NOT NULL;

GRANT UPDATE (message_id, message_created_at) ON message_wa_ids TO wp_scheduler;

-- ---------------------------------------------------------------------
-- message_jobs - the human-review reason/timestamp pair (session-open
-- correction C1: needs_user_action stays boolean, unchanged).
-- ---------------------------------------------------------------------
ALTER TABLE message_jobs ADD COLUMN unresolved_reason text;
ALTER TABLE message_jobs ADD COLUMN unresolved_at timestamptz;

GRANT SELECT (
  lease_expires_at, leased_at, lease_owner, owner_fence, terminal_at, sent_at
) ON message_jobs TO wp_scheduler;

GRANT UPDATE (needs_user_action, unresolved_reason, unresolved_at)
  ON message_jobs TO wp_scheduler;

-- wp_admin_app: table-level SELECT * already covers both new message_jobs
-- columns (migration 0007) and both new message_wa_ids columns (migration
-- 0008) - no new grant statement needed for either (a re-issued identical
-- GRANT would be a no-op, same precedent as migration 0012's own header).
-- wp_admin_app gets nothing new on message_wa_ids beyond its existing
-- SELECT: it is a SEND_PATH_TABLES entry and grants-snapshot.test.ts's
-- `wp_admin_app_has_no_write_grant_on_any_existing_send_path_table` case
-- forbids any write grant there.

-- ---------------------------------------------------------------------
-- unresolved_action_keys - session-open correction C9. `message_job_refs`
-- is scoped to job CREATION (message_job_id NOT NULL, public_id PK, no
-- UPDATE/DELETE grant - migration 0008) and cannot key a retry/discard
-- ACTION on an already-existing job. This is that action's own idempotency/
-- replay authority, following message_job_refs' exact shape: NOT
-- partitioned (invariant 3 - every uniqueness authority lives on a
-- non-partitioned side table), leading client_id, PK
-- (client_id, idempotency_key) as the replay authority (step 8:
-- "POST /v1/messages/:id/unresolved/retry|discard" both require a
-- mandatory Idempotency-Key; "a replayed retry with the same idempotency
-- key requeues once").
--
-- Append-only, same class as message_job_refs/delivery_event_ids: an
-- idempotency/dedupe record is never rewritten, so no UPDATE/DELETE grant
-- to any role. Grants derived from step 8's actual statements: the API
-- route (wp_app) inserts the key when it accepts a retry/discard request
-- and may need to read it back to detect a replay; wp_scheduler gets
-- nothing (the reaper/reconciler never call this path - only a human
-- action through unresolved.service.ts does). wp_admin_app keeps its
-- default table-level SELECT (0005) for staff/ops visibility into which
-- actor took which action - no write grant, so it is NOT added to
-- SEND_PATH_TABLES (that list is for tables an automated send touches;
-- this one is touched only by an explicit human decision through the
-- guarded service, never by the send path itself).
-- ---------------------------------------------------------------------
CREATE TABLE unresolved_action_keys (
  client_id                 uuid NOT NULL,
  idempotency_key            text NOT NULL,
  message_job_id             bigint NOT NULL,
  message_job_created_at     timestamptz NOT NULL,
  action                    text NOT NULL,
  actor_user_id              uuid NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unresolved_action_keys_pkey PRIMARY KEY (client_id, idempotency_key),
  CONSTRAINT uak_action_check CHECK (action IN ('retry', 'discard'))
);

ALTER TABLE unresolved_action_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE unresolved_action_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON unresolved_action_keys FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE unresolved_action_keys OWNER TO wp_migrator;

GRANT SELECT, INSERT ON unresolved_action_keys TO wp_app;
