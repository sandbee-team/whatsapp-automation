-- P03 (db-queue-and-claim) - migration 0007.
-- `message_jobs`: the durable queue spine, MONTHLY-partitioned by
-- `created_at`. PK is `(id, created_at)` - `id` is
-- `GENERATED ALWAYS AS IDENTITY` (needs PostgreSQL 17 on a partitioned
-- table; check `server_version_num` first if this migration fails oddly on
-- an older server) and is NEVER exposed externally. The job reference tuple
-- used everywhere else in the schema is `(message_job_id,
-- message_job_created_at)`; the only externally-visible id is
-- `message_job_refs.public_id` (migration 0008).
--
-- NO FOREIGN KEYS touch this table, in either direction: nothing may
-- reference the partitioned parent (an FK to a partitioned table must carry
-- the partition key into every referencing table - blueprint [R-22c]), and
-- (judgment call, not explicitly mandated) this migration also adds no
-- outbound FK from message_jobs to clients/whatsapp_instances/campaigns,
-- mirroring wallet_ledger's "no FK on the hot append/update path" precedent
-- (migration 0004) - message_jobs is claimed and updated far more often than
-- wallet_ledger is appended to, and campaign_id's target (`campaigns`) does
-- not even exist yet at this point in the migration sequence (it lands in
-- migration 0010).
--
-- Every column below is verbatim from the architecture blueprint's
-- `message_jobs` column list, plus the scope-delta's group-shape addition
-- (`recipient_e164` nullable + `mj_recipient_shape`). Columns with no
-- stated default/nullability in the blueprint are left NULLable except
-- where a CHECK/index/lifecycle invariant requires NOT NULL (documented
-- inline). `max_attempts DEFAULT 5` is this migration's own judgment call
-- (no default was specified upstream; the app may always override at
-- INSERT) - flagged in the P03 session report.

CREATE TABLE message_jobs (
  id                              bigint GENERATED ALWAYS AS IDENTITY,
  client_id                       uuid NOT NULL,
  instance_id                     uuid NOT NULL, -- every claim/pacing/health scope is per (client_id, instance_id)
  session_epoch                   int NOT NULL DEFAULT 0,
  campaign_id                     uuid,
  recipient_jid                   text NOT NULL, -- always present; see mj_recipient_shape below
  recipient_e164                  text, -- NULLABLE (delta): a group recipient has no E.164 number
  recipient_hash                  bytea, -- app-computed hash of the resolved recipient, for the index-5 per-recipient lookback
  payload                         jsonb NOT NULL,
  payload_kind                    job_kind NOT NULL,
  priority                        job_priority NOT NULL,
  priority_rank                   smallint NOT NULL, -- denormalized numeric weight for ORDER BY in the claim index; app-derived from priority
  status                          job_status NOT NULL DEFAULT 'created',
  scheduled_at                    timestamptz NOT NULL DEFAULT now(),
  next_attempt_at                 timestamptz NOT NULL DEFAULT now(),
  attempts                        smallint NOT NULL DEFAULT 0,
  max_attempts                    smallint NOT NULL DEFAULT 5, -- no upstream default given; app may override per-insert (judgment call)
  lease_owner                     text,
  lease_id                        uuid,
  owner_fence                     bigint,
  leased_at                       timestamptz,
  lease_expires_at                timestamptz,
  sent_at                         timestamptz,
  failed_at                       timestamptz,
  terminal_at                     timestamptz,
  cancel_reason                   text,
  last_error_class                text,
  pacing_reserved_at              timestamptz,
  pacing_refunded_at              timestamptz,
  pacing_ledger_date              date,
  pacing_deny_reason               text,
  pacing_deferrals                int NOT NULL DEFAULT 0,
  is_new_conversation             boolean NOT NULL DEFAULT false,
  content_fingerprint             bytea,
  content_fingerprint_counted_at  timestamptz,
  send_origin                     text,
  needs_user_action               boolean NOT NULL DEFAULT false,
  created_by_user_id              uuid,
  created_by_api_key_id           uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(), -- partition key
  CONSTRAINT message_jobs_pkey PRIMARY KEY (id, created_at),
  -- Test 22 (subset assertion at P03 - see db/tests/schema-assertions.test.ts):
  -- message_jobs carries no reserve-counter column at all.
  CONSTRAINT mj_payload_size CHECK (octet_length(payload::text) <= 2048),
  CONSTRAINT mj_attempts_range CHECK (attempts >= 0 AND attempts <= max_attempts + 1),
  CONSTRAINT mj_sent_has_sent_at CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  -- Delta group shape: a group recipient (recipient_jid ending @g.us) has no
  -- E.164 number; every other recipient must carry one.
  CONSTRAINT mj_recipient_shape CHECK (recipient_e164 IS NOT NULL OR recipient_jid LIKE '%@g.us')
) PARTITION BY RANGE (created_at);

-- FILLFACTOR 70 (canon): verified directly against the dev DB (PG 17.0.11)
-- that Postgres rejects a storage parameter on a partitioned table itself,
-- in BOTH `CREATE TABLE ... PARTITION BY ... WITH (...)` and a follow-up
-- `ALTER TABLE ... SET (...)` - "cannot specify storage parameters for a
-- partitioned table / HINT: Specify storage parameters for its leaf
-- partitions instead." wallet_ledger (migration 0004), the one other
-- partitioned table in this schema, hits the same wall and also carries no
-- fillfactor - this migration follows that exact precedent rather than
-- inventing a workaround: message_jobs is created WITHOUT a table-level
-- FILLFACTOR clause. Setting it per-leaf-partition would need
-- wp_ensure_month_partition (migration 0003, a generic shared helper also
-- used by wallet_ledger) to accept a per-table storage-parameter argument -
-- out of this migration's file scope; flagged in the P03 session report as
-- a deviation from the literal "FILLFACTOR 70" instruction, justified by a
-- real PG17 constraint, not a preference.

-- Current + next 2 months, via the P02 step-5 helper (migration 0003) - also
-- unconditionally seals each partition with its own RLS ENABLE+FORCE+policy.
SELECT public.wp_ensure_month_partition('message_jobs'::regclass, (now())::date);
SELECT public.wp_ensure_month_partition('message_jobs'::regclass, (now() + interval '1 month')::date);
SELECT public.wp_ensure_month_partition('message_jobs'::regclass, (now() + interval '2 months')::date);

-- The five canonical indexes. All are non-unique (message_jobs' only unique
-- constraint is the PK above, which already includes the partition key
-- `created_at` - test 21 in db/tests/schema-assertions.test.ts polices this
-- repo-wide). CREATE INDEX on a partitioned parent recurses to every
-- existing partition and is automatically inherited by every partition
-- created afterwards.

-- 1. The claim index - what db/queries/claim-jobs.sql (P03 Unit B) polls.
CREATE INDEX message_jobs_claim_idx
  ON message_jobs (client_id, instance_id, priority_rank, next_attempt_at, id)
  WHERE status = 'queued';

-- 2. The lease-expiry sweeper. Deliberately does NOT lead with client_id:
-- the sweeper that reclaims stale `processing` leases runs across every
-- tenant/instance at once, so a global (non-tenant-scoped) index is the
-- correct shape here, not an oversight.
CREATE INDEX message_jobs_lease_expiry_idx
  ON message_jobs (lease_expires_at)
  WHERE status = 'processing';

-- 3. Staff/user review queues for jobs stuck needing a decision.
CREATE INDEX message_jobs_review_idx
  ON message_jobs (client_id, instance_id, terminal_at)
  WHERE status IN ('needs_reconcile', 'blocked_needs_review');

-- 4. Recent-activity feed per instance (dashboard "current activity").
CREATE INDEX message_jobs_recent_idx
  ON message_jobs (client_id, instance_id, created_at DESC, id DESC);

-- 5. Per-recipient lookback (dedupe / recent-send checks).
CREATE INDEX message_jobs_recipient_recent_idx
  ON message_jobs (client_id, recipient_hash, sent_at DESC);

-- RLS: ENABLE + FORCE + the canonical tenant_isolation policy on the parent
-- (each partition already carries its own copy, sealed by
-- wp_ensure_month_partition above).
ALTER TABLE message_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON message_jobs FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

-- Ownership: matches the wp_migrator model established in migration 0005
-- ("wp_migrator owns every object; the only role that runs DDL/migrations").
-- The migration connection role (`wp`, a superuser) created this table and
-- its partitions/identity sequence directly, so they are explicitly
-- reassigned here rather than relying on 0005's one-time sweep (which only
-- ran over objects that already existed at that point).
ALTER TABLE message_jobs OWNER TO wp_migrator;

DO $$
DECLARE
  v_schema name;
  v_table  name;
BEGIN
  FOR v_schema, v_table IN
    SELECT n.nspname, c.relname
      FROM pg_catalog.pg_inherits i
      JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE i.inhparent = 'public.message_jobs'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO wp_migrator', v_schema, v_table);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- Grants. wp_app + wp_scheduler R/W (no DELETE anywhere - jobs are never
-- hard-deleted, only transitioned to a terminal status); wp_admin_app is
-- SELECT-only (core invariant/role model). wp_scheduler's grant here is
-- table-level SELECT+UPDATE (no INSERT: only wp_app creates jobs) - a
-- column-level narrowing to the exact set of columns db/queries/
-- claim-jobs.sql touches is deferred to P03 Unit B, which owns that file
-- and therefore knows the real column list; flagged in the session report.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON message_jobs TO wp_app;
GRANT SELECT, UPDATE ON message_jobs TO wp_scheduler;
GRANT SELECT ON message_jobs TO wp_admin_app;
