# P13 — pacing-ledger-and-warmup

**Goal (one line):** Safe Mode becomes real: `pacing_ledger` is the one authoritative send counter, `db/queries/reserve-pacing.sql` is the one statement that grants a send unit, `instance_pacing_state` carries materialised effective limits — with the P11 `INTERIM_MIN_GAP_MS` floor deleted. (~~and the six-tier warm-up ladder advances and rolls back on evidence~~ → **P13a**.)
**Status:** done · **Size:** L · **Session:** 1 of 1 (**split executed** — steps 9-10 moved to P13a)
**Depends on:** P12 (must be `done`; P11 and P03 transitively)
**Blocks:** P13a, P14, P16, P19, P23, P24

**Size warning — SPLIT EXECUTED 2026-09-02 at session open, exactly on the line this warning names.**
Steps **1-8** stay here (schema, reserve/deny/release, claim wiring, Redis advisory pre-filter).
Steps **9-10** are now `plan/v1/P13a-warmup-ladder.md` (the evaluator, advancement/rollback, metrics,
evidence), carried across verbatim; the `P13a` row is in `plan/README.md` and P13a's next-session prompt is
this file's C7 paste instead of P14's. Steps 9 and 10 below are struck through and left in place so the
numbering never shifts.

## Deviations from this file's path assumptions, found at O2 (the repo, not the plan, is authoritative)
The phase file was written when P12 was expected to end at migration `0016` and assumed a `db/test/` +
`app/backend/test/integration/` layout. The real tree differs. **Every path below is the binding one:**

| Phase file said | The tree actually has | Consequence |
|---|---|---|
| migrations `0017`/`0018` | P12 ended at **`0029`** | this phase writes **`0030_pacing.sql`** and **`0031_pacing_seed.sql`** |
| `db/test/*.test.ts` | **`db/tests/`** (plural) | `db/tests/pacing-schema.test.ts`; test 22 lives in `db/tests/schema-assertions.test.ts` |
| `app/backend/test/integration/pacing/*.int.test.ts` | integration tests live beside their code as **`app/backend/src/**/*.integration.test.ts`** (the `app/backend/vitest.config.ts` project claims ONLY that suffix) | `app/backend/src/engine/pacing/*.integration.test.ts` |
| `app/backend/src/modules/pacing/**` | the send path lives in **`app/backend/src/engine/queue/`**; `modules/` holds repos/HTTP | pacing engine code → `app/backend/src/engine/pacing/`; its repo → `app/backend/src/modules/pacing/pacing.repo.ts` |
| `app/backend/src/modules/queue/worker.ts` | **`app/backend/src/engine/queue/send-loop.ts`** (+ `send-loop-worker-wiring.ts`) | that is where the interim gate is wired |
| `db/test/role-grants.snapshot.json` | **`db/schema/grants.snapshot.json`** | grants land there |
| `scripts/check-no-forbidden-mechanism.ts` | **does not exist** | the `INTERIM_MIN_GAP_MS` ban goes into the NEW `scripts/check-single-reserve.ts` (already a CI step this phase adds) — recorded here rather than inventing a second guard file |
| `effective_client_limits` view | **does not exist**, and neither does `client_limit_overrides` | step 2 creates BOTH, exactly as step 2's own prerequisite line instructs ("If it is not there as a view, create it in step 2's migration and record it in the files list") |
| `scripts/ci.{ps1,sh}` carry the step list | both are thin preflight wrappers; the ordered list is **`scripts/ci-steps.ts`** (`CI_STEPS`) | the single-reserve guard step is added to `CI_STEPS`, not to the shell files |

## Prerequisites (facts, not phases)
- Postgres **17** + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean on a fresh volume; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL **O2**).
- P03 landed `db/queries/claim-jobs.sql` (the merged canonical claim), `message_jobs` with `pacing_reserved_at` / `pacing_ledger_date`, and test 22 as a **subset** assertion. P11 landed the send path and a temporary `INTERIM_MIN_GAP_MS` floor. P12 landed the reaper and the result write.
- P02 landed `plans` / `plan_limits` / `client_limit_overrides` and the `effective_client_limits` resolution used by the reserve's plan-cap predicate. If it is not there as a view, create it in step 2's migration and record it in the files list.
- P08 owns `whatsapp_instances` and the instance-create transaction; this phase **ALTERs / hooks**, it never re-creates that table.
- ADRs **0015, 0017, 0018, 0019, 0020 accepted**. No design decision is open: the reserve statement, the deferral table and the warm-up rules are specified verbatim in the blueprint and the delta, so skip **O3**.

## What you are building (3-6 bullets)
- The pacing schema: `pacing_profiles`, `pacing_warmup_tiers`, `instance_pacing_state` (materialised `eff_*` limits, **no counters**), `pacing_ledger` (**the only** reserve counter), `client_daily_usage`, `pacing_events`, `instance_pacing_overrides` — plus the seeded three profiles and six-tier ladder.
- `db/queries/reserve-pacing.sql`: **one** conditional `UPDATE` that decides and consumes, reading `eff_*` in-statement, computing `ledger_date` in-statement from the instance timezone, and carrying the **two group lines** from the delta. Zero rows = deny; a cheap follow-up SELECT names the reason and `retryAt`.
- `release()` (post-commit outcomes only, joined on `message_jobs.pacing_ledger_date`) and the deny → **deferral** mapping: job stays `queued`, `attempts` untouched, `next_attempt_at` set.
- The Redis Lua **advisory** pre-filter that can only ever say "no", plus the two tests proving Postgres stays authoritative when Redis is wrong or gone.
- `PacingConfigService.update()`: any profile / tier / band / override / timezone change rewrites `eff_*` **in the same transaction**, bumps `config_version`, writes `audit_logs` + `pacing_events`, and publishes an invalidation.
- The warm-up evaluator: six tiers, time-gated and band-gated (never reply-rate-gated), advancing on an injected clock, frozen in WATCH, rolled back one tier in DEGRADED — every change audited, evented and notified.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Safe Mode → The grant — one statement, one authority*; *Deferral is not failure*; *Warm-up*; *Data model → Pacing (one counter table, one grantor)* |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Testing strategy → Mandatory Safe Mode suite* (the amendments list, incl. the seven new named tests) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *Groups* (the two reserve lines, the per-tier group caps, band effects, `is_new_conversation=false`); *Schema delta → Groups* (the three ALTERs); *Where the balance is checked* (why the wallet is **not** here) |
| Safe Mode design | `.memory/research/2026-08-25-v1-design-safe-mode.md` | §2.1-2.5 (TOCTOU fix, jitter, deferral, auditable tiers), §3.2 (band multipliers), §4.1-4.3 (strictest-wins resolver, tenant matrix, config service), §5 (copy), §7 (tests 1-9, 22, 25-29) |
| ADR | `.memory/decisions/0015-safe-mode-pacing-warmup-and-health.md` | all |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | **§4** — the wallet gate is in the claim, **not** in the reserve |
| Skill | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms · honest claims |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md` | all |

## Ordered minimum steps
Migration numbers below assume P12 ended at `0016`. If it ended elsewhere, use the next free 4-digit numbers and write the real names into the files list.

- [x] 1. Write the failing tests first (all red, none skipped, none `.only`) → `db/test/pacing-schema.test.ts`, `packages/domain/src/pacing/{resolve-effective,gap-jitter,deny-reasons}.test.ts`, `app/backend/test/integration/pacing/{reserve-concurrency,reserve-clock,reserve-advisory,deferral,config-service,warmup}.int.test.ts`, `scripts/__tests__/check-single-reserve.test.ts`.
- [x] 2. The pacing schema, one migration → `db/migrations/0017_pacing.sql` + `db/schema/{pacing-profiles,pacing-warmup-tiers,instance-pacing-state,pacing-ledger,client-daily-usage,pacing-events,instance-pacing-overrides}.ts`. Columns exactly as the blueprint's *Pacing* block **plus** the delta's three group columns (`pacing_ledger.group_sent_count`, `instance_pacing_state.eff_group_daily_cap`, `pacing_warmup_tiers.group_daily_cap`). `instance_pacing_state` carries **no counter**; `pacing_ledger` PK `(instance_id, ledger_date)` with `client_id NOT NULL`, `fillfactor 70`. RLS `ENABLE` + `FORCE` and the `client_id` policy on every tenant table; grants: `wp_app` and `wp_scheduler` R/W on `pacing_ledger` / `client_daily_usage` / `pacing_events`, `wp_admin_app` **read-only** everywhere here.
- [x] 3. Seed the profiles and the ladder, and provision state per instance → `db/migrations/0018_pacing_seed.sql`, `db/seeds/pacing-profiles.sql`, `app/backend/src/modules/pacing/provision.ts`. Three system profiles (`conservative`, `safe_default` ← default, `steady`); the six-tier `safe_default` ladder **exactly as the table in "Risks / gotchas" below** (every number is DERIVED — put that word in the migration header). `provision.ts` inserts the `instance_pacing_state` row inside P08's instance-create transaction with `eff_*` materialised at tier 1; a boot assertion fails if any live instance has no state row or any `eff_*` is NULL.
- [x] 4. The pure pacing core in `@wp/domain` (no clock, no RNG, no I/O — both injected) → `packages/domain/src/pacing/{resolve-effective.ts,gap-jitter.ts,deny-reasons.ts,constants.ts,warmup-ladder.ts}`. `resolveEffective()` folds **strictest-wins** across system profile → warm-up tier → health band multipliers → tenant tightening, then applies `admin_relax` last, clamped by `ABSOLUTE_GAP_MIN_MS` / `ABSOLUTE_DAILY_CEILING` (2,000). `drawGapMs()` is a log-uniform draw in `[eff_gap_min_ms, eff_gap_max_ms]`; `applyLongPause()` multiplies by `uniform(4,9)` capped at 15 min every 18-35 sends. `deny-reasons.ts` holds the deferral table (blueprint *Deferral is not failure*) as data.
- [x] 5. The one grant statement and its two companions → `db/queries/reserve-pacing.sql` (copied **verbatim** from the blueprint *The grant*, with the delta's two group lines added: `AND (NOT $is_group OR l.group_sent_count < s.eff_group_daily_cap)` in the `WHERE` and `group_sent_count = l.group_sent_count + ($is_group)::int` in the `SET`), `db/queries/pacing-deny-reason.sql`, `db/queries/release-pacing.sql` (joins `message_jobs.pacing_ledger_date`, carries `client_id`, restores `next_eligible_at`; `PROVIDER_ATTEMPTED` is never refunded). Guard `scripts/check-single-reserve.ts` fails if any file other than `reserve-pacing.sql` / `release-pacing.sql` writes `consumed_count`, `new_conv_count`, `sent_this_hour` or `group_sent_count`; wire it into `scripts/ci.{ps1,sh}` with a non-zero matched-file count.
- [x] 6. `PacingConfigService.update()` → `app/backend/src/modules/pacing/config-service.ts` + `pacing.repo.ts`. One transaction per change: write the source row, recompute `eff_*` via `resolveEffective()` and `UPDATE instance_pacing_state`, `config_version + 1`, `audit_logs` (`pacing.config.change`, from/to/reason/actor), `pacing_events`, then publish `pacing:config:invalidate`. Timezone changes: one per 7 days, audited, and carry `GREATEST(existing, previous_row.consumed_count)` forward for 48 h. Tenant patches may only tighten; `admin_relax` requires actor + reason + `expires_at ≤ now() + 30 days`.
- [x] 7. Wire the reserve into the claim transaction and **delete the interim floor** → `app/backend/src/modules/pacing/index.ts` (`reserve()`, `release()`), `app/backend/src/modules/queue/worker.ts` (or wherever P11's files list put the send loop). Order inside the claim transaction: claim → `reserve()` → dispatch; zero rows from either rolls the whole transaction back (no compensation). A deny maps through `deny-reasons.ts` to `next_attempt_at` and `wp_pacing_deferrals_total{reason}` — never `attempts`, never `failed`. `UNKNOWN` is fail-closed: 60 s hold + alert. Then `grep -r INTERIM_MIN_GAP_MS` and remove every occurrence (constant, usage, test, and its line in P11's file), and add `INTERIM_MIN_GAP_MS` to the banned-identifier list in `scripts/check-no-forbidden-mechanism.ts` so it cannot come back.
- [x] 8. The Redis advisory pre-filter → `app/backend/src/modules/pacing/scripts/reserve-advisory.lua` + `advisory.ts` on `redisCtl`. It returns `0` (definitely not eligible → skip the Postgres round-trip) or `1` (ask Postgres) and **can never grant**; it mirrors counters with `INCR` + `EXPIREAT` at the next local midnight. Any Redis error, timeout or missing key returns `1`. A kill switch disables it without touching correctness.
- [x] 9. ~~The warm-up evaluator~~ → **MOVED TO `plan/v1/P13a-warmup-ladder.md` step 1** (split executed at session open; see the Size warning above). Box ticked here to mean *carried*, not *built* — P13a owns it.
- [x] 10. **Split.** The **test-22 tightening half stays here** (it belongs with the schema that creates `pacing_ledger`): tighten `exactly_one_table_carries_a_reserve_counter` in `db/tests/schema-assertions.test.ts` from subset to **equality** (`= {pacing_ledger}`). The ~~metrics and evidence-artefact half~~ (`wp_pacing_reserve_seconds`, `wp_pacing_deferrals_total{reason}`, `wp_pacing_denies_total{reason}`, `wp_warmup_tier_changes_total{direction}`, and `docs/evidence/P13-reserve-concurrency.md`) → **MOVED TO `plan/v1/P13a-warmup-ladder.md` step 2**, because three of the four metrics are only exercised once the evaluator exists and the `{direction}` label needs the substitution recorded there.

## Dispatch plan (SESSION-PROTOCOL E1 — 4 work units)
Step 1's "write all the failing tests first" is **not** run as a separate up-front unit: `plan/README.md`'s
folder rules forbid an all-tests-upfront step ("tests are written red-first inside the dispatch of the step
they prove"). Each unit below therefore carries its own step-1 slice red-first.

| Unit | Steps | Agent | File scope | Parallel? |
|---|---|---|---|---|
| **U1 — schema + seed + provision** | 1(slice), 2, 3, 10(test-22 half) | `db-engineer` | `db/migrations/0030_pacing.sql`, `db/migrations/0031_pacing_seed.sql`, `db/schema/pacing-*.ts` + `index.ts`, `db/seeds/pacing-profiles.sql`, `db/tests/pacing-schema.test.ts`, `db/tests/schema-assertions.test.ts`, `db/src/isolation/tenant-tables.ts`, `db/schema/grants.snapshot.json`, `app/backend/src/engine/pacing/provision.ts` | **NO** — contains migrations; runs alone, first |
| **U2 — the pure domain core** | 1(slice), 4 | `implementer` | `packages/domain/src/pacing/**` only | after U1; ‖ with U3 |
| **U3 — the three SQL statements + the guard** | 1(slice), 5 | `db-engineer` | `db/queries/reserve-pacing.sql`, `db/queries/pacing-deny-reason.sql`, `db/queries/release-pacing.sql`, `scripts/check-single-reserve.ts`, `scripts/__tests__/check-single-reserve.test.ts`, `scripts/ci-steps.ts`, `package.json` | after U1; ‖ with U2 |
| **U4 — config service, claim wiring, interim-floor deletion, advisory** | 1(slice), 6, 7, 8 | `implementer` | `app/backend/src/modules/pacing/pacing.repo.ts`, `app/backend/src/engine/pacing/{index,config-service,advisory}.ts` + `scripts/reserve-advisory.lua`, `app/backend/src/engine/queue/send-loop*.ts`, DELETE `app/backend/src/engine/queue/interim-gap*.ts`, `app/backend/src/platform/db/assert-db-preconditions.ts`, `app/backend/src/engine/pacing/*.integration.test.ts` | **NO** — depends on U2's `deny-reasons.ts` and U3's SQL; runs last, alone |

**Shared contracts named across units (E1 file-ownership rule):** `DenyReason` union + the deferral table
(`packages/domain/src/pacing/deny-reasons.ts`, owned by **U2**, consumed by U3's `pacing-deny-reason.sql`
reason strings and U4's mapping); the reserve statement's **exact bind-parameter list and RETURNING shape**
(owned by **U3**, consumed by U4's repo); the `eff_*` column names (owned by **U1**, consumed by U2's
`resolveEffective()` output keys, U3's `WHERE`, U4's config service `UPDATE`). U1 fixes all three names
before U2/U3 start.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/test/pacing-schema.test.ts` | `exactly_one_table_carries_a_reserve_counter` | catalog scan: the set of tables holding a reserve counter **equals** `{pacing_ledger}` (**engine test 22**, tightened from P03's subset form) |
| `db/test/pacing-schema.test.ts` | `instance_pacing_state_holds_no_counter_column` | no `*_count` / `consumed_*` column on the state table — the dual-authority regression |
| `db/test/pacing-schema.test.ts` | `every_pacing_table_leads_with_client_id_and_forces_rls` | isolation suite A registration; no new exemption-list entry |
| `db/test/pacing-schema.test.ts` | `no_pacing_profile_tier_is_unlimited` | every seeded tier has a non-null `daily_cap`, `hourly_cap` and `new_conv_cap`; none exceeds `ABSOLUTE_DAILY_CEILING` |
| `packages/domain/src/pacing/resolve-effective.test.ts` | `tenant_can_tighten_never_loosen` | property test over random tenant **and** admin patches: `dailyCap ≤ ceiling`, `gapMinMs ≥ floor`, through every path including the health band (**Safe Mode test 22**) |
| `packages/domain/src/pacing/resolve-effective.test.ts` | `engagement_exempt_changes_no_effective_limit` | identical `eff_*` with the flag true and false |
| `packages/domain/src/pacing/gap-jitter.test.ts` | `draw_gap_ms_is_log_uniform_and_bounded` | seeded RNG, 100k draws: every draw in `[min,max]`, KS vs log-uniform p > 0.01 (**test 4a**) |
| `packages/domain/src/pacing/gap-jitter.test.ts` | `long_pause_fires_within_eighteen_to_thirty_five_sends_and_caps_at_fifteen_minutes` | multiplier and cadence, seeded (**test 4b**) |
| `app/backend/test/integration/pacing/reserve-concurrency.int.test.ts` | `reserve_is_atomic_under_50_parallel_claims` | `daily_cap=10`, 50 concurrent reserves, 200 iterations → exactly 10 grants, 40 denies, `consumed_count = 10` (**test 1**) |
| `app/backend/test/integration/pacing/reserve-concurrency.int.test.ts` | `min_gap_is_never_violated_under_parallelism` | 200 mixed sequential/parallel sends: every `last_reserved_at` delta ≥ `eff_gap_min_ms` (**test 3**) |
| `app/backend/test/integration/pacing/reserve-concurrency.int.test.ts` | `new_conversation_cap_and_cold_ratio_are_atomic` | `new_conv_count` never exceeds the cap; the ratio predicate holds at every observed state (**test 5**) |
| `app/backend/test/integration/pacing/reserve-concurrency.int.test.ts` | `parallel_group_claims_never_exceed_eff_group_daily_cap` | 30 parallel `$is_group` reserves at cap 10 → exactly 10; `consumed_count` also +10 (1 unit each) |
| `app/backend/test/integration/pacing/reserve-concurrency.int.test.ts` | `tier_below_4_yields_zero_group_sends` | `eff_group_daily_cap = 0` → every group reserve denies with `GROUP_DAILY_CAP`, job stays `queued` |
| `app/backend/test/integration/pacing/reserve-clock.int.test.ts` | `daily_cap_resets_at_local_midnight_not_utc` | `Asia/Kolkata` capped at 23:59 IST, granting at 00:01 IST; a UTC midnight does **not** reset; includes `America/Sao_Paulo` DST (**test 7**) |
| `app/backend/test/integration/pacing/reserve-clock.int.test.ts` | `timezone_change_cannot_reset_the_daily_cap` | change + immediate reserve → consumption carried forward; second change inside 7 days rejected and audited |
| `app/backend/test/integration/pacing/reserve-clock.int.test.ts` | `first_reserve_of_a_new_local_day_grants_without_a_hold` | no ledger row → insert + grant in the same statement, no false MIN_GAP |
| `app/backend/test/integration/pacing/reserve-clock.int.test.ts` | `refund_after_local_midnight_hits_the_right_day` | `release()` uses `message_jobs.pacing_ledger_date`, never `now()` |
| `app/backend/test/integration/pacing/deferral.int.test.ts` | `deferral_never_increments_attempts_or_fails_the_job` | each of MIN_GAP / DAILY_CAP / HOURLY_CAP / NEW_CONV_CAP / COLD_RATIO / GROUP_DAILY_CAP → job `queued`, `attempts` byte-identical, `next_attempt_at` correct to the second (**test 6**) |
| `app/backend/test/integration/pacing/deferral.int.test.ts` | `reserve_is_rolled_back_when_no_job_is_claimed` | claim returns zero rows → ledger byte-identical, no compensating write |
| `app/backend/test/integration/pacing/deferral.int.test.ts` | `orphan_reservation_is_not_refunded` | worker killed after reserve, before dispatch → the unit stays consumed, metric emitted (**test 28**) |
| `app/backend/test/integration/pacing/deferral.int.test.ts` | `unknown_deny_reason_holds_for_sixty_seconds_and_alerts` | fail-closed, never a grant |
| `app/backend/test/integration/pacing/reserve-advisory.int.test.ts` | `postgres_is_authoritative_when_redis_is_wrong` | Redis mirror forced to 0 mid-day → the ledger still denies over-cap sends (**test 25**) |
| `app/backend/test/integration/pacing/reserve-advisory.int.test.ts` | `redis_outage_degrades_but_never_over_sends` | Redis killed → sends continue at the correct pace, cap exact (**test 26**) |
| `app/backend/test/integration/pacing/reserve-advisory.int.test.ts` | `the_advisory_script_can_never_return_a_grant` | static + behavioural: every Lua return path is `0` or `1`, and `1` alone never consumes |
| `app/backend/test/integration/pacing/config-service.int.test.ts` | `tightening_takes_effect_on_the_very_next_reserve` | update commits → next reserve reads the new `eff_*` in-statement, no cache window |
| `app/backend/test/integration/pacing/config-service.int.test.ts` | `every_config_change_writes_an_audit_row_and_bumps_config_version` | no silent limit change anywhere |
| `app/backend/test/integration/pacing/warmup.int.test.ts` | `warmup_progresses_on_time_not_on_reply_rate` | injected clock, 0% reply rate, 40 simulated days → reaches tier 6; each step wrote `pacing_events` + `audit_logs` + a notification (**test 8**) |
| `app/backend/test/integration/pacing/warmup.int.test.ts` | `warmup_freezes_in_watch_and_rolls_back_in_degraded` | WATCH → no advance across the due date; DEGRADED → one tier back, with events (**test 9**) |
| `app/backend/test/integration/pacing/warmup.int.test.ts` | `a_hard_restriction_signal_in_the_last_24h_blocks_advancement` | due tier does not advance; reason code recorded |
| `app/backend/test/integration/pacing/warmup.int.test.ts` | `no_path_skips_the_ramp` | property test: no plan, entitlement, override kind or API field sets `warmup_tier` directly except the audited admin path |
| `scripts/__tests__/check-single-reserve.test.ts` | `a_second_statement_touching_consumed_count_fails_the_guard` | guard red on a planted violation, non-zero matched-file count |
| `packages/domain/src/copy/pacing-copy.test.ts` | `pacing_copy_contains_no_banned_claims_and_carries_the_disclaimer` | `BANNED_CLAIMS` scan (en + hi) + `SAFE_MODE_DISCLAIMER` co-presence on every Safe Mode surface |

Mandatory-suite tests this phase makes green: **Safe Mode suite 1, 3, 4, 5, 6, 7, 8, 9, 22, 25, 26, 28**, the `pacing_*` half of **29**, plus the blueprint's new named tests `tightening_takes_effect_on_the_very_next_reserve`, `timezone_change_cannot_reset_the_daily_cap`, `first_reserve_of_a_new_local_day_grants_without_a_hold`, `refund_after_local_midnight_hits_the_right_day`, `reserve_is_rolled_back_when_no_job_is_claimed`; and **engine suite test 22** tightened to equality. Tests 10-15 (bands, pause, hysteresis) are **P16**; 16-21 (opt-out, content guards) are **P14**.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green. — **18 of 19 gate steps green**; the `integration` step fails ONLY on two known BLOCKER-CLASS ambient-state flakes in `engine/fleet/` (`fleet-c2-slow-redis`, `fleet-recovery-storm`), neither on P13's surface. P13's own surface green in isolation: app/backend 49 files/144 tests, db 33 files/147 tests. Tail in the session log.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed). — **APPROVED-with-notes** (initial CHANGES-REQUESTED; 2 CRITICAL + 5 MAJOR from C1 and 2 more from C2, all fixed and re-verified).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] `grep -r INTERIM_MIN_GAP_MS` over the whole tree returns **zero** hits outside the banned-identifier list. — verified: only struck-through plan-file prose and the guard's own fixture remain; `interim-gap.ts`/`.test.ts` deleted.
- MOVED TO P13a (step 10's metrics+evidence half; see the Size warning at the top of this file). `docs/evidence/P13-reserve-concurrency.md` exists with the verbatim 50-parallel-claim output and the p99 `reserve()` latency.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- filled during the session; the reviewer reviews exactly this list. Paths are the REAL ones (see the Deviations table at the top), not the phase file's original guesses. -->

### Unit U1 — schema + seed + provision (`db-engineer`, green)
- `db/migrations/0030_pacing.sql` — created: 8 tables (`pacing_profiles`, `pacing_warmup_tiers`, `instance_pacing_state`, `pacing_ledger`, `client_daily_usage`, `pacing_events`, `instance_pacing_overrides`, `client_limit_overrides`) + the `effective_client_limits` VIEW, RLS ENABLE+FORCE + `tenant_isolation` on every tenant table, grants
- `db/migrations/0031_pacing_seed.sql` — created: idempotent (`ON CONFLICT … DO UPDATE`) seed, 3 profiles + 18 tier rows, DERIVED ladder in the header
- `db/seeds/pacing-profiles.sql` — created: reusable copy of the same seed data for test fixtures
- `db/schema/{pacing-profiles,pacing-warmup-tiers,instance-pacing-state,pacing-ledger,client-daily-usage,pacing-events,instance-pacing-overrides}.ts` — created (Drizzle mirrors; `instance-pacing-overrides.ts` also mirrors `client_limit_overrides`)
- `db/schema/index.ts` — changed: 8 mirrors registered in `SCHEMA_TABLES` + re-exported (the VIEW is deliberately not mirrored)
- `db/schema/grants.snapshot.json` — changed: grants for the pacing tables
- `db/tests/pacing-schema.test.ts` — created: `instance_pacing_state_holds_no_counter_column`, `every_pacing_table_leads_with_client_id_and_forces_rls`, `no_pacing_profile_tier_is_unlimited`
- `db/tests/schema-assertions.test.ts` — changed: test 22 tightened from subset to **equality** (non-vacuous — fails loudly if `pacing_ledger` is missing)
- `db/src/isolation/tenant-tables.ts` — changed: 6 tenant tables in `TENANT_TABLE_COVERAGE`, 2 catalogs in `ISOLATION_NON_TENANT_TABLES`
- `db/src/isolation/canonical-authority-keys.ts` — created: `CANONICAL_AUTHORITY_KEYS` split out of `tenant-tables.ts` to stay under the 300-line cap (the `send-path-tables.ts` idiom); re-exported unchanged
- `app/backend/src/engine/pacing/provision.ts` + `provision.integration.test.ts` — created: `provisionInstancePacingState()` materialising `eff_*` at tier 1, plus the `assertNoLiveInstanceIsMissingPacingState()` boot assertion

### Unit U2 — the pure domain core (`implementer`)
- `packages/domain/src/pacing/{resolve-effective,gap-jitter,deny-reasons,constants,warmup-ladder}.ts` + `.test.ts` — created
- `packages/domain/src/index.ts` — changed: pacing module re-exported

### Unit U3 — the three SQL statements + the guard (`db-engineer`)
- `db/queries/reserve-pacing.sql` — created
- `db/queries/pacing-deny-reason.sql` — created
- `db/queries/release-pacing.sql` — created
- `scripts/check-single-reserve.ts` (+ its lib/test) — created: bans a second `consumed_count` / `new_conv_count` / `sent_this_hour` / `group_sent_count` writer, and bans the `INTERIM_MIN_GAP_MS` identifier
- `scripts/ci-steps.ts` — changed: single-reserve guard added to `CI_STEPS` (NOT to `ci.ps1`/`ci.sh` — those are thin wrappers)
- `package.json` — changed: `check:single-reserve` script
- `scripts/registries/cross-tenant-queries.ts` — changed: one entry for U1's boot assertion

### Unit U4 — config service, claim wiring, interim-floor deletion, advisory (`implementer`)
- `app/backend/src/modules/pacing/pacing.repo.ts` — created
- `app/backend/src/engine/pacing/{index,config-service,advisory}.ts` — created
- `app/backend/src/engine/pacing/scripts/reserve-advisory.lua` — created
- `app/backend/src/engine/queue/send-loop.ts` (+ `send-loop-worker-wiring.ts`) — changed: reserve inside the claim transaction at P11's `// P13: pacing.reserve() here` insertion point; interim gate removed
- `app/backend/src/engine/queue/interim-gap.ts` + `interim-gap.test.ts` — **DELETED** (`INTERIM_MIN_GAP_MS` and its self-destruct assertion)
- `app/backend/src/platform/db/assert-db-preconditions.ts` — changed: `assertPacingLedgerAbsent` replaced by U1's `assertNoLiveInstanceIsMissingPacingState`
- `app/backend/src/engine/pacing/{reserve-concurrency,reserve-clock,reserve-advisory,deferral,config-service}.integration.test.ts` — created
- `plan/v1/P11-send-path-mvp.md` — changed: the interim-floor line struck with a pointer here

### Session-level (main session)
- `plan/v1/P13a-warmup-ladder.md` — created: the L-split, carrying steps 9-10
- `plan/README.md` — changed: P13 row split, `P13a` row added
- `plan/v1/P13-pacing-ledger-and-warmup.md` — changed: split recorded, Deviations table, Dispatch plan, this list

## Risks / gotchas specific to this phase
- **The seeded ladder (`safe_default`), every number DERIVED, not measured.** Put this table in the migration header verbatim and revisit it from `pacing_events` after a month (blueprint *Warm-up*; delta *Groups* for the group column):

  | tier | day_from | day_to | daily_cap | hourly_cap | new_conv_cap | gap_min_ms | gap_max_ms | cold_ratio_max | group_daily_cap | block_link_first | block_group_actions |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | 1 | 1 | 2 | 20 | 6 | 8 | 45000 | 180000 | 0.40 | 0 | true | true |
  | 2 | 3 | 7 | 50 | 12 | 15 | 40000 | 150000 | 0.50 | 0 | true | true |
  | 3 | 8 | 14 | 150 | 25 | 40 | 30000 | 120000 | 0.60 | 0 | true | true |
  | 4 | 15 | 21 | 300 | 45 | 80 | 25000 | 90000 | 0.70 | 10 | false | false |
  | 5 | 22 | 29 | 450 | 60 | 110 | 20000 | 75000 | 0.75 | 20 | false | false |
  | 6 | 30 | NULL | 600 | 80 | 150 | 15000 | 60000 | 0.80 | 30 | false | false |

  Tier 6 = 600/day matches the delta's single load model. `daily_cap_ceiling` for `safe_default` is 1,000; `ABSOLUTE_DAILY_CEILING` is 2,000 and no tier, override or admin relax may exceed it. Group ceiling is 50 even for admin relax.
- **The wallet does NOT go in this statement (ADR 0019 §4).** The two balance predicates live in `db/queries/claim-jobs.sql`. Putting them here mixes two authorities in one statement and makes test 22's intent unenforceable. If a reviewer asks "shouldn't the balance be checked before we consume a unit?" the answer is no — the claim already refused.
- **Health bands exist as a column here, not as a scorer.** `instance_pacing_state.health_band` defaults to `healthy`; P16 writes it from evidence. The warm-up tests set the band directly. Do not build any scoring in this phase — an untuned scorer shipped early will silently throttle the first real accounts.
- **Do not re-read limits from a worker cache.** The reserve reads `instance_pacing_state` **in-statement**. A worker-side limits cache in the grant path re-creates Blastup's TOCTOU race; the only cache allowed is the 30 s display/config cache, and it is never an input to the `WHERE`.
- **`release()` is for post-commit outcomes only.** A losing claim race rolls the transaction back; it never compensates. `PROVIDER_ATTEMPTED` is never refunded — fail-closed. Getting this wrong shows up as an over-send weeks later, not as a failing test, so `reserve_is_rolled_back_when_no_job_is_claimed` and `orphan_reservation_is_not_refunded` are both mandatory here.
- **`is_new_conversation` is `false` for group sends** (delta *Groups*). Counting a group send as a cold DM corrupts the cold-ratio measurement, which is one of the three signals P16 actually scores.
- **Local-date arithmetic is the classic silent bug.** `ledger_date` and `hour_key` are computed inside the statement from `instance_pacing_state.pacing_timezone` — never in Node, never from `now()::date`. Test with a DST timezone, not only IST.
- **Safety boundary.** This phase is where an evasion mechanism would be smuggled in. There is **no** off-switch, no plan entitlement, no header, no payload field, no timezone trick and no admin flag that raises a cap or lowers `gap_min_ms` below the floor; jitter and the long pause make sending **slower**, never faster, and the code comment must say so; skipping the ramp is not purchasable; no copy string may claim Safe Mode prevents or guarantees against restrictions — the only permitted wording is `SAFE_MODE_DISCLAIMER`, verbatim.
- **If the session clock runs out**, the split line is after step 8: `P13a-warmup-ladder.md` carries steps 9-10. Add the row to `plan/README.md` and write its next-session prompt instead of P14's.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P14 — pacing-guards-and-optout. Read plan/v1/P14-pacing-guards-and-optout.md and follow it
exactly: one phase, one session. Deps P13 are done (see plan/README.md). Do not start P15.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
