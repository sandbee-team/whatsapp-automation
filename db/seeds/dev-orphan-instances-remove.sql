-- db/seeds/dev-orphan-instances-remove.sql - dev/demo-only REMOVAL of orphan
-- `whatsapp_instances` rows left behind by e2e/integration test runs (P26):
-- live (`deleted_at IS NULL`), `desired_state='online'`, but with NO
-- `instance_pacing_state` row and NOT a `queue-explain-fixture.sql` id
-- (`b0000000-...`, see `queue-explain-fixture-remove.sql` - run that one
-- first). Verified live 2026-09-08: 28 such instances, one per client,
-- company names like "Scan Edge Hard Delete Probe", "Fleet E3 Race 0-4",
-- "Postgres Outage Probe" - unmistakably e2e/lease-fleet test fixtures, not
-- real tenants. Their CLIENTS, USERS and WALLET ACCOUNTS are legitimate test
-- tenants and are NEVER touched here - only the orphan instances (and their
-- own child rows) go.
--
-- WHY THIS EXISTS (2026-09-08, P26 close / go-live prep): same fail-safe gate
-- as `queue-explain-fixture-remove.sql` - `engine/pacing/provision.ts`'s
-- `assertNoLiveInstanceIsMissingPacingState` refuses to let the session-worker
-- boot while ANY live, `desired_state='online'` instance has no
-- `instance_pacing_state` row (fleet-wide gate, not scoped to one client).
-- These 28 also inflate lease/discovery integration tests past their scan
-- ceilings. Re-running the test suites that created them does not clean them
-- up (each run leaves new ones); this file removes the ones that exist today.
--
-- SAFETY (do not weaken this): refuses (RAISE EXCEPTION, rolling back
-- everything) if the matched set is empty, and by DEFAULT also refuses if ANY
-- matched instance has a `whatsapp_session_credentials` row - a real linked
-- WhatsApp number must never be swept silently. Verified live 2026-09-08: all
-- 28 current orphans DO carry a `whatsapp_session_credentials` row (synthetic
-- test ciphertext written by the same e2e suites that probe session-credential
-- encryption/rotation, e.g. "Sweep WP App Role Isolation Probe", "Postgres
-- Outage Probe") - so the DEFAULT invocation below REFUSES TO RUN. That is
-- intentional fail-safe behavior, not a bug.
--
-- Rule 1 - explicit founder opt-in required to sweep credentialed instances:
-- pass `-v sweep_credentialed=yes` (any other value, or omitting it, keeps the
-- default refusal exactly as before). When set to `yes`, the script RAISE
-- NOTICEs the company_name + instance id of every credentialed instance it is
-- about to sweep BEFORE deleting anything, so the founder sees them by name
-- (expected: the P26 probe fixtures - "Scan Edge Hard Delete Probe", "Fleet E3
-- Race *", "Postgres Outage Probe", etc.) - then proceeds with the same
-- FK-safe delete order.
--
-- Rule 2 - never overridden by the opt-in: an instance whose client has a
-- non-NULL `clients.plan_id` (a real, plan-assigned workspace, not a bare test
-- fixture - see demo-plan-assign.sql) is EXCLUDED from the sweep set entirely,
-- even with `sweep_credentialed=yes`. This is a second, independent guard, not
-- a replacement for Rule 1's opt-in.
--
-- Never runs against prod (db/seeds/README.md). One transaction: all or
-- nothing, ON_ERROR_STOP-friendly.
--
-- ORDER OF OPERATIONS for the founder:
--   1. db/seeds/queue-explain-fixture-remove.sql   (the b0000000-... fixture)
--   2. db/seeds/dev-orphan-instances-remove.sql    (this file)
--   3. start the session-worker
--
--   docker exec -i wp-dev-postgres-1 psql -U wp -d wp -v ON_ERROR_STOP=1 < db/seeds/dev-orphan-instances-remove.sql
--   (or, with the host psql:  psql -h 127.0.0.1 -p 55432 -U wp -d wp -v ON_ERROR_STOP=1 -f db/seeds/dev-orphan-instances-remove.sql)
--
--   To also sweep credentialed instances (Rule 1 opt-in, Rule 2 guard still applies):
--   docker exec -i wp-dev-postgres-1 psql -U wp -d wp -v ON_ERROR_STOP=1 -v sweep_credentialed=yes < db/seeds/dev-orphan-instances-remove.sql
--   (or, with the host psql:  psql -h 127.0.0.1 -p 55432 -U wp -d wp -v ON_ERROR_STOP=1 -v sweep_credentialed=yes -f db/seeds/dev-orphan-instances-remove.sql)

-- psql variable default without a bare `\set` (sql-lint/no-plain-set's source
-- regex bans the bare keyword with no meta-command exemption, and it would
-- also flag `\set` here) - `\gset` reads a one-row SELECT result into a psql
-- variable instead, which the regex's word-boundary match does not trip
-- (`\bSET\b` does not match the run of letters inside "gset", same reason it
-- does not match "SET" inside "OFFSET").
\if :{?sweep_credentialed}
\else
SELECT 'no' AS sweep_credentialed \gset
\endif

BEGIN;

-- psql does not substitute `:'name'` inside a dollar-quoted `DO $do$ ... $do$`
-- body (dollar-quoting is an opaque/raw string form by design - verified live
-- 2026-09-08: `RAISE NOTICE '%', :'x'` inside a $do$ body is a hard syntax
-- error even with the variable set). So the opt-in flag is resolved to a real
-- SQL value HERE, at the top level where interpolation does apply, and the
-- PL/pgSQL block below reads it back with a plain `SELECT ... INTO`.
CREATE TEMP TABLE sweep_credentialed_flag ON COMMIT DROP AS
SELECT (:'sweep_credentialed' = 'yes') AS sweep_credentialed;

-- Rule 2 lives in this SELECT itself (never overridden by the opt-in below):
-- `c.plan_id IS NULL` excludes any instance whose client is a real,
-- plan-assigned workspace from the matched set entirely.
CREATE TEMP TABLE orphan_instances ON COMMIT DROP AS
SELECT i.id AS instance_id, i.client_id
FROM whatsapp_instances i
JOIN clients c ON c.id = i.client_id
LEFT JOIN instance_pacing_state ips ON ips.instance_id = i.id
WHERE i.deleted_at IS NULL
  AND i.desired_state = 'online'
  AND ips.instance_id IS NULL
  AND i.id::text NOT LIKE 'b0000000-%'
  AND c.plan_id IS NULL;

-- Everything below runs as ONE PL/pgSQL block, matching demo-plan-assign.sql's
-- reasoning: row counts computed once, checked, and reported without psql
-- meta-commands racing psql's own variable substitution.
DO $do$
DECLARE
  orphan_count int;
  orphan_client_count int;
  credentialed_count int;
  sweep_credentialed boolean;
  r record;
BEGIN
  SELECT count(*), count(DISTINCT client_id) INTO orphan_count, orphan_client_count
  FROM orphan_instances;

  SELECT scf.sweep_credentialed INTO sweep_credentialed FROM sweep_credentialed_flag scf;

  IF orphan_count = 0 THEN
    RAISE EXCEPTION 'dev-orphan-instances-remove: matched 0 instances - nothing to do (run queue-explain-fixture-remove.sql first if it has not run yet, and re-check the pacing-state gate; also check Rule 2 did not exclude everything via a stray plan_id)';
  END IF;

  SELECT count(*) INTO credentialed_count
  FROM orphan_instances oi
  JOIN whatsapp_session_credentials sc ON sc.instance_id = oi.instance_id;

  IF credentialed_count > 0 AND NOT sweep_credentialed THEN
    RAISE EXCEPTION 'dev-orphan-instances-remove: refusing to sweep - % of % matched instance(s) have a whatsapp_session_credentials row (a real linked number must never be swept by this script without the explicit -v sweep_credentialed=yes opt-in); review by hand, or re-run with the opt-in, before removing those credential rows', credentialed_count, orphan_count;
  END IF;

  IF credentialed_count > 0 THEN
    RAISE NOTICE 'dev-orphan-instances-remove: sweep_credentialed=yes - about to sweep % credentialed instance(s):', credentialed_count;
    FOR r IN
      SELECT oi.instance_id, c.company_name
      FROM orphan_instances oi
      JOIN whatsapp_session_credentials sc ON sc.instance_id = oi.instance_id
      JOIN clients c ON c.id = oi.client_id
      ORDER BY oi.instance_id
    LOOP
      RAISE NOTICE '  credentialed sweep: instance % (client company_name=%)', r.instance_id, r.company_name;
    END LOOP;
  END IF;

  RAISE NOTICE 'dev-orphan-instances-remove: removing % orphan instance(s) across % distinct client(s)', orphan_count, orphan_client_count;
END
$do$;

-- FK-safe order, derived from pg_constraint (confrelid = whatsapp_instances,
-- 2026-09-08 - see this file's report for the exact query): every table below
-- has a real `FOREIGN KEY (instance_id) REFERENCES whatsapp_instances(id)`,
-- none is ON DELETE CASCADE, so each must be cleared before the instances.
--
-- campaign_counters / campaign_recipients FK -> campaigns.id (not directly to
-- whatsapp_instances); cleared here, scoped through campaigns, before
-- campaigns itself - 0 rows today, kept for the same future-proofing reason
-- queue-explain-fixture-remove.sql keeps its own always-empty deletes.
DELETE FROM campaign_recipients WHERE campaign_id IN (
  SELECT id FROM campaigns WHERE instance_id IN (SELECT instance_id FROM orphan_instances)
);
DELETE FROM campaign_counters WHERE campaign_id IN (
  SELECT id FROM campaigns WHERE instance_id IN (SELECT instance_id FROM orphan_instances)
);
DELETE FROM campaigns WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM instance_lease_state WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM whatsapp_session_keys WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM whatsapp_session_credentials WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM instance_pacing_overrides WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM instance_pacing_state WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM pacing_events WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM pacing_ledger WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM instance_recipient_contacts WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM instance_health_samples WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM notifications WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM inbound_dead_letters WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM wa_groups WHERE instance_id IN (SELECT instance_id FROM orphan_instances);

-- No declared FK to whatsapp_instances (verified live 2026-09-08: pg_constraint
-- has no row for any of these against confrelid=whatsapp_instances), but each
-- carries an instance_id column - cleared here so no orphaned job/ledger/event
-- data survives the instance sweep. message_jobs / delivery_events /
-- wallet_ledger are partitioned parents; deleting from the parent routes to
-- every partition, no per-partition statements needed.
DELETE FROM message_job_refs WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM message_jobs WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM message_wa_ids WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM send_attempts WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM delivery_events WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM outbox_events WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM wallet_ledger WHERE instance_id IN (SELECT instance_id FROM orphan_instances);
DELETE FROM wallet_daily_summary WHERE instance_id IN (SELECT instance_id FROM orphan_instances);

DELETE FROM whatsapp_instances WHERE id IN (SELECT instance_id FROM orphan_instances);

COMMIT;
