-- P13 (pacing-and-warmup) Unit U1 - migration 0030.
-- Forward-only, additive-only. Nine new tables (seven pacing tables plus
-- `client_limit_overrides` + the `effective_client_limits` view this
-- phase's step-2 prerequisite requires), zero ALTERs to any existing table.
--
-- WHY each table exists (blueprint canon: "Pacing (one counter table, one
-- grantor)" + the scope delta's group-columns addendum):
--
--   pacing_profiles       - the global, staff-owned catalog of named pacing
--     profiles (`conservative`/`safe_default`/`steady`). No client_id: it is
--     a platform catalog, same class as `plans`/`plan_limits` (migration
--     0002). `daily_cap_ceiling` is the profile's hard ceiling - no warm-up
--     tier or override under this profile may exceed it.
--   pacing_warmup_tiers   - the per-profile, per-tier ladder a new instance
--     climbs as it ages (day_from/day_to). Also a global catalog (keyed on
--     profile_key, not client_id).
--   instance_pacing_state - ONE row per instance: warm-up progress, health
--     score/band, and the MATERIALISED resolved (`eff_*`) limits the
--     reserve statement reads in-statement. Deliberately carries NO reserve
--     counter of its own (see `instance_pacing_state_holds_no_counter_
--     column` in db/tests/pacing-schema.test.ts) - the dual-authority bug
--     this schema exists to prevent is a second table independently
--     tracking "how many have been sent". `eff_*` is rewritten by
--     PacingConfigService (U2) in the SAME transaction as any profile/
--     warm-up/band/override change, so the reserve statement never reads a
--     stale cached cap.
--   pacing_ledger          - THE authoritative counter and THE only
--     grantor: every reserve/refund the dispatch loop performs is a
--     conditional UPDATE against this table's `(instance_id, ledger_date)`
--     row (core invariant 3). `ledger_date` is the instance's LOCAL date
--     (computed IN-statement from `instance_pacing_state.pacing_timezone`
--     at reserve time), not UTC - a warm-up/daily-cap day boundary must
--     track the account's own day, not the server's.
--   client_daily_usage     - the plan-level daily-send cap, enforced by the
--     exact same reserve mechanism (one authoritative counter, conditional
--     UPDATE), just rolled up per client instead of per instance.
--   pacing_events           - the audit/evidence timeline: every warm-up
--     advance/rollback, health-band change, config change and hard-signal
--     pause, with the evidence that triggered it. Drives the panel timeline
--     and the "at most 2 band improvements per 24h" derivation (hence the
--     `(client_id, instance_id, created_at DESC)` index below).
--   instance_pacing_overrides - tenant-tighten / admin-relax exceptions to
--     the profile-derived limits, each with a reason, actor and optional
--     expiry - the audit trail a relax/tighten decision needs.
--   client_limit_overrides / effective_client_limits - P02 was supposed to
--     land these (referenced by this phase's plan-cap predicate) but did
--     not; created here per this phase file's explicit step-2 instruction.
--     See the view's own comment below for the resolution semantics.
--
-- THE THREE GROUP COLUMNS (scope delta "Schema delta -> Groups") are folded
-- directly into the CREATE TABLEs below (not separate ALTERs) since all
-- three tables are new in this migration:
--   pacing_ledger.group_sent_count        int NOT NULL DEFAULT 0
--   instance_pacing_state.eff_group_daily_cap int NOT NULL DEFAULT 0
--   pacing_warmup_tiers.group_daily_cap   int NOT NULL DEFAULT 0
--
-- STORAGE PARAMETERS: `pacing_ledger` is `WITH (fillfactor = 70)` - the
-- same "hot renew, narrow row, leave HOT-update headroom" idiom
-- `wallet_accounts` uses (migration 0004) and `instance_lease_state`/
-- `whatsapp_session_keys` extend with autovacuum tuning (migrations 0018/
-- 0020): this row is UPDATEd on every single reserve/refund for the
-- instance, all day, every day - the highest-churn row in the whole
-- pacing surface.
--
-- PK SHAPE - `pacing_ledger`'s PK is `(instance_id, ledger_date)` EXACTLY as
-- the blueprint specifies, NOT client_id-leading: the reserve statement's
-- own conditional UPDATE / `ON CONFLICT` target is `(instance_id,
-- ledger_date)` - a client_id-leading PK would make that one grant
-- statement's conflict target wrong (same "don't fix a canon-mandated
-- non-client_id-leading key" precedent as message_jobs/instance_lease_state,
-- see db/src/isolation/tenant-tables.ts CANONICAL_AUTHORITY_KEYS, updated by
-- this migration's companion TS change). Tenant scoping is RLS + the
-- `client_id` column + query predicates, not PK shape - same precedent as
-- instance_lease_state/whatsapp_session_credentials.
--
-- RLS - every table below that carries `client_id` gets the canonical
-- ENABLE + FORCE + `tenant_isolation` policy idiom from migration 0020.
-- `pacing_profiles`/`pacing_warmup_tiers` carry NO client_id (global
-- catalogs) and are therefore NOT RLS-enabled here - registered in
-- ISOLATION_NON_TENANT_TABLES instead (companion TS change), same as
-- `plans`/`plan_limits`.
--
-- GRANTS - no `ALTER DEFAULT PRIVILEGES` anywhere in this schema (migration
-- 0005's rule); every grant below is explicit, per this phase file's step 2:
--   wp_app + wp_scheduler: R/W on pacing_ledger / client_daily_usage /
--     pacing_events (the three tables the dispatch loop's reserve/refund/
--     event-append path writes).
--   wp_admin_app: SELECT-only everywhere in this migration (BYPASSRLS
--     platform-read surface, zero write grants, same as every prior
--     migration's admin grant).
--   instance_pacing_state: wp_app + wp_scheduler get SELECT (the reserve
--     reads `eff_*`/`health_band` in-statement); ONLY wp_app gets UPDATE -
--     wp_scheduler must NOT be able to write `eff_*`, since only the config
--     service (running under wp_app, U2) rewrites materialised limits. If
--     wp_scheduler could UPDATE this table, a dispatch-loop bug could
--     silently widen its own cap - the same "narrow the writer" discipline
--     migration 0012 applied to message_jobs.
--   pacing_profiles / pacing_warmup_tiers: SELECT to both wp_app and
--     wp_scheduler (both read profile/tier data to resolve effective
--     limits), no writes to either - seeded by migration only (0031).
--   instance_pacing_overrides: wp_app R/W (the API path that records a
--     tenant-tighten or reads/serves an admin-relax); wp_scheduler SELECT
--     only (the reserve/resolve path reads active overrides, never writes
--     one).
--   client_limit_overrides: wp_app R/W (the same override-recording path,
--     mirrored at the client level); wp_scheduler SELECT (the plan-cap
--     predicate reads it via the view).
--
-- INDEXES:
--   pacing_ledger_client_idx - `(client_id)`, required for the RLS
--     predicate to use an index rather than a sequential scan under a
--     tenant-scoped connection (same idiom as whatsapp_session_credentials_
--     client_idx, migration 0020).
--   pacing_events_timeline_idx - `(client_id, instance_id, created_at DESC)`
--     for the panel's per-instance timeline query and the "<=2 band
--     improvements per 24h" derivation, both of which filter to one
--     instance and want the most recent events first.
--   client_daily_usage_client_idx - `(client_id)`, same RLS-predicate
--     reasoning as pacing_ledger's; its PK already leads with client_id but
--     is `(client_id, ledger_date)` - a lookup for "this client, any date"
--     (rare) still benefits, and it keeps the indexing story symmetric with
--     every other tenant table here. Actually: PK (client_id, ledger_date)
--     already satisfies client_id-leading lookups, so no extra index is
--     added for this table - see the CREATE TABLE below, no separate CREATE
--     INDEX statement follows it.
--   instance_pacing_overrides_active_idx - `(client_id, instance_id,
--     expires_at)` for the resolve path's "active overrides for this
--     instance" lookup (expires_at IS NULL or in the future).
--   client_limit_overrides needs no extra index: its PK
--     `(client_id, limit_key)` already leads with client_id and is exactly
--     the view's join key.

-- =======================================================================
-- 1. pacing_profiles - global catalog, no client_id.
-- =======================================================================
CREATE TABLE pacing_profiles (
  key text PRIMARY KEY,
  name text,
  is_system bool NOT NULL DEFAULT true,
  daily_cap_ceiling int,
  gap_min_floor_ms int,
  window_start_local time,
  window_end_local time,
  cold_ratio_max numeric(4,3),
  cold_ratio_floor int,
  per_recipient_24h int,
  per_recipient_7d int,
  dup_fanout_warn int,
  dup_fanout_ack int,
  hourly_cap_ceiling int
);

ALTER TABLE pacing_profiles OWNER TO wp_migrator;
GRANT SELECT ON pacing_profiles TO wp_app, wp_scheduler, wp_admin_app;

-- =======================================================================
-- 2. pacing_warmup_tiers - global catalog, no client_id. Plus
--    `group_daily_cap` (scope delta group column).
-- =======================================================================
CREATE TABLE pacing_warmup_tiers (
  profile_key text NOT NULL REFERENCES pacing_profiles(key),
  tier smallint NOT NULL,
  day_from int,
  day_to int,
  daily_cap int,
  hourly_cap int,
  new_conv_cap int,
  gap_min_ms int,
  gap_max_ms int,
  cold_ratio_max numeric(4,3),
  block_link_first_message bool,
  block_group_actions bool,
  group_daily_cap int NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_key, tier)
);

ALTER TABLE pacing_warmup_tiers OWNER TO wp_migrator;
GRANT SELECT ON pacing_warmup_tiers TO wp_app, wp_scheduler, wp_admin_app;

-- =======================================================================
-- 3. instance_pacing_state - one row per instance. NO reserve counter.
--    Plus `eff_group_daily_cap` (scope delta group column).
-- =======================================================================
CREATE TABLE instance_pacing_state (
  instance_id uuid PRIMARY KEY REFERENCES whatsapp_instances(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  profile_key text NOT NULL DEFAULT 'safe_default' REFERENCES pacing_profiles(key),
  -- rate-limited, audited timezone the instance's warm-up/daily-cap day
  -- boundary is computed against (see pacing_ledger.ledger_date above).
  pacing_timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  pacing_timezone_changed_at timestamptz,
  warmup_tier smallint NOT NULL DEFAULT 1,
  warmup_started_at timestamptz,
  warmup_tier_since timestamptz,
  health_score numeric(5,2) NOT NULL DEFAULT 85.00,
  health_band text NOT NULL DEFAULT 'healthy'
    CHECK (health_band IN ('healthy','watch','degraded','critical')),
  health_band_since timestamptz,
  last_band_improved_at timestamptz,
  last_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  engagement_exempt bool NOT NULL DEFAULT false,
  engagement_exempt_reason text,
  -- materialised resolved limits - rewritten by PacingConfigService (U2) in
  -- the SAME transaction as any profile/warm-up/band/override change, so
  -- the reserve statement never reads a cached/stale cap (see header).
  eff_daily_cap int NOT NULL,
  eff_hourly_cap int NOT NULL,
  eff_new_conv_cap int NOT NULL,
  eff_gap_min_ms int NOT NULL,
  eff_gap_max_ms int NOT NULL,
  eff_cold_ratio_max numeric(4,3) NOT NULL,
  eff_cold_ratio_floor int NOT NULL,
  eff_window_start_local time NOT NULL,
  eff_window_end_local time NOT NULL,
  eff_group_daily_cap int NOT NULL DEFAULT 0,
  config_version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT engagement_exempt OR engagement_exempt_reason IS NOT NULL)
);

CREATE INDEX instance_pacing_state_client_idx ON instance_pacing_state (client_id);

ALTER TABLE instance_pacing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_pacing_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instance_pacing_state FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE instance_pacing_state OWNER TO wp_migrator;

-- wp_scheduler: SELECT only - the reserve reads eff_*/health_band
-- in-statement but must never write them (see header "narrow the writer").
GRANT SELECT ON instance_pacing_state TO wp_scheduler;
-- wp_app: R/W - the config service (U2) runs under wp_app and rewrites
-- eff_* / warmup_tier / health_band on profile/warm-up/band/override change.
GRANT SELECT, INSERT, UPDATE ON instance_pacing_state TO wp_app;
GRANT SELECT ON instance_pacing_state TO wp_admin_app;

-- =======================================================================
-- 4. pacing_ledger - THE authoritative counter, THE only grantor. Plus
--    `group_sent_count` (scope delta group column).
-- =======================================================================
CREATE TABLE pacing_ledger (
  client_id uuid NOT NULL REFERENCES clients(id),
  instance_id uuid NOT NULL REFERENCES whatsapp_instances(id),
  ledger_date date NOT NULL,
  hour_key smallint NOT NULL DEFAULT 0,
  consumed_count int NOT NULL DEFAULT 0,
  sent_this_hour int NOT NULL DEFAULT 0,
  new_conv_count int NOT NULL DEFAULT 0,
  system_count int NOT NULL DEFAULT 0,
  sent_ok_count int NOT NULL DEFAULT 0,
  refund_count int NOT NULL DEFAULT 0,
  group_sent_count int NOT NULL DEFAULT 0,
  last_reserved_at timestamptz,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, ledger_date)
) WITH (fillfactor = 70);

CREATE INDEX pacing_ledger_client_idx ON pacing_ledger (client_id);

ALTER TABLE pacing_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE pacing_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pacing_ledger FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE pacing_ledger OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON pacing_ledger TO wp_app, wp_scheduler;
GRANT SELECT ON pacing_ledger TO wp_admin_app;

-- =======================================================================
-- 5. client_daily_usage - plan cap enforced by the same mechanism.
-- =======================================================================
CREATE TABLE client_daily_usage (
  client_id uuid NOT NULL REFERENCES clients(id),
  ledger_date date NOT NULL,
  sent_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, ledger_date)
);

ALTER TABLE client_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_daily_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_daily_usage FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE client_daily_usage OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON client_daily_usage TO wp_app, wp_scheduler;
GRANT SELECT ON client_daily_usage TO wp_admin_app;

-- =======================================================================
-- 6. pacing_events - audit/evidence timeline. `kind` is a text + CHECK, not
--    a pg enum: P13a and P16 both add kinds later, and an enum would force
--    an ALTER TYPE in every later phase (blueprint precedent for "text +
--    CHECK over enum" applies here the same way it already does for
--    message_jobs.status's sibling text columns).
-- =======================================================================
CREATE TABLE pacing_events (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  instance_id uuid REFERENCES whatsapp_instances(id),
  kind text NOT NULL
    CHECK (kind IN (
      'WARMUP_ADVANCE', 'WARMUP_ROLLBACK', 'BAND_CHANGE', 'CONFIG_CHANGE',
      'hard_signal_pause'
    )),
  from_value jsonb,
  to_value jsonb,
  reason_codes text[],
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pacing_events_timeline_idx
  ON pacing_events (client_id, instance_id, created_at DESC);

ALTER TABLE pacing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pacing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pacing_events FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE pacing_events OWNER TO wp_migrator;

GRANT SELECT, INSERT ON pacing_events TO wp_app, wp_scheduler;
GRANT SELECT ON pacing_events TO wp_admin_app;

-- =======================================================================
-- 7. instance_pacing_overrides - tenant-tighten / admin-relax exceptions.
-- =======================================================================
CREATE TABLE instance_pacing_overrides (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  instance_id uuid NOT NULL REFERENCES whatsapp_instances(id),
  kind text NOT NULL CHECK (kind IN ('tenant_tighten', 'admin_relax')),
  patch jsonb,
  reason text,
  actor_user_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX instance_pacing_overrides_active_idx
  ON instance_pacing_overrides (client_id, instance_id, expires_at);

ALTER TABLE instance_pacing_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_pacing_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instance_pacing_overrides FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE instance_pacing_overrides OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON instance_pacing_overrides TO wp_app;
GRANT SELECT ON instance_pacing_overrides TO wp_scheduler, wp_admin_app;

-- =======================================================================
-- 8. client_limit_overrides - P02's missing table, created here per this
--    phase file's explicit step-2 instruction (see migration header).
-- =======================================================================
CREATE TABLE client_limit_overrides (
  client_id uuid NOT NULL REFERENCES clients(id),
  limit_key text NOT NULL,
  limit_value int,
  reason text,
  actor_user_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, limit_key)
);

ALTER TABLE client_limit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_limit_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_limit_overrides FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE client_limit_overrides OWNER TO wp_migrator;

GRANT SELECT, INSERT, UPDATE ON client_limit_overrides TO wp_app;
GRANT SELECT ON client_limit_overrides TO wp_scheduler, wp_admin_app;

-- =======================================================================
-- 9. effective_client_limits - resolves (client_id, limit_key, limit_value).
--
-- `plan_limits` today has columns `plan_id, max_connected_instances,
-- max_registered_instances, max_broadcast_recipients` - there is NO
-- `max_daily_sends` column and no key/value shape on that table (verified:
-- migration 0002). This view therefore UNPIVOTs plan_limits' three real
-- columns into `(limit_key, limit_value)` rows, one row per client per
-- known limit key, and LEFT JOINs client_limit_overrides so a present,
-- non-expired override wins over the plan's value.
--
-- `max_daily_sends` simply has no plan-side source yet (no plan_limits
-- column backs it), so for that key this view yields the override's value
-- when one exists and NULL otherwise. That NULL is correct and
-- load-bearing, not a bug: the reserve statement's plan-cap predicate is
-- `AND (u.cap IS NULL OR u.sent_count < u.cap)` - i.e. "no configured plan
-- cap means the plan cap does not deny". The per-instance `eff_daily_cap`
-- on instance_pacing_state is still enforcing in that case, so a client
-- with no plan-level daily-send cap is not left unpaced - it is paced by
-- warm-up/profile limits alone, exactly as every already-provisioned
-- instance is today. Do NOT add a `max_daily_sends` column to plan_limits
-- to "fix" this NULL - that is a deliberate, documented gap, not an
-- omission.
-- =======================================================================
CREATE VIEW effective_client_limits AS
WITH plan_values AS (
  SELECT c.id AS client_id, 'max_connected_instances' AS limit_key,
         pl.max_connected_instances AS limit_value
    FROM clients c
    JOIN plan_limits pl ON pl.plan_id = c.plan_id
  UNION ALL
  SELECT c.id, 'max_registered_instances', pl.max_registered_instances
    FROM clients c
    JOIN plan_limits pl ON pl.plan_id = c.plan_id
  UNION ALL
  SELECT c.id, 'max_broadcast_recipients', pl.max_broadcast_recipients
    FROM clients c
    JOIN plan_limits pl ON pl.plan_id = c.plan_id
  UNION ALL
  -- max_daily_sends has no plan_limits column - the plan side is always
  -- NULL for this key; see header for why that is correct.
  SELECT c.id, 'max_daily_sends', NULL::int
    FROM clients c
)
SELECT
  pv.client_id,
  pv.limit_key,
  CASE
    WHEN clo.limit_value IS NOT NULL
         AND (clo.expires_at IS NULL OR clo.expires_at > now())
      THEN clo.limit_value
    ELSE pv.limit_value
  END AS limit_value
  FROM plan_values pv
  LEFT JOIN client_limit_overrides clo
    ON clo.client_id = pv.client_id AND clo.limit_key = pv.limit_key;

ALTER VIEW effective_client_limits OWNER TO wp_migrator;
GRANT SELECT ON effective_client_limits TO wp_app, wp_scheduler, wp_admin_app;
