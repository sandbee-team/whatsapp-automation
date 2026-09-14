-- P16 (health-signals-and-pause) Unit A - migration 0044. Forward-only,
-- additive-only: no existing table dropped/retyped, no existing grant
-- narrowed (only the pacing_events.kind CHECK is widened and
-- instance_pacing_state gains three new columns, both additive).
--
-- ONE new table plus three additive changes:
--
--   1. instance_health_samples - append-only sparkline history for the
--      per-instance health score/band the panel's health widget renders
--      (design canon: dashboard shows current health state; this table is
--      the time series behind it, same "evidence timeline" class as
--      pacing_events but sampled on a fixed cadence rather than only on
--      state-change events). Shape follows pacing_events (migration 0030)
--      exactly: uuid app-generated surrogate PK (a row handle, not a
--      uniqueness authority - no natural key exists for "one health sample"),
--      client_id NOT NULL, RLS ENABLE+FORCE+tenant_isolation,
--      `(client_id, instance_id, created_at DESC)` timeline index for the
--      same per-instance-recent-first query shape pacing_events_timeline_idx
--      serves. NOT partitioned: this is small-per-instance history (one row
--      per evaluator tick per instance, 30-day retention below), the same
--      "small, naturally-bounded, NOT partitioned, retention by DELETE"
--      class as send_attempts/webhook_deliveries, not the
--      message_jobs/delivery_events partitioned-by-volume class.
--
--      `band` reuses instance_pacing_state.health_band's exact CHECK values
--      ('healthy','watch','degraded','critical') - no new vocabulary.
--
--      RETENTION: 30 days, by DELETE - no reusable retention-sweep query file
--      exists in db/queries/ to register with (checked: db/queries/ holds
--      only claim/lease/session-purge/relay-adjacent hand-written hot SQL;
--      the actual precedent, migration 0041's outbox_events retention, is a
--      bounded DELETE implemented in application code,
--      app/backend/src/modules/events/cleanup.ts's runOutboxCleanup, not a
--      db/queries/*.sql file). Following that same idiom, this migration
--      adds db/queries/health-samples-retention.sql: a LIMIT-ed
--      `WHERE id IN (SELECT ... LIMIT $2)` DELETE, 30-day cutoff, mirroring
--      runOutboxCleanup's shape exactly. WIRING GAP (reported to the main
--      session per this unit's dispatch): no loop calls this query yet.
--      P16 Unit E's health-evaluator sweep does NOT call it (per the
--      dispatch's explicit instruction) - the outbox/webhook cleanup loop
--      that already runs runOutboxCleanup on a timer is the natural place to
--      add a sibling call, but that loop's file is outside this unit's scope
--      and is not touched here.
--
--   2. instance_pacing_state ADD eval_due_at / eval_tier / last_hard_signal_at
--      - the health evaluator's own due-scan scheduling state, same
--      "materialised, scan-friendly" idiom as warmup_tier/warmup_started_at
--      already on this table. `eval_tier` mirrors `warmup_tier`'s smallint +
--      CHECK-list shape (three tiers: 1=frequent/new or unstable instance,
--      2=default, 3=infrequent/long-stable instance - the evaluator's own
--      tiering policy, not enforced further at the schema layer beyond the
--      three legal values). All three columns are DEFAULT-populated so every
--      existing instance_pacing_state row stays valid with no backfill.
--
--   3. pacing_events.kind CHECK widened to add 'BAND_CHANGE_SUPPRESSED' -
--      verified against migration 0038 (the last kind-list change): current
--      values are 'WARMUP_ADVANCE', 'WARMUP_ROLLBACK', 'BAND_CHANGE',
--      'CONFIG_CHANGE', 'hard_signal_pause', 'SYSTEM_SEND'. Existing
--      spellings (including the lowercase 'hard_signal_pause' and the
--      uppercase 'BAND_CHANGE') are canonical and unchanged - only the one
--      new kind is added, same DROP+ADD CONSTRAINT idiom migration 0038
--      established (CHECK constraints have no ALTER-in-place form).
--
-- GRANTS:
--   instance_health_samples - the health evaluator runs inside the
--     session-worker process under wp_scheduler (same role pacing_ledger's
--     reserve/refund path and pacing_events' append-only write already run
--     under, migration 0030) - INSERT + SELECT to wp_scheduler, append-only
--     (no UPDATE/DELETE: this table is never corrected in place, only ever
--     appended to and later swept by the retention query above, which itself
--     needs no application-role grant since it is not application code yet -
--     see wiring-gap note). wp_app gets SELECT only (the panel's own
--     sparkline-read path, same "wp_app read-only, wp_scheduler read/write"
--     split pacing_events already uses for its own append-only shape, except
--     pacing_events also grants wp_app INSERT for the config-service write
--     path - instance_health_samples has no such second writer, so wp_app is
--     SELECT-only here). wp_admin_app gets SELECT (platform read surface,
--     every migration's standard grant).
--   instance_pacing_state new columns - wp_scheduler gets column-level
--     SELECT on (instance_id, client_id, eval_due_at, eval_tier) per the
--     phase task's explicit instruction, following the column-grant idiom of
--     migrations 0012/0035 (grant exactly what the due-scan caller reads,
--     nothing wider). wp_scheduler already holds table-level SELECT on this
--     table as a whole (migration 0030) - see header note below on why this
--     statement is still issued explicitly (grants-snapshot diff clarity,
--     matching 0035's own precedent of re-stating an already-covered grant
--     when the task calls for a named column list). No UPDATE grant: only
--     wp_app (the config/evaluator write path, migration 0030's existing
--     "only wp_app rewrites this table" rule) may write eval_due_at/
--     eval_tier/last_hard_signal_at - P16's later units add the actual
--     UPDATE statement, not this schema unit.
--
-- INDEXES:
--   instance_health_samples_timeline_idx (client_id, instance_id,
--     created_at DESC) - the panel's per-instance sparkline query, same
--     shape/rationale as pacing_events_timeline_idx.
--   instance_pacing_state_eval_due_idx (eval_due_at) - the O(due) scan the
--     health evaluator's sweep loop runs ("give me every instance whose
--     eval_due_at has passed"), same class as
--     message_jobs_lease_expiry_idx/ils_stale_idx (a deliberately global,
--     non-client_id-leading index feeding a cross-tenant sweep - already
--     covered by the CANONICAL_AUTHORITY_KEYS leading_column precedent those
--     two set). Plain (non-partial) btree: unlike migration 0035's function
--     (wp_warmup_scan_due), which filters live rows via a JOIN to
--     whatsapp_instances inside the function body, there is no existing
--     partial-WHERE due-scan index idiom on instance_pacing_state itself to
--     copy (warm-up's own due-scan has no supporting index at all - it
--     ORDER BY random() LIMITs, migration 0035) - a plain btree on
--     eval_due_at is therefore the correct, idiom-consistent choice, not a
--     deviation.

-- =======================================================================
-- 1. instance_health_samples
-- =======================================================================
CREATE TABLE instance_health_samples (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  instance_id uuid NOT NULL REFERENCES whatsapp_instances(id),
  score numeric(5,2) NOT NULL,
  band text NOT NULL
    CHECK (band IN ('healthy','watch','degraded','critical')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX instance_health_samples_timeline_idx
  ON instance_health_samples (client_id, instance_id, created_at DESC);

ALTER TABLE instance_health_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_health_samples FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instance_health_samples FOR ALL
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
ALTER TABLE instance_health_samples OWNER TO wp_migrator;

-- wp_scheduler: the health evaluator's own append-only write path.
GRANT SELECT, INSERT ON instance_health_samples TO wp_scheduler;
-- wp_app: the panel's sparkline-read path, no write (same append-only
-- read-only-for-app-tier posture as pacing_events' evidence stream).
GRANT SELECT ON instance_health_samples TO wp_app;
-- wp_admin_app: platform read surface, standard across this schema.
GRANT SELECT ON instance_health_samples TO wp_admin_app;

-- =======================================================================
-- 2. instance_pacing_state - additive columns for the health evaluator's
--    due-scan scheduling state.
-- =======================================================================
ALTER TABLE instance_pacing_state
  ADD COLUMN eval_due_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN eval_tier smallint NOT NULL DEFAULT 2,
  ADD COLUMN last_hard_signal_at timestamptz;

ALTER TABLE instance_pacing_state
  ADD CONSTRAINT instance_pacing_state_eval_tier_check CHECK (eval_tier IN (1, 2, 3));

CREATE INDEX instance_pacing_state_eval_due_idx ON instance_pacing_state (eval_due_at);

-- Column-scoped SELECT for the evaluator's due-scan caller - see header.
GRANT SELECT (instance_id, client_id, eval_due_at, eval_tier)
  ON instance_pacing_state TO wp_scheduler;

-- =======================================================================
-- 3. pacing_events.kind - widen CHECK to add 'BAND_CHANGE_SUPPRESSED'.
--    DROP+ADD is the only additive path for a CHECK constraint (migration
--    0038 precedent); the constraint's auto-generated name is unchanged
--    since migration 0030's original CREATE TABLE.
-- =======================================================================
ALTER TABLE pacing_events DROP CONSTRAINT pacing_events_kind_check;

ALTER TABLE pacing_events ADD CONSTRAINT pacing_events_kind_check
  CHECK (kind IN (
    'WARMUP_ADVANCE', 'WARMUP_ROLLBACK', 'BAND_CHANGE', 'CONFIG_CHANGE',
    'hard_signal_pause', 'SYSTEM_SEND', 'BAND_CHANGE_SUPPRESSED'
  ));
