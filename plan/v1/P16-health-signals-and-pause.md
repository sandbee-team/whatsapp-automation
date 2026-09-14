# P16 — health-signals-and-pause

**Goal (one line):** an instance's real WhatsApp signals are collected as evidence, scored into a band that tightens limits automatically, a hard restriction pauses it immediately with a full evidence row, and **only an authenticated human user** can start it sending again.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Depends on:** P14 (must be `done`; P13, P12, P11, P15 are `done` transitively — P15 is required for the webhook half of the pause notification)
**Blocks:** P17, P19, P24, P25

**Size warning:** this phase lands exactly on the 10-step ceiling. If step 7 is not green by mid-session,
finish step 8 (the resume endpoint — the demo depends on it) and split steps **9-10** into
`plan/v1/P16a-health-cadence-and-metrics.md` (dirty-set loop + tiered cadence + metrics + copy + the
single-writer guard). P17 then depends on **P16a**, not P16, and that row is added to `plan/README.md` at C7.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; all migrations applied; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL O2).
- `instance_pacing_state` exists with `health_score`, `health_band`, `health_band_since`, `last_band_improved_at`, `last_evidence`, the materialised `eff_*` limits and `config_version`; `PacingConfigService` rewrites those `eff_*` columns **in the same transaction** as any profile/warm-up/band change (P13).
- `pacing_ledger`, `pacing_events`, `opt_outs`, `recipient_send_buckets`, `instance_recipient_contacts` exist (P13/P14); opt-out-cancelled jobs carry `cancel_reason='opt_out'`.
- `send_attempts` (with `error_class`, `resolved_at`) and `delivery_events` exist and are written on every send outcome (P11/P12); the retry classifier emits `SendErrorClass` and the `disconnect-map` emits Baileys close reasons (P08).
- `whatsapp_instances` carries `health_state`, `pause_reason`, `paused_at`, `paused_by_user_id`, `needs_user_action`, `user_action_reason`, `session_epoch` (P08); the claim already predicates on `i.health_state='connected'` (P03/P11).
- The outbox table + `ROLE=relay` + signed customer webhooks exist (P15). **Email is not built yet — it lands in P17.**
- ADRs 0013, 0015, 0017, 0018, 0020 accepted. `.claude/skills/safety-compliance/SKILL.md` is binding for every string and every transition written this session.

## What you are building (3-6 bullets)
- Evidence collectors for **all twelve** signals (one file each, `collect()` + `severity()`), of which only **three are scored** — hard restriction (override), rejected-send rate, delivery ratio — plus the `rate_limited` **fast lane**. The other nine record evidence and contribute **0** penalty in v1.
- The scorer: `clamp(0,100,100 − Σ weight×severity)`, weights summing to 120, EWMA α=0.3 over ticks, per-signal minimum evidence (an unmeasured instance is not an unhealthy one), and `evidence` JSON persisted per evaluation.
- Bands HEALTHY/WATCH/DEGRADED/CRITICAL with **immediate tightening**, and loosening gated on +8 hysteresis, a dwell period (2 h / 6 h), no hard signal in 24 h, ≤1 improvement per 6 h and ≤2 per 24 h, plus flap suppression (a third band change inside an hour applies only in the tightening direction).
- The hard-signal pause: `health_state='paused'` within one tick, a `pacing_events` row of kind `hard_signal_pause` carrying the complete signal vector / effective limits / warm-up tier / account age / 30-day send history, an audit row and an outbox notification — and the `@g.us` authorisation carve-out so a group permission error **never** pauses the number.
- Human-only resume: `POST /v1/instances/:id/resume` returns 403 for `actor_type='api_key'` and `actor_type='system'`, requires the acknowledgement flag when `pause_reason='provider_restriction'`, writes an audit row with `actor_user_id`, and publishes a wake.
- Dirty-set evaluation: `eval_due_at` + a `LIMIT`-ed O(due) scan on a tiered cadence (60 s / 5 min / 30 min) — never an O(active instances) loop.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | § **Signal-driven health** (weights, shipping order `[R-27s]`, `hard_signal_pause` row `[R-10s]`, `engagement_exempt` structural rule); § **Human-only transitions** `[R-7c]`; § **Failure behaviour matrix** (restriction / reconnect-budget / `rate_limited` / session-replaced rows + the universal rules paragraph); § Pacing tables (`instance_pacing_state`, `pacing_events`); § Observability (`wp_health_score`, `wp_health_band_changes_total`, `wp_pacing_band_flaps_total`) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | § **Groups** — the `group_forbidden` terminal class (403 on a `@g.us` target is **not** a restriction signal) and the group band rules (`watch` ×0.5 on the group cap, `degraded` → 0); § **What breaks first** row **5** (dirty set + tiered cadence, threshold 1,500) and row **4** (no singleton loop O(active) faster than 5 min); § Observability (four-gauge `instance_id` allow-list); § Zero balance… "publishes a wake" normative rule |
| ADR | `.memory/decisions/0015-safe-mode-pacing-warmup-and-health.md` | all |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §4 (loop cadence rules), §6 (placement neutrality — health must not leak into placement) |
| Design | `.memory/research/2026-08-25-v1-design-safe-mode.md` | §3.1 signal table (windows, weights, thresholds, min evidence), §3.2 bands + transition rules + anti-flap, §5 panel copy, §6.1 module tree, §6.6 observability, §7 tests **10-15, 24, 30** |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms; honest claims |
| Invariants | `.claude/rules/core-invariants.md` | all (2, 5, 6 bite hardest here) |
| Path rules | `.claude/rules/db-*.md`, `.claude/rules/queue-*.md`, `.claude/rules/api-*.md` | all |

**Dispatch plan (written 2026-09-03, SESSION-PROTOCOL E1):**
- **Unit A** = step 1 (db-engineer) — migration + schema files + isolation suite A + grant snapshot. Contains a migration ⇒ runs ALONE, first.
- **Unit B** = steps 2-5 (implementer) — pure health modules: signal types/registry, 12 collectors + `health-signal-windows.sql`, scorer, bands + transitions, with their unit tests and the collectors int test. After A.
- **Unit C** = steps 6-7 (implementer) — `HealthEvaluator` + `apply-band` + fast-lane + `hard-signal-pause` + `human-resume.ts` (the module-level paused→connected writer, typed user-actor-only; needed by C's own `pause_preserves_work_end_to_end`) + the `disconnect-map` `@g.us` carve-out + send-outcome/connection wiring for the fast lane; `evaluator` + `fast-lane` integration tests. After B.
- **Unit D** = step 8 (implementer) — resume contract + HTTP endpoint (calls C's `human-resume`) + `check-forbidden-mechanisms` guard (CREATED — it does not exist yet) ; `resume` integration tests. After C; parallel with E.
- **Unit E** = steps 9-10 (implementer) — dirty-set loop + tiered cadence + query registries/guards + metrics + copy + `check-health-writers` + CI wiring; loop int tests + metrics/copy unit tests. After C; parallel with D.
- **Shared contract between D‖E (explicit, per the P10 lesson):** `whatsapp_instances.health_state` and `instance_pacing_state.health_score|health_band` are written ONLY by files under `app/backend/src/modules/pacing/health/`; Unit D's resume handler performs its `health_state` write by calling the health module's human-resume function (which requires a user actor in its type), never directly. Unit D does not touch `copy.ts`, `metrics.ts`, or `session-worker.ts`; Unit E does not touch `contracts`, `roles/api.ts`, or `modules/instances/`.

## Ordered minimum steps
- [x] 1. **(db-engineer)** Migration (next free number, additive): `instance_health_samples` (append-only sparkline history — `client_id` first, `instance_id`, `score numeric(5,2)`, `band text`, `evidence jsonb`, `created_at`; index `(client_id, instance_id, created_at DESC)`; 30-day retention by `DELETE`, registered in `retention_policies`); add to `instance_pacing_state`: `eval_due_at timestamptz NOT NULL DEFAULT now()`, `eval_tier smallint NOT NULL DEFAULT 2`, `last_hard_signal_at timestamptz`; partial background index `(eval_due_at)`; extend the `pacing_events` kind check with `hard_signal_pause`, `band_change`, `band_change_suppressed`; RLS `ENABLE`+`FORCE` + policy on the new table; register it in isolation suite A; add the `wp_scheduler` SELECT grant on `instance_pacing_state (instance_id, client_id, eval_due_at, eval_tier)` and update the grant-snapshot fixture → `db/migrations/00NN_health_signals.sql`, `db/schema/instance-health-samples.ts`, `db/schema/instance-pacing-state.ts`, `db/test/isolation/suite-a.coverage.ts`, `db/test/roles/grant-snapshot.json`
- [x] 2. Signal contract + registry: `Signal { key, window, weight, minEvidence, scored: boolean, collect(ctx): {numerator, denominator, value} | 'unmeasured', severity(value): 0..1 }`; the registry declares all **12** signals with the design §3.1 weights (sum **120**) and `scored: true` on exactly `hard_restriction`, `rejected_send_rate`, `delivery_ratio` (+ the `rate_limited` fast lane declared separately as an override, not a weight) → `app/backend/src/modules/pacing/health/signals/types.ts`, `app/backend/src/modules/pacing/health/signals/registry.ts`
- [x] 3. The twelve collectors, one file each, each reading only existing tables over its own window and returning `'unmeasured'` (never `0`) when its source has no rows or the source table is not yet populated by v1 (reply rate, read ratio, recipient-block indicator): `hard-restriction`, `disconnect-frequency`, `reconnect-churn`, `transient-failure-rate`, `rejected-send-rate`, `delivery-ratio`, `read-ratio`, `invalid-jid-rate`, `recipient-block-indicator`, `opt-out-rate`, `reply-rate`, `cold-outreach-ratio`. Opt-out-**cancelled** jobs are excluded from every denominator → `app/backend/src/modules/pacing/health/signals/*.ts`, `db/queries/health-signal-windows.sql`
- [x] 4. Scorer: min-evidence gate → 0 penalty and an `unmeasured` marker in the evidence JSON; per-signal severity EWMA α=0.3 carried in `last_evidence`; `score = clamp(0,100,100 − Σ weight_i × severity_i)`; unscored signals appear in the evidence with `weightApplied: 0` → `app/backend/src/modules/pacing/health/score.ts`
- [x] 5. Bands, pure and fake-clock-driven (no DB access): thresholds 70/55/35, tightening on the first crossing tick, loosening requiring hysteresis +8 **and** dwell (WATCH→HEALTHY 2 h, DEGRADED→WATCH 6 h) **and** no hard signal in 24 h **and** the ≤1/6 h ≤2/24 h improvement budget derived from the caller-supplied `pacing_events` band-change list; flap suppression (third change inside an hour applies only when tightening); `CRITICAL → anything` is **not representable** in this module → `app/backend/src/modules/pacing/health/bands.ts`, `app/backend/src/modules/pacing/health/transitions.ts`
- [x] 6. `HealthEvaluator.evaluate(ctx, instanceId)` — one `withTenant` transaction: collect → score → band decision → on change call `PacingConfigService` to rewrite the materialised `eff_*` limits and bump `config_version` **in the same transaction** (band multipliers: cap ×1.00/×0.70/×0.40, gap ×1.0/×1.5/×2.5, new-conv ×1/×0.5/×0, group cap ×1/×0.5/×0 per the scope delta) → write `instance_health_samples` + a `pacing_events` `band_change` row + `audit_logs` + an outbox event → set `eval_due_at`/`eval_tier` → `app/backend/src/modules/pacing/health/HealthEvaluator.ts`, `app/backend/src/modules/pacing/health/apply-band.ts`
- [x] 7. Fast lane + the pause path, called from the send-outcome and `connection.update` handlers, not the tick: any `rate_limited` occurrence forces **at least WATCH** within one tick; hard restriction (403/402/406/`loggedOut`) → `health_state='paused'`, `pause_reason='provider_restriction'`, `needs_user_action=true`, `user_action_reason='RESTRICTION_SIGNAL'`, a `hard_signal_pause` `pacing_events` row containing the **complete** signal vector + `eff_*` limits + warm-up tier + account age + 30-day send history, an audit row and an outbox `instance.paused` event — all in one transaction, **queued jobs untouched**. Carve-out: a provider rejection whose target JID ends in `@g.us` with an authorisation reason is classified `group_forbidden` and contributes **nothing** to the hard-restriction signal → `app/backend/src/modules/pacing/health/fast-lane.ts`, `app/backend/src/modules/pacing/health/hard-signal-pause.ts`, `app/backend/src/provider/baileys/disconnect-map.ts` (changed: group carve-out branch)
- [x] 8. Resume: `POST /v1/instances/:id/resume` in `@wp/contracts` (`.strict()`, body `{ acknowledgement?: boolean, reason?: string }`) → 403 `RESUME_REQUIRES_USER` for `actor_type` ∈ {`api_key`,`system`}; 422 `ACKNOWLEDGEMENT_REQUIRED` when `pause_reason='provider_restriction'` and the flag is absent; on success write `health_state`, clear `pause_reason`/`needs_user_action`, `audit_logs {action:'instance.resume', actor_user_id, reason}`, outbox event, and **publish a wake** on `wp:{env}:wake:c:{client}:i:{instance}` in the same code path as the commit; extend `scripts/check-forbidden-mechanisms.ts` so no code path leaves `paused` without an `actor_user_id` → `packages/contracts/src/instances.ts`, `app/backend/src/modules/instances/resume.ts`, `app/backend/src/roles/api.ts`, `scripts/check-forbidden-mechanisms.ts`
- [x] 9. Dirty-set loop: `db/queries/health-due.sql` (`SELECT instance_id, client_id FROM instance_pacing_state WHERE eval_due_at <= now() ORDER BY eval_due_at LIMIT 200`) registered in `CROSS_TENANT_QUERIES` with role + reason + projected columns; the loop evaluates each id **inside `withTenant(clientId)`**; tiered cadence — tier 1 = 60 s (sent/failed/disconnected in the last 15 min, or band changed in the last hour), tier 2 = 5 min (connected, idle), tier 3 = 30 min (paused, parked, logged out); `markDirty(instanceId)` called from the send-outcome and connection handlers; add this module to the "no unbounded query in a scheduler loop" CI guard glob → `app/backend/src/modules/pacing/health/evaluator-loop.ts`, `app/backend/src/modules/pacing/health/dirty-set.ts`, `db/queries/health-due.sql`, `scripts/cross-tenant-queries.ts`, `scripts/check-scheduler-queries.ts`
- [x] 10. Metrics, copy and the single-writer guard: `wp_health_score`, `wp_instance_health_state`, `wp_health_band_changes_total{from,to}`, `wp_pacing_band_flaps_total`, `wp_hard_signal_pauses_total{signal}` under the four-gauge `instance_id` allow-list; pause/band/resume strings (each carrying `SAFE_MODE_DISCLAIMER`, all through `check-copy`); `scripts/check-health-writers.ts` asserting only `modules/pacing/health/**` writes `instance_pacing_state.health_score|health_band` and `whatsapp_instances.health_state` → `app/backend/src/modules/pacing/health/metrics.ts`, `app/backend/src/modules/pacing/copy.ts`, `scripts/check-health-writers.ts`, `scripts/ci.ps1`, `scripts/ci.sh`

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/modules/pacing/health/signals/registry.test.ts` | `signal_weights_sum_to_120` | the 11 weighted signals sum to exactly 120; `hard_restriction` is an override with no weight |
| `app/backend/src/modules/pacing/health/signals/registry.test.ts` | `exactly_three_signals_are_scored_in_v1` | `scored:true` set is exactly `{hard_restriction, rejected_send_rate, delivery_ratio}`; adding a fourth turns it red |
| `app/backend/src/modules/pacing/health/signals/collectors.test.ts` | `min_evidence_protects_new_instances` | **Safe Mode 15** — 4 sends / 1 failure ⇒ 0 penalty from that signal |
| `app/backend/src/modules/pacing/health/signals/collectors.test.ts` | `an_empty_source_returns_unmeasured_not_zero` | reply-rate and read-ratio collectors return `'unmeasured'`, never a 0 that reads as "bad" |
| `app/backend/test/integration/health/collectors.int.test.ts` | `opt_out_cancelled_jobs_are_excluded_from_every_denominator` | jobs with `cancel_reason='opt_out'` change no numerator or denominator |
| `app/backend/src/modules/pacing/health/score.test.ts` | `reply_rate_alone_cannot_leave_healthy_or_pause` | **Safe Mode 14** — 0% reply rate, everything else perfect ⇒ score ≥ 90, band HEALTHY |
| `app/backend/src/modules/pacing/health/score.test.ts` | `one_bad_tick_cannot_move_a_band` | EWMA α=0.3: a single 100%-failure tick from a healthy baseline does not cross a threshold |
| `app/backend/src/modules/pacing/health/score.test.ts` | `evidence_records_numerator_denominator_and_weight_applied` | every signal appears in the evidence JSON, unscored ones with `weightApplied: 0` |
| `app/backend/src/modules/pacing/health/bands.test.ts` | `tightening_applies_on_the_first_crossing_tick` | no dwell, no delay, in every downward direction |
| `app/backend/src/modules/pacing/health/bands.test.ts` | `loosening_requires_hysteresis_dwell_and_no_hard_signal_in_24h` | 78/2 h for WATCH→HEALTHY, 63/6 h for DEGRADED→WATCH; a hard signal 23 h ago blocks both |
| `app/backend/src/modules/pacing/health/bands.test.ts` | `at_most_one_improvement_per_6h_and_two_per_24h` | derived from the supplied `pacing_events` list, not a counter column |
| `app/backend/src/modules/pacing/health/bands.test.ts` | `hysteresis_and_dwell_prevent_flapping` | **Safe Mode 13** — a score oscillating across a threshold for 6 h ⇒ ≤2 improvements/24 h, tightenings immediate, flap counter bounded |
| `app/backend/src/modules/pacing/health/transitions.test.ts` | `paused_to_sending_is_not_representable_without_a_user_actor` | the transition table exposes no system/api_key path out of `paused` |
| `app/backend/test/integration/health/evaluator.int.test.ts` | `signal_driven_tightening_reduces_caps` | **Safe Mode 12** — delivery ratio 55% + opt-out 12/1,000 ⇒ WATCH within 2 ticks, `eff_daily_cap` ×0.7, `eff_gap_min_ms` ×1.5, evidence stored |
| `app/backend/test/integration/health/evaluator.int.test.ts` | `tightening_takes_effect_on_the_very_next_reserve` | the band write and the `eff_*` rewrite commit together; the next `reserve()` sees the new cap |
| `app/backend/test/integration/health/evaluator.int.test.ts` | `a_band_change_writes_sample_event_audit_and_outbox_rows` | four rows, one transaction; rollback leaves none |
| `app/backend/test/integration/health/evaluator.int.test.ts` | `degraded_band_sets_the_group_cap_to_zero` | `eff_group_daily_cap = 0` in DEGRADED, ×0.5 in WATCH (scope delta § Groups) |
| `app/backend/test/integration/health/fast-lane.int.test.ts` | `hard_restriction_signal_pauses_immediately` | **Safe Mode 10** — injected 403/402/406/`loggedOut` ⇒ `paused` within one tick, zero further claims, every queued job still `queued`, outbox event written and the P15 relay delivers a signed webhook (email is P17) |
| `app/backend/test/integration/health/fast-lane.int.test.ts` | `hard_signal_pause_row_carries_the_full_vector` | the `pacing_events` row contains the 12-signal vector, `eff_*` limits, warm-up tier, account age and 30-day send history — and no phone number, JID or body |
| `app/backend/test/integration/health/fast-lane.int.test.ts` | `rate_limited_forces_at_least_watch_within_one_tick` | one `rate_limited` outcome from HEALTHY ⇒ band WATCH, gap ×1.5, reason visible |
| `app/backend/test/integration/health/fast-lane.int.test.ts` | `a_group_forbidden_error_never_pauses_the_instance` | a 403 on a `@g.us` target ⇒ terminal `group_forbidden` on that job only; `health_state` unchanged, zero `hard_signal_pause` rows, other jobs keep sending |
| `app/backend/test/integration/health/fast-lane.int.test.ts` | `pause_preserves_work_end_to_end` | **Safe Mode 24** — pause mid-batch of 500 ⇒ 0 lost, 0 failed, 0 duplicated; after a human resume the batch drains in band order |
| `app/backend/test/integration/health/resume.int.test.ts` | `paused_instance_never_auto_resumes` | **Safe Mode 11** — 72 simulated hours with a perfect score after a restriction pause ⇒ still `paused`, zero claims, zero band-driven writes to `health_state` |
| `app/backend/test/integration/health/resume.int.test.ts` | `api_key_actor_is_rejected_at_resume` | 403 `RESUME_REQUIRES_USER`, no state change, no audit row that implies success |
| `app/backend/test/integration/health/resume.int.test.ts` | `system_actor_is_rejected_at_resume` | same, for `actor_type='system'` |
| `app/backend/test/integration/health/resume.int.test.ts` | `restriction_pause_requires_the_acknowledgement_flag` | 422 without it; success with it, and the audit row records the acknowledgement |
| `app/backend/test/integration/health/resume.int.test.ts` | `resume_publishes_a_wake_and_writes_actor_user_id` | wake published on the instance channel in the same code path as the commit; `audit_logs.actor_user_id` set |
| `app/backend/test/integration/health/evaluator-loop.int.test.ts` | `only_due_instances_are_evaluated_and_the_scan_is_limited` | non-due rows untouched; the scan uses `LIMIT` and is registered in `CROSS_TENANT_QUERIES` |
| `app/backend/test/integration/health/evaluator-loop.int.test.ts` | `a_send_outcome_marks_the_instance_dirty_for_the_sixty_second_tier` | `eval_tier=1`, `eval_due_at ≤ now()+60 s`; a paused instance falls to tier 3 |
| `app/backend/test/integration/health/evaluator-loop.int.test.ts` | `two_tenants_do_not_interfere_in_one_evaluation_pass` | isolation suite B: tenant A's evidence never enters tenant B's score |
| `app/backend/src/modules/pacing/health/metrics.test.ts` | `instance_id_label_is_not_added_to_a_fifth_gauge` | registering a fifth `instance_id` gauge throws |
| `app/backend/src/modules/pacing/copy.test.ts` | `pause_copy_has_no_banned_claims_and_carries_the_disclaimer` | **Safe Mode 31 (extended)** — every new string passes `BANNED_CLAIMS` (en + hi) and co-locates `SAFE_MODE_DISCLAIMER` |
| `scripts/__tests__/check-forbidden-mechanisms.test.ts` | `no_code_path_leaves_paused_without_an_actor_user_id` | **Safe Mode 30** — planting a system-actor resume turns it red |
| `scripts/__tests__/check-health-writers.test.ts` | `only_the_health_module_writes_health_state_or_health_band` | planting a `health_state` write in `modules/instances` turns it red |

Mandatory-suite tests this phase makes green: **Safe Mode suite (design §7) 10, 11, 12, 13, 14, 15, 24, 30** and the extension of **31**. (These are the *Safe Mode* numbers — the blueprint's engine suite has a different table where 10-15 belong to P08/P09/P12; do not confuse them.) P13's test **9** `warmup_freezes_in_watch_and_rolls_back_in_degraded` now runs against the **real** band and must be re-run.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (via `scripts/gate.ps1`, CI GREEN all 25 steps, 333 files / 1231 tests).
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED-with-notes (both notes fixed same session; notes filed in the session log).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list. Expected set below — correct it, do not trust it. -->
**Unit A (landed, green):**
- `db/migrations/0044_health_signals_and_pause.sql` — created (instance_health_samples + eval_due_at/eval_tier/last_hard_signal_at + BAND_CHANGE_SUPPRESSED kind + wp_scheduler column grants + RLS)
- `db/queries/health-samples-retention.sql` — created (bounded DELETE; **wiring gap: no loop calls it yet — folded into Unit E**)
- `db/schema/instance-health-samples.ts` — created
- `db/schema/instance-pacing-state.ts` — changed: `evalDueAt`, `evalTier`, `lastHardSignalAt` + tier check
- `db/schema/pacing-events.ts` — changed: kind CHECK widened (BAND_CHANGE_SUPPRESSED)
- `db/schema/index.ts` — changed: new table registered/exported
- `db/src/isolation/tenant-tables.ts` — changed: instance_health_samples registered (suite A)
- `db/src/isolation/canonical-authority-keys.ts` — changed: PK + eval_due_at index exemptions
- `db/schema/grants.snapshot.json` — regenerated via snapshot test (wp_scheduler due-scan columns)
- `db/src/schema-version.ts` — changed: EXPECTED_SCHEMA_VERSION 43→44
- `scripts/check-tenant-scope.ts` — changed: TENANT_TABLES mirror + new table
- `db/tests/health-schema.test.ts` — created
**Unit B (landed, green):**
- `db/queries/health-signal-windows.sql` — created (single-round-trip window query, all 12 collectors; disconnect/reconnect sourced from audit_logs — see session notes)
- `app/backend/src/modules/pacing/health/signals/types.ts` — created (Signal/CollectCtx contract + piecewise-linear severity)
- `app/backend/src/modules/pacing/health/signals/registry.ts` — created (12 signals, weights sum 120, scored = exactly 3)
- `app/backend/src/modules/pacing/health/signals/window-row.ts` — created (shared window fetch)
- `app/backend/src/modules/pacing/health/signals/ratio-evidence.ts` — created (shared min-evidence gating)
- `app/backend/src/modules/pacing/health/signals/{hard-restriction,disconnect-frequency,reconnect-churn,transient-failure-rate,rejected-send-rate,delivery-ratio,read-ratio,invalid-jid-rate,recipient-block-indicator,opt-out-rate,reply-rate,cold-outreach-ratio}.ts` — created (12 collectors)
- `app/backend/src/modules/pacing/health/score.ts` — created (EWMA α=0.3, min-evidence gate, override)
- `app/backend/src/modules/pacing/health/bands.ts` — created (pure decideBand)
- `app/backend/src/modules/pacing/health/transitions.ts` — created (exitPaused takes UserActor only)
- `app/backend/src/modules/pacing/health/signals/registry.test.ts`, `signals/collectors.test.ts`, `score.test.ts`, `bands.test.ts`, `transitions.test.ts`, `collectors.integration.test.ts` — created
**Unit C (landed; 3 of evaluator's named tests pending in C-completion):**
- `app/backend/src/modules/pacing/health/HealthEvaluator.ts` — created (collect→score→band→apply; paused structurally guarded; CRITICAL routes to hard-signal-pause)
- `app/backend/src/modules/pacing/health/health-evaluator-reads.ts` — created (sibling read helpers)
- `app/backend/src/modules/pacing/health/apply-band.ts` — created (updatePacingConfig health_band + sample + outbox; BAND_CHANGE_SUPPRESSED writer)
- `app/backend/src/modules/pacing/health/fast-lane.ts` — created (onSendOutcome rate_limited→WATCH; onConnectionUpdate 402/403/406→pause)
- `app/backend/src/modules/pacing/health/hard-signal-pause.ts` — created (one-tx pause writer: instance columns + hard_signal_pause row + audit + outbox, idempotent)
- `app/backend/src/modules/pacing/health/human-resume.ts` — created (ONLY paused-exit; UserActor-typed; post-resume state 'degraded' with FSM evidence)
- `app/backend/src/modules/pacing/health/human-resume.test.ts`, `evaluator.integration.test.ts`, `fast-lane.integration.test.ts` — created
- `app/backend/src/modules/pacing/health/evaluator-atomicity.integration.test.ts` — created (3 mandatory atomicity/reserve/group-cap tests; DEGRADED driven via applyBandChange — score floor 68 makes it unreachable via scoring in v1, documented inline)
- `app/backend/src/modules/pacing/health/__tests__/evaluator-fixtures.ts` — created (shared EWMA-priming fixture)
- `app/backend/src/provider/provider.types.ts` — changed: `group_forbidden` SendErrorClass member (additive)
- `app/backend/src/provider/baileys/error-map.ts` + `error-map.test.ts` — changed: `@g.us` authorisation carve-out (recipientJid param)
- `app/backend/src/provider/baileys/adapter.ts` — changed: threads msg.to into classifySendError
- `packages/domain/src/retry/classify.ts` + `.test.ts` — changed: group_forbidden → FAIL_PERMANENT
- `packages/domain/src/realtime/assert-ids-only.ts`, `coalesce.ts` — changed: `instance.paused` event type (additive)
- `app/backend/src/engine/pacing/warmup-evaluator.ts` — changed: exported readSystemProfileLayer for reuse
- `app/backend/src/engine/queue/send-loop-worker-wiring.ts` — changed: onSendOutcome fast-lane hook (resolveFailure closure)
- `app/backend/src/engine/session/runner-types.ts`, `runner-disconnect.ts`, `session-worker-runner-factory.ts` — changed: onConnectionUpdate fast-lane hook after applyEngineTransition (fail-safe caught)
**Unit A2 (grants follow-up, landed green):**
- `db/migrations/0045_health_writer_grants.sql` — created (wp_scheduler: instance_pacing_state health/eff column UPDATEs, whatsapp_instances user_action_reason/updated_at UPDATE + pause_reason SELECT, audit_logs INSERT, outbox_events INSERT; two grants live-discovered under SET LOCAL ROLE)
- `db/tests/wp-scheduler-health-writer-role.test.ts` — created (proves the health-writer statements under wp_scheduler + FORCE RLS; NOTE: app/backend int tests use the privileged dev pool and cannot prove grants — lesson candidate)
- `db/src/schema-version.ts` — changed: 44→45
- `db/schema/grants.snapshot.json` — regenerated (0045)
**Unit D (landed, green):**
- `app/backend/src/modules/instances/resume.ts` — created (resumeInstance service: actor guard 403, ack guard 422, one tx humanResume + audit + outbox, wake after commit)
- `app/backend/src/modules/instances/resume-support.ts` — created (typed errors)
- `app/backend/src/modules/instances/resume.routes.ts` — created (POST /v1/instances/:id/resume, session_mfa, instances:resume)
- `app/backend/src/modules/instances/index.ts` — changed: re-exports
- `app/backend/src/modules/instances/resume.integration.test.ts` — created (5 named tests incl. Safe Mode 11)
- `app/backend/src/modules/instances/__tests__/instances-routes-test-support.ts` — changed: resume deps in fixture
- `app/backend/src/platform/http/server.ts` — changed: optional resume deps registration
- `app/backend/src/roles/api.ts` — changed: resume binding (tenantDb + publishWake) — minimal, reported
- `app/backend/src/modules/tenancy/provisioning.repo.ts` — changed: 'acknowledgement' audit metadata key (additive)
- `packages/contracts/src/instances.ts`, `errors.ts`, `index.ts` — changed: resume contract (.strict()), RESUME_REQUIRES_USER 403, ACKNOWLEDGEMENT_REQUIRED 422
- `packages/domain/src/realtime/assert-ids-only.ts`, `coalesce.ts` — changed: 'instance.resumed' (additive)
- `scripts/check-forbidden-mechanisms.ts` — created (identifier scan + paused-exit-writer assertion)
- `scripts/guards/check-forbidden-mechanisms.test.ts` + `scripts/guards/__fixtures__/forbidden-mechanisms/*` — created (6 tests)
**Main session (trivial fixes, mid-wave):**
- `app/backend/src/modules/pacing/health/bands.test.ts`, `score.test.ts`, `signals/collectors.test.ts`, `signals/reply-rate.ts` — changed: "Safe Mode NN" comment rewords to SM-NN (check-copy disclaimer rule); check-copy now 1256 files, 0 violations
**Unit E (landed; 0046 grant conflict under debugger fix):**
- `app/backend/src/modules/pacing/health/dirty-set.ts` + `.test.ts` — created (markDirty → tier 1, due now)
- `app/backend/src/modules/pacing/health/eval-tier-ladder.ts` + `.test.ts` — created (pure decideEvalTier 60s/5min/30min)
- `app/backend/src/modules/pacing/health/HealthEvaluator.ts` — changed: real tier ladder replaces placeholder; writes eval_tier
- `app/backend/src/modules/pacing/health/fast-lane.ts` — changed: markDirty first statement in both entry points
- `app/backend/src/modules/pacing/health/evaluator-loop.ts` + `evaluator-loop.integration.test.ts` — created (LIMIT-ed due-scan + per-tenant evaluate, fail-safe per row; test clock-drift fixed by debugger with dual-clock pattern, lesson third-occurrence recorded)
- `db/queries/health-due.sql` — created (LIMIT 200)
- `app/backend/src/engine/session/session-worker-health-loop-wiring.ts` — created (5s±2s timer wrapper)
- `app/backend/src/roles/session-worker.ts` — changed: bootHealthEvaluatorLoop + drain stop
- `scripts/registries/cross-tenant-queries.ts` — changed: health-due + health-samples-retention entries
- `db/migrations/0046_health_eval_tier_and_retention_grants.sql` — created; corrected by debugger (wp_relay grants removed → `GRANT DELETE ON instance_health_samples TO wp_scheduler`; dev-DB row-46 recovery per the 0045 idiom)
- `packages/server-kit/src/obs/metric-policy.ts` — changed: from/to/signal labels (P16 step 10 citation)
- `app/backend/src/modules/pacing/health/metrics.ts` + `.test.ts` — created (wp_health_score label-free min-gauge, band_changes{from,to}, hard_signal_pauses{signal}, band_flaps)
- `app/backend/src/modules/pacing/health/apply-band.ts`, `hard-signal-pause.ts` — changed: metric increments
- `packages/domain/src/copy/pacing-copy.ts` + `.test.ts` — changed: 5 new pause/band/resume strings, BANNED_CLAIMS en+hi + disclaimer co-location
- `scripts/guards/health-writers-lib.ts`, `scripts/check-health-writers.ts`, `scripts/guards/check-health-writers.test.ts` + 3 fixtures — created (single-writer guard, pinned allow-list)
- `app/backend/src/modules/pacing/health/retention.ts` — created (runHealthSamplesCleanup)
- `db/queries/health-samples-retention.sql` — changed: RETURNING id, gap closed
- `app/backend/src/roles/relay.ts` — E's retention call REVERTED by debugger (wp_relay containment preserved); outbox cleanup untouched
- `app/backend/src/engine/session/session-worker-health-loop-wiring.ts` — changed by debugger: second hourly ±5min timer calls runHealthSamplesCleanup under wp_scheduler
- `db/tests/wp-scheduler-health-writer-role.test.ts` — changed by debugger: retention DELETE proven under SET LOCAL ROLE wp_scheduler
- `db/src/schema-version.ts` — changed: 45→46; `db/schema/grants.snapshot.json` — regenerated (0046)
- `.memory/lessons/2026-09-03-p16-migration-authored-inside-feature-unit-skipped-version-bump-and-containment-check.md` — created (indexed in MEMORY.md)
- `scripts/guards/registry.ts` — changed: check-health-writers + check-forbidden-mechanisms registered
- `scripts/ci-steps.ts` — changed: health-writers + forbidden-mechanisms steps
- `package.json` — changed: check:health-writers, check:forbidden-mechanisms scripts
**Gap-closer (landed, green):**
- `scripts/guards/scheduler-queries-lib.ts`, `scripts/check-scheduler-queries.ts`, `scripts/guards/check-scheduler-queries.test.ts` — created (no-unbounded-scheduler-query guard; 6 modules, 0 violations; LIMIT-or-bound accepted, single-row point writes exempt, both documented)
- `scripts/guards/registry.ts`, `scripts/ci-steps.ts`, `package.json` — changed: scheduler-queries step registered (30 guards total)
- `app/backend/src/modules/pacing/health/metrics.ts` + `.test.ts` — changed: wp_instance_health_state instance-labelled gauge (HEALTH_STATE_GAUGE_VALUES mapping) + exact-value tests; NOTE: the other 3 allow-listed fleet gauges are stubs repo-wide (pre-existing P09 gap, P25 item)
- `app/backend/src/modules/pacing/health/hard-signal-pause.ts`, `human-resume.ts` — changed: gauge set at the two health_state write points
**C2 edge-case pass (landed, green — no real bugs):**
- `app/backend/src/modules/pacing/health/hard-signal-pause-idempotency.integration.test.ts` — created (pause replay ×2, 403 replay ×3, rate_limited storm ×50 ⇒ exactly one config bump, resume-then-pause sequence, concurrent resume race ⇒ exactly one winner)
- `app/backend/src/modules/pacing/health/score.test.ts` — extended (empty window row ⇒ score 100, 9 unmeasured, JSON-safe 12-signal vector)
**Relay-reds debugger (landed, green — full test:int 331/331):**
- `app/backend/src/modules/instances/__tests__/instances-routes-test-support.ts` — changed: cleanupInstancesRecords now deletes outbox_events for created clients (resume tests were orphaning instance.resumed rows that poisoned relay's cross-tenant claim in a later file; 2 pre-existing orphans removed from dev DB)
- `.memory/lessons/2026-09-03-p16-resume-test-orphaned-outbox-rows-poisoned-relay-second-tick.md` — created (indexed; master-plan line to add at C6)
**C1 fix round (landed, green — all 2 CRITICAL + 5 WARNING + 2 SUGGESTION findings fixed):**
- `app/backend/src/modules/pacing/health/score.ts` + `score.test.ts` — hard_restriction override branches on FRESH severity before EWMA (score===0 on tick 1, exact)
- `app/backend/src/modules/pacing/health/fast-lane.ts` + `fast-lane.integration.test.ts` — real 12-signal vector + eff_* + 30d history in hard_signal_pause rows; onSendOutcome writes the current stored score (no fabricated 100-32)
- `app/backend/src/modules/pacing/health/HealthEvaluator.ts`, `health-evaluator-reads.ts`, `send-history-30d.ts` (new), `db/queries/health-send-history-30d.sql` (new) — CRITICAL branch fills limits/history; last_band_improved_at written on loosening
- `db/queries/health-due.sql` — claiming UPDATE (FOR UPDATE SKIP LOCKED subselect, RETURNING) — multi-replica double-evaluation closed; registry reason updated
- `app/backend/src/modules/pacing/health/bands.ts` + `bands.test.ts` — flap lock counts changes in BOTH directions (tighten/tighten/loosen case)
- `app/backend/src/modules/pacing/health/evaluator-loop.integration.test.ts` — claim-visibility + zero-rescan deterministic case
- `app/backend/src/modules/pacing/health/evaluator-loosening.integration.test.ts` (new) — a_loosening_tick_writes_last_band_improved_at
- `app/backend/src/modules/instances/resume.routes.ts`, `resume-support.ts`, `resume.ts`, `resume-validation.integration.test.ts` (new) — :id uuid validation (4xx not 500), reason digit-run redaction
- `db/migrations/0047_health_last_band_improved_at_grant.sql` (new), `db/src/schema-version.ts` (→47), `db/schema/grants.snapshot.json` (regenerated)
- `db/queries/health-samples-retention.sql` — stale wp_relay wiring comment corrected
**Re-review notes closed (APPROVED-with-notes → both notes fixed, green):**
- `app/backend/src/modules/pacing/health/send-history-30d.ts` — fetchSendHistory30dSafe (catch → ids-only warn → {-1,-1,-1} degraded marker); `score.ts` — computeHealthScoreSafe (degrades to score 0 + all-unmeasured vector)
- `app/backend/src/modules/pacing/health/fast-lane.ts`, `HealthEvaluator.ts` — pause paths use the Safe variants; the pause always commits (new test `a_failing_send_history_fetch_never_blocks_the_pause_from_committing`)
- `scripts/guards/scheduler-queries-lib.ts` + `check-scheduler-queries.test.ts` — IN-subselect UPDATE/DELETE never exempt; point-write exemption requires key-equality; LIMIT-deletion fixture turns red (17 tests)
- `app/backend/src/modules/pacing/health/evaluator-loop.ts`, `db/queries/health-due.sql` — claim-window docs corrected
**Main session (depcruise fix after first gate attempt):**
- `app/backend/src/modules/pacing/health/hard-signal-pause.ts`, `apply-band.ts`, `app/backend/src/modules/instances/resume.ts` — changed: deep `events/emit` / `health/human-resume` imports rerouted through module barrels
- `app/backend/src/modules/pacing/index.ts` — changed: re-exports humanResume (+types) for the resume route
**Suite-C flake debugger (pre-existing bugs, both in test files, zero P16 code):**
- `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — changed: LEASE_KEY_GRAMMAR env segment `[a-z]+`→`[^:]+` (its own FIX-P10-B doc already demanded this)
- `app/backend/src/engine/session/publish-worker-cap-wiring.integration.test.ts` — changed: workers now shutdown() in afterEach (real discovery leases were never released; 30s-TTL keys flaked the gate's interleaving)
- `.memory/lessons/2026-09-03-p16-resume-test-orphaned-outbox-rows-poisoned-relay-second-tick.md` — extended: Redis variant section
## Risks / gotchas specific to this phase
- **The nine unscored signals are the trap.** They must be collected and stored as evidence and contribute **exactly 0** points (blueprint `[R-27s]`, ADR 0015). Do not "temporarily" wire a plausible weight because the score looks flat in a demo — the weights are untuned guesses with no ban-outcome dataset, and a wrong weight silently throttles a paying customer. The registry test locks the set at three.
- **`unmeasured` is not `0`.** A collector whose source is empty (`reply_rate` has **no source in v1 at all** — no inbound message is stored, so it stays `'unmeasured'` permanently and P21 does not change that; the scored `delivery_ratio` and the unscored `read_ratio` become measurable **at P21**, from `delivery_events`, so between this phase and P21 they are legitimately `'unmeasured'`; recipient-block needs 100 sends) must return `'unmeasured'`. Returning `0` makes a brand-new instance look catastrophic and inverts the min-evidence rule.
- **`CRITICAL → paused` is a pause, not a band.** Once `health_state='paused'`, the evaluator may keep scoring and writing samples but must **never** write `health_state` upward. Model it in `transitions.ts` so the improving path is not expressible; a comment is not a control. This is the mechanism `paused_instance_never_auto_resumes` protects, and it is a safety-boundary requirement, not a preference.
- **A group 403 would have been a fleet-wide outage.** `wa_groups` is synced at most hourly, so announce-mode changes and demotions surface as a send-time 403. Without the `@g.us` carve-out, one group permission change pauses the whole number and stops every unrelated DM until a human clicks Resume. The carve-out lives in the classifier (`disconnect-map` / error classification), not in the evaluator, and its test is mandatory here even though the rest of groups lands at P24.
- **Band change and limit rewrite are one transaction or the band is a lie.** `eff_*` are materialised columns read in-statement by `reserve()`. Two transactions means a window where the band says DEGRADED and the ledger still grants tier-6 caps. `tightening_takes_effect_on_the_very_next_reserve` is the regression test.
- **Do not add a `band_changes_24h` counter column.** The improvement budget is derived from `pacing_events` (blueprint `[R-20s]`). A counter is a second authority that drifts and can be reset.
- **Do not build a loop over active instances.** ADR 0018 §4 / scope delta row 4: no singleton loop may be O(active instances) at a cadence faster than 5 minutes. The due-scan is `LIMIT`-ed and the per-instance work happens inside `withTenant`, which is also what keeps isolation suite B green.
- **The pause notification is outbox + webhook only this session.** Email and the in-app `notify()` fan-out with dedupe keys are P17. Write the outbox event now; do not stub a mailer here, and do not claim in the session log that "pause → email" works.
- **Honest copy, no exceptions.** The restriction banner states what we observed, that queued messages are preserved, that resuming requires the tenant to check the number in the WhatsApp app, and that we cannot appeal on their behalf. No timer, no "retry in 24 h", no "we will get it restored", nothing resembling "ban-proof". `SAFE_MODE_DISCLAIMER` co-presence is enforced by `check-copy`.
- **`engagement_exempt` may not touch the score.** It affects only the displayed reason and the warm-up-freeze decision. Keep it in a type the scorer cannot import; if the scorer needs it to compile, the design has been broken.
- **No PII in evidence.** The `hard_signal_pause` vector is counts, ratios, tiers and ages — never a phone number, JID, group subject or message body. The log-grep test at P25 will find it if it leaks; the reviewer should find it first.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P17 — notifications-and-instance-card. Read plan/v1/P17-notifications-and-instance-card.md and follow it exactly:
one phase, one session. Deps P16 and P15 are done (see plan/README.md). Do not start P18.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
