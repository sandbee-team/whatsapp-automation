-- db/seeds/queue-explain-fixture.sql (P03 Unit D, step 8) - dev/demo-only
-- load-shaped fixture for the claim-plan EXPLAIN evidence
-- (docs/evidence/P03-claim-explain.md) and for eyeballing planner behaviour
-- against a realistic row count. Never runs against prod (db/seeds/README.md).
--
-- SHAPE: 5 clients x 10 whatsapp_instances each (50 instances) x 4,000
-- message_jobs per instance = 200,000 'queued' jobs, built entirely with
-- set-based generate_series CROSS JOINs - no client-side loop anywhere in
-- this file.
--
-- RE-RUNNABLE STRATEGY (stated per the dispatch): deterministic ids, not
-- ON CONFLICT. Every fixture client_id/instance_id is derived from a fixed
-- numeric formula into a reserved UUID prefix range (`a0000000-...` for
-- clients, `b0000000-...` for instances, `c0000000-...` for client_1's
-- P23 U3 campaigns) - nothing else in this database ever uses those
-- prefixes. Re-running this file first DELETEs every row scoped to those
-- exact deterministic ids (FK-safe order: message_job_refs, message_jobs,
-- campaigns, instance_lease_state, whatsapp_instances, wallet_accounts,
-- clients), then
-- re-inserts from scratch. This is deliberately DELETE-then-INSERT, not
-- TRUNCATE (would nuke unrelated dev/demo data sharing these tables) and not
-- ON CONFLICT DO NOTHING (message_jobs.id is GENERATED ALWAYS AS IDENTITY -
-- it has no natural conflict target to upsert against; the fixture rows
-- carry no idempotency key of their own, so "delete my own rows, then
-- reinsert" is the only re-runnable shape that does not require inventing
-- one). Wrapped in one transaction so a re-run is atomic: either the old
-- fixture generation is fully replaced, or (on error) nothing changes.
--
-- CLAIM-ELIGIBILITY JOIN ROWS: every fixture client is status='active';
-- every fixture whatsapp_instances row is health_state='connected',
-- session_epoch=0 (matching every fixture job's session_epoch), deleted_at
-- IS NULL; every fixture instance_lease_state row carries the SAME known
-- current_fence=7. campaign_id is NULL on almost every job (the claim's
-- campaigns join is a LEFT JOIN with a NULL-campaign passthrough - no
-- campaigns row is needed for a claim to succeed); client_1's first four
-- instances carry a small stamped share pointing at four deterministic
-- campaigns (running/paused/cancelled/failed, see fx_campaigns below) plus a
-- smaller share pointing at a campaign_id with NO campaigns row at all (the
-- LEFT JOIN null-miss case) - everywhere else campaign_id stays NULL. EVERY
-- job stamped with a campaign_id (including the orphan-campaign share) also
-- gets a matching message_job_refs row (P23 U3b) - a campaign job never
-- exists without a ref (ADR 0017 S1; enforced fixture-wide by
-- db/tests/schema-assertions-broadcast.test.ts's
-- no_message_job_exists_without_a_matching_ref). This
-- means the canonical claim (db/queries/claim-jobs.sql) can succeed against
-- ANY fixture (client_id, instance_id) pair with fence=7 and a
-- priority_rank band of 10 (high), 20 (normal) or 30 (low) - PROVIDED that
-- client's wallet is 'active' with sufficient balance; see the wallet-state
-- note below.
--
-- WALLET STATE (P19 Unit U3 addition): client 1 (the exact
-- docs/evidence/P03-claim-explain.md `$client_id` probe target - never
-- changed, so that evidence's fixture parameters stay valid unmodified)
-- keeps its original state='active', balance_minor (10,000.00 minor units)
-- >> max_rate_minor (1.00). Clients 2-5 cycle through the ADR 0019 S4
-- wallet-stop states so a wallet-gate EXPLAIN/eyeball probe against THIS
-- fixture (not just the self-seeded claim-plan.test.ts fixture) can target
-- every state without a second fixture file: client 2 = 'empty' (zero
-- claims regardless of balance), client 3 = 'frozen' (zero claims despite a
-- large balance), client 4 = 'active' with balance_minor < max_rate_minor
-- (below the `>=` gate though positive - zero claims), client 5 = 'active'
-- with ample balance (a second healthy control, same shape as client 1).
--
-- JOB SHAPE: priority_rank is app-derived from priority per the column
-- comment in migration 0007 - this fixture's own convention is
-- high=10 / normal=20 / low=30, split evenly (job_n % 3). ~1 in 13 jobs is a
-- group recipient (recipient_jid ends '@g.us', recipient_e164 NULL) to
-- exercise the mj_recipient_shape CHECK's other branch; every other job
-- carries both recipient_jid ('...@s.whatsapp.net') and recipient_e164, and
-- a sha256 recipient_hash. payload_kind is mostly 'text', with a
-- deterministic scattering of 'media' and 'reply'. Every payload is a small
-- jsonb object (`{"text": ..., "seq": ...}`), far under the 2048-byte
-- mj_payload_size CHECK.
--
-- PARTITION SPREAD: created_at (= scheduled_at = next_attempt_at for every
-- fixture job) is bucketed 70/20/10 across the current month / next month /
-- month+2 partitions - exactly the three monthly partitions
-- wp_ensure_month_partition seeded for message_jobs at migration-apply time
-- (migration 0007). The current-month bucket (70% of rows) is shifted
-- backwards from "now" so it lands <= now() (claimable/eligible - "mostly
-- <= now()" per the dispatch); the next-month/month+2 buckets (30% of rows)
-- are shifted forward from their own month's start so they land > now()
-- (realistic far-future scheduled campaign jobs, deliberately still visible
-- to the claim's Append-over-every-partition plan by design - see
-- docs/evidence/P03-claim-explain.md point (b)). Every shift stays well
-- inside its own month (<=20 days from month start, vs a minimum 28-day
-- month) so no row can ever land in a partition that does not exist.

BEGIN;

-- ---------------------------------------------------------------------
-- Fixture id grid (temp tables so the DELETE and INSERT statements below
-- share one definition; ON COMMIT DROP ties their lifetime to this
-- transaction).
-- ---------------------------------------------------------------------
CREATE TEMP TABLE fx_clients ON COMMIT DROP AS
SELECT
  client_n,
  ('a0000000-0000-4000-a000-' || lpad(client_n::text, 12, '0'))::uuid AS client_id
FROM generate_series(1, 5) AS client_n;

CREATE TEMP TABLE fx_instances ON COMMIT DROP AS
SELECT
  c.client_n,
  c.client_id,
  i.instance_n,
  ('b0000000-0000-4000-a000-' || lpad((c.client_n * 100 + i.instance_n)::text, 12, '0'))::uuid
    AS instance_id
FROM fx_clients c
CROSS JOIN generate_series(1, 10) AS i(instance_n);

-- P19 Unit U3: per-client wallet state/balance grid - see the file header's
-- "WALLET STATE" note above for the rationale behind each client_n's values.
CREATE TEMP TABLE fx_wallet_states ON COMMIT DROP AS
SELECT * FROM (VALUES
  (1, 'active'::wallet_state, 1000000::bigint, 100::bigint),
  (2, 'empty'::wallet_state,  1000000::bigint, 100::bigint),
  (3, 'frozen'::wallet_state, 1000000000::bigint, 1::bigint),
  (4, 'active'::wallet_state, 99::bigint,       100::bigint),
  (5, 'active'::wallet_state, 1000000::bigint, 100::bigint)
) AS v(client_n, state, balance_minor, max_rate_minor);

-- P23 U3: four deterministic campaigns for client_1 (the healthy wallet
-- client - see the file header's WALLET STATE note), one per allow-list-
-- relevant status (running, paused, cancelled, and failed - a legal enum
-- label OUTSIDE the claim's allow-list, same as any other non-running/
-- non-expanding status). Each campaign references one of client_1's own
-- fixture instances (instance_n 1-4) so the claim's `campaigns` LEFT JOIN
-- (`cp.id = j.campaign_id AND cp.client_id = j.client_id`) is exercised
-- against a real, tenant-consistent row - never a cross-instance mismatch.
CREATE TEMP TABLE fx_campaigns ON COMMIT DROP AS
SELECT * FROM (VALUES
  (1, 'c0000000-0000-4000-a000-000000000001'::uuid, 'running'::broadcast_status),
  (2, 'c0000000-0000-4000-a000-000000000002'::uuid, 'paused'::broadcast_status),
  (3, 'c0000000-0000-4000-a000-000000000003'::uuid, 'cancelled'::broadcast_status),
  (4, 'c0000000-0000-4000-a000-000000000004'::uuid, 'failed'::broadcast_status)
) AS v(instance_n, campaign_id, status);

-- A campaign_id with NO campaigns row at all (the LEFT JOIN null-miss case -
-- distinct from a campaign row existing in a disallowed status).
CREATE TEMP TABLE fx_orphan_campaign ON COMMIT DROP AS
SELECT 'c0000000-0000-4000-a000-0000000000ff'::uuid AS campaign_id;

-- ---------------------------------------------------------------------
-- Wipe this fixture's own prior generation (FK-safe order), then rebuild.
-- ---------------------------------------------------------------------
DELETE FROM message_job_refs WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM message_jobs WHERE client_id IN (SELECT client_id FROM fx_clients);
-- P23a: campaign_counters / campaign_recipients reference campaigns - delete them first (2026-09-07 fix).
DELETE FROM campaign_recipients WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM campaign_counters WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM campaigns WHERE client_id IN (SELECT client_id FROM fx_clients);
DELETE FROM instance_lease_state WHERE client_id IN (SELECT client_id FROM fx_clients);
-- P23 C5 fix: integration suites attach per-instance rows (session creds/keys,
-- pacing state, health samples, notifications, ...) to this fixture's
-- permanent instances; every table with an FK to whatsapp_instances must be
-- wiped before the instances or a re-run fails on the FK (seen 2026-09-06:
-- whatsapp_session_credentials_instance_id_fkey).
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

INSERT INTO clients (id, company_name, slug, status)
SELECT client_id, 'Queue Fixture Client ' || client_n, 'queue-fixture-client-' || client_n, 'active'
FROM fx_clients;

INSERT INTO wallet_accounts (client_id, currency, balance_minor, state, max_rate_minor)
SELECT c.client_id, 'INR', ws.balance_minor, ws.state, ws.max_rate_minor
FROM fx_clients c
JOIN fx_wallet_states ws ON ws.client_n = c.client_n;

INSERT INTO whatsapp_instances (
  id, client_id, label, phone_e164, connection_status, health_state, link_state,
  desired_state, session_epoch
)
SELECT
  instance_id,
  client_id,
  'Queue Fixture Instance ' || client_n || '-' || instance_n,
  '+1555' || lpad((client_n * 100 + instance_n)::text, 7, '0'),
  'open',
  'connected',
  'linked',
  'online',
  0
FROM fx_instances;

-- Uniform, known current_fence (7) across every fixture instance - lets the
-- EXPLAIN evidence and the claim-plan test bind a single $fence value
-- regardless of which fixture (client_id, instance_id) pair they pick.
INSERT INTO instance_lease_state (instance_id, client_id, current_fence, lease_seen_at)
SELECT instance_id, client_id, 7, now()
FROM fx_instances;

-- P23 U3: the four deterministic client_1 campaigns (see fx_campaigns
-- above) - audience/message are the minimal shapes the migration 0064
-- NOT NULL columns require, frozen fixture content only.
INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
SELECT
  fc.campaign_id,
  fi.client_id,
  fi.instance_id,
  fc.status,
  'Queue Fixture Campaign ' || fc.status,
  '{"kind":"contacts","tagIds":[],"contactIds":[]}'::jsonb,
  '{"kind":"text","body":"fixture"}'::jsonb
FROM fx_campaigns fc
JOIN fx_instances fi ON fi.client_n = 1 AND fi.instance_n = fc.instance_n;

-- ---------------------------------------------------------------------
-- The 200,000-row job set: 50 instances x 4,000 jobs, fully set-based.
-- ---------------------------------------------------------------------
WITH fx_bucket_bounds AS (
  -- bucket 0: current month, shifted back from "now" (claimable jobs).
  SELECT 0 AS bucket, date_trunc('month', now()) AS p_start, now() AS p_cap
  UNION ALL
  -- bucket 1: next month, shifted forward from that month's start (future).
  SELECT 1, date_trunc('month', now() + interval '1 month'),
         date_trunc('month', now() + interval '1 month') + interval '20 days'
  UNION ALL
  -- bucket 2: month+2, same shape as bucket 1.
  SELECT 2, date_trunc('month', now() + interval '2 months'),
         date_trunc('month', now() + interval '2 months') + interval '20 days'
),
fx_jobs AS (
  SELECT
    fi.client_id,
    fi.instance_id,
    gs.job_n,
    -- 70% current month / 20% next month / 10% month+2.
    (CASE WHEN gs.job_n % 10 < 7 THEN 0 WHEN gs.job_n % 10 < 9 THEN 1 ELSE 2 END) AS bucket,
    CASE
      WHEN gs.job_n % 13 = 0
        THEN '12036' || lpad(((fi.client_n * 100 + fi.instance_n) * 100000 + gs.job_n)::text, 14, '0') || '@g.us'
      ELSE '1555' || lpad(((fi.client_n * 100 + fi.instance_n) * 100000 + gs.job_n)::text, 11, '0') || '@s.whatsapp.net'
    END AS recipient_jid,
    CASE
      WHEN gs.job_n % 13 = 0 THEN NULL
      ELSE '+1555' || lpad(((fi.client_n * 100 + fi.instance_n) * 100000 + gs.job_n)::text, 11, '0')
    END AS recipient_e164,
    (CASE WHEN gs.job_n % 17 = 0 THEN 'media' WHEN gs.job_n % 7 = 0 THEN 'reply' ELSE 'text' END)::job_kind
      AS payload_kind,
    (CASE gs.job_n % 3 WHEN 0 THEN 'high' WHEN 1 THEN 'normal' ELSE 'low' END)::job_priority AS priority,
    (CASE gs.job_n % 3 WHEN 0 THEN 10 WHEN 1 THEN 20 ELSE 30 END)::smallint AS priority_rank,
    -- P23 U3: on client_1's first four instances only (instance_n 1-4, the
    -- same ones fx_campaigns references), one job in 20 is stamped with
    -- that instance's own campaign_id (a real row, in every allow-list-
    -- relevant status); one job in 200 is stamped with a campaign_id that
    -- has NO campaigns row at all (fx_orphan_campaign - the LEFT JOIN
    -- null-miss case). Every other job keeps campaign_id NULL, unchanged.
    CASE
      WHEN fi.client_n = 1 AND fi.instance_n BETWEEN 1 AND 4 AND gs.job_n % 200 = 0
        THEN (SELECT campaign_id FROM fx_orphan_campaign)
      WHEN fi.client_n = 1 AND fi.instance_n BETWEEN 1 AND 4 AND gs.job_n % 20 = 0
        THEN (SELECT fc.campaign_id FROM fx_campaigns fc WHERE fc.instance_n = fi.instance_n)
      ELSE NULL
    END AS campaign_id
  FROM fx_instances fi
  CROSS JOIN generate_series(1, 4000) AS gs(job_n)
)
INSERT INTO message_jobs (
  client_id, instance_id, session_epoch, campaign_id,
  recipient_jid, recipient_e164, recipient_hash,
  payload, payload_kind, priority, priority_rank,
  status, scheduled_at, next_attempt_at, created_at
)
SELECT
  fj.client_id,
  fj.instance_id,
  0,
  fj.campaign_id,
  fj.recipient_jid,
  fj.recipient_e164,
  digest(fj.recipient_jid, 'sha256'),
  jsonb_build_object('text', 'Fixture message ' || fj.job_n, 'seq', fj.job_n),
  fj.payload_kind,
  fj.priority,
  fj.priority_rank,
  'queued',
  bb.p_start + make_interval(mins => fj.job_n % GREATEST((EXTRACT(EPOCH FROM (bb.p_cap - bb.p_start)) / 60)::int, 1)),
  bb.p_start + make_interval(mins => fj.job_n % GREATEST((EXTRACT(EPOCH FROM (bb.p_cap - bb.p_start)) / 60)::int, 1)),
  bb.p_start + make_interval(mins => fj.job_n % GREATEST((EXTRACT(EPOCH FROM (bb.p_cap - bb.p_start)) / 60)::int, 1))
FROM fx_jobs fj
JOIN fx_bucket_bounds bb ON bb.bucket = fj.bucket;

-- P23 U3b + C5 fix: NO job this fixture writes exists without a
-- message_job_refs row. Two global assertions depend on it - P11's
-- no_job_row_ever_exists_without_a_matching_ref (messages/enqueue
-- integration test, whole-table scan) and P23's
-- no_message_job_exists_without_a_matching_ref (campaign jobs) - so the
-- fixture must model the invariant for EVERY row it creates, not only the
-- campaign-stamped share. One set-based INSERT; dedupe_key is unique per row
-- ('fx:' || id) so mjr_dedupe_uq never trips on a re-run (the DELETE above
-- already wiped this fixture's own prior refs first). ~200k rows, ~20 MB.
INSERT INTO message_job_refs (
  public_id, client_id, instance_id, message_job_id, message_job_created_at, dedupe_key
)
SELECT gen_random_uuid(), client_id, instance_id, id, created_at, 'fx:' || id::text
FROM message_jobs
WHERE client_id IN (SELECT client_id FROM fx_clients);

COMMIT;
