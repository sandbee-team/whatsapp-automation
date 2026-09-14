-- db/seeds/queue-explain-fixture-remove.sql - dev/demo-only REMOVAL of the
-- queue-explain fixture that `queue-explain-fixture.sql` loads (5 clients x
-- 10 whatsapp_instances x 4,000 queued message_jobs = 200,000 rows), using
-- exactly that file's own deterministic ids and FK-safe DELETE order, and
-- nothing else: `a0000000-...` clients, `b0000000-...` instances. No other
-- row in this database uses those prefixes (see the seed's header).
--
-- WHY THIS EXISTS (2026-09-07, P26 close / go-live prep): the fixture's 50
-- instances are `desired_state='online'` but carry NO `instance_pacing_state`
-- row, so the session-worker role refuses to boot on any dev database that
-- still holds them (`PacingStateMissingError`, `engine/pacing/provision.ts` -
-- a fail-safe that must not be bypassed). Re-running the seed re-inserts the
-- same rows, so "re-run it" does not help; this file removes them. Run it
-- again only after `queue-explain-fixture.sql` was loaded to recapture
-- EXPLAIN evidence (docs/evidence/P03-claim-explain.md et al.).
--
-- Never runs against prod (db/seeds/README.md). One transaction: all or nothing.
--
--   docker exec -i wp-dev-postgres-1 psql -U wp -d wp -v ON_ERROR_STOP=1 < db/seeds/queue-explain-fixture-remove.sql
--   (or, with the host psql:  psql -h 127.0.0.1 -p 55432 -U wp -d wp -v ON_ERROR_STOP=1 -f db/seeds/queue-explain-fixture-remove.sql)

BEGIN;

CREATE TEMP TABLE fx_clients ON COMMIT DROP AS
SELECT
  client_n,
  ('a0000000-0000-4000-a000-' || lpad(client_n::text, 12, '0'))::uuid AS client_id
FROM generate_series(1, 5) AS client_n;

DELETE FROM message_job_refs WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM message_jobs WHERE client_id IN (SELECT client_id FROM fx_clients);
-- P23a added campaign_counters / campaign_recipients (FK -> campaigns); the seed's original
-- order predates them and fails here (seen 2026-09-07: campaign_counters_campaign_id_fkey).
DELETE FROM campaign_recipients WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM campaign_counters WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM campaigns WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM instance_lease_state WHERE client_id IN (SELECT client_id FROM fx_clients);
-- Every other client-scoped child table (information_schema FK scan, 2026-09-07): no-ops when
-- the fixture never wrote them, but they make this removal safe against any later seed growth.
DELETE FROM wa_groups WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM contact_tag_links WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM contact_import_errors WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM contact_imports WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM contact_tags WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM contacts WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM content_fingerprint_recipients WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM content_fingerprints WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM optout_confirmations WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM opt_outs WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM consent_records WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM recipient_send_buckets WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM client_daily_usage WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM client_limit_overrides WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM client_pricing WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM tenant_blocked_words WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM tenant_optout_keywords WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM memberships WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM whatsapp_session_credentials WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM whatsapp_session_keys WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM pacing_events WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM pacing_ledger WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM instance_pacing_overrides WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM instance_pacing_state WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM instance_recipient_contacts WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM instance_health_samples WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM notifications WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM inbound_dead_letters WHERE instance_id IN (SELECT id FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients));
DELETE FROM whatsapp_instances WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM wallet_accounts WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM clients WHERE id IN (SELECT client_id FROM fx_clients);

COMMIT;
