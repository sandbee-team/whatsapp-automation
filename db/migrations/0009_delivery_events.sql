-- P03 (db-queue-and-claim) - migration 0009.
-- `delivery_events`: the append-only per-job event trail. WEEKLY-partitioned
-- by `created_at` (cadence registered in db/src/partitions.ts alongside the
-- monthly cadence for message_jobs/wallet_ledger). 90-day retention is a
-- LATER phase's job (a scheduled sweep/detach job, not built here) - this
-- migration only leaves the comment marker below so that phase knows where
-- to hook in.
--
-- Dedupe authority: `delivery_event_ids` (migration 0008), NOT a unique
-- index on this partitioned table itself (a unique index on a partitioned
-- table can only ever be per-partition-unique unless it carries the
-- partition key - test 21). The intended write pattern is: INSERT INTO
-- delivery_event_ids first, THEN INSERT INTO delivery_events, in the same
-- transaction - the first insert's PK violation is what makes a duplicate
-- webhook a no-op. `provider_event_id` is carried on this table too (for
-- direct lookups/joins) but is not itself constrained here.

CREATE TYPE event_type AS ENUM (
  'created',
  'queued',
  'claimed',
  'dispatched',
  'sent',
  'delivered',
  'read',
  'failed',
  'retry_scheduled',
  'paused_hold',
  'cancelled',
  'reconciled'
);

-- wp_ensure_week_partition(parent, week_start) - the weekly sibling of
-- migration 0003's wp_ensure_month_partition, same idempotent shape (create
-- if absent, then unconditionally reseal RLS ENABLE+FORCE+tenant_isolation).
-- `week_start` is truncated to the ISO week (Monday) internally, so callers
-- may pass any date within the target week. Owned by wp_migrator; EXECUTE
-- is revoked from PUBLIC and granted to no one here, matching
-- wp_ensure_month_partition's owner-only posture - db/src/partitions.ts
-- therefore must run with a wp_migrator-privileged connection, never the
-- wp_app/wp_scheduler pool (documented again at its call site).
CREATE OR REPLACE FUNCTION public.wp_ensure_week_partition(parent regclass, week_start date)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_schema          name;
  v_parent_name     name;
  v_partition_name  text;
  v_full_name       text;
  v_from            timestamptz;
  v_to              timestamptz;
  v_week            date;
BEGIN
  SELECT n.nspname, c.relname
    INTO v_schema, v_parent_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = parent;

  v_week := date_trunc('week', week_start)::date; -- Monday of the ISO week containing week_start
  v_partition_name := v_parent_name || '_y' || to_char(v_week, 'IYYY') || 'w' || to_char(v_week, 'IW');
  v_full_name := format('%I.%I', v_schema, v_partition_name);

  v_from := v_week::timestamptz;
  v_to := (v_week + 7)::timestamptz;

  IF to_regclass(v_full_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      v_schema, v_partition_name, v_schema, v_parent_name, v_from, v_to
    );
  END IF;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_partition_name);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', v_schema, v_partition_name);

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies
     WHERE schemaname = v_schema
       AND tablename = v_partition_name
       AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I FOR ALL '
      || 'USING (client_id = nullif(current_setting(%L, true), %L)::uuid) '
      || 'WITH CHECK (client_id = nullif(current_setting(%L, true), %L)::uuid)',
      v_schema, v_partition_name, 'app.client_id', '', 'app.client_id', ''
    );
  END IF;
END;
$fn$;

ALTER FUNCTION public.wp_ensure_week_partition(regclass, date) OWNER TO wp_migrator;
REVOKE ALL ON FUNCTION public.wp_ensure_week_partition(regclass, date) FROM PUBLIC;

CREATE TABLE delivery_events (
  id                       bigint GENERATED ALWAYS AS IDENTITY,
  client_id                uuid NOT NULL,
  instance_id              uuid NOT NULL,
  message_job_id            bigint,
  message_job_created_at    timestamptz,
  event_type               event_type NOT NULL,
  provider_event_id         text, -- dedupe authority is delivery_event_ids, inserted first in the same transaction (see above)
  detail                   jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(), -- partition key
  CONSTRAINT delivery_events_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT de_detail_size CHECK (octet_length(detail::text) <= 250)
) PARTITION BY RANGE (created_at);
-- 90-day retention: a later phase adds the sweep/detach job here. Do not
-- add ad-hoc DELETE logic to application code in the meantime - retention is
-- a scheduled maintenance concern, not a per-request one.

-- Current week + 2 weeks ahead, via the helper just created above.
SELECT public.wp_ensure_week_partition('delivery_events'::regclass, (now())::date);
SELECT public.wp_ensure_week_partition('delivery_events'::regclass, (now() + interval '1 week')::date);
SELECT public.wp_ensure_week_partition('delivery_events'::regclass, (now() + interval '2 weeks')::date);

CREATE INDEX delivery_events_job_idx
  ON delivery_events (client_id, instance_id, message_job_id, created_at DESC);

ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_events FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);

ALTER TABLE delivery_events OWNER TO wp_migrator;

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
     WHERE i.inhparent = 'public.delivery_events'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO wp_migrator', v_schema, v_table);
  END LOOP;
END;
$$;

-- Append-only trail; same either-role-may-write reasoning as
-- delivery_event_ids (migration 0008) - a send-result event could be
-- written by the worker (wp_scheduler) or relayed from a direct provider
-- webhook (wp_app).
GRANT SELECT, INSERT ON delivery_events TO wp_app, wp_scheduler;
GRANT SELECT ON delivery_events TO wp_admin_app;
