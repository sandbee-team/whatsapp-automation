# P13a — warmup-ladder

**Goal (one line):** The six-tier warm-up ladder advances and rolls back on evidence — time-gated and band-gated, never reply-rate-gated — every change audited, evented, notified and re-materialised through `PacingConfigService`; plus the pacing metric set, the test-22 equality tightening's warm-up half, and the P13 evidence artefact.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Depends on:** P13 (must be `done`)
**Blocks:** P14, P16, P19, P23, P24

**Why this file exists.** P13 is sized L and its own "Size warning" names this split line: steps 1-8 (schema,
reserve/deny/release, claim wiring, Redis advisory pre-filter) stay in P13; steps 9-10 (the evaluator,
advancement/rollback, metrics, evidence) become this file. The split was executed at session open on
2026-09-02 per that instruction. **Nothing here is new scope** — every line below is P13's step 9 or step 10
text, carried across verbatim with its tests.

## Prerequisites (facts, not phases)
- P13 `done`: `pacing_profiles`, `pacing_warmup_tiers`, `instance_pacing_state`, `pacing_ledger`,
  `client_daily_usage`, `pacing_events`, `instance_pacing_overrides` exist and are seeded; the six-tier
  `safe_default` ladder rows are in the database; `resolveEffective()` and `warmup-ladder.ts` exist in
  `@wp/domain`; `PacingConfigService.update()` exists and rewrites `eff_*` in one transaction.
- `instance_pacing_state.health_band` exists as a column with default `healthy`. **P16 writes it from
  evidence — this phase does not build a scorer.** The warm-up tests set the band directly.
- ADRs 0015, 0017, 0018, 0019, 0020 accepted. No design decision is open (skip SESSION-PROTOCOL **O3**).

## What you are building (3-6 bullets)
- `warmup-evaluator.ts`: the six-tier decision function, run from the 5-minute per-instance pacing
  evaluator job (**never** from the send path), with the clock injected.
- Advancement / freeze / rollback per band: advance only in HEALTHY, **frozen** in WATCH, **one-tier
  rollback** in DEGRADED, CRITICAL is P16's pause. A hard restriction signal in the last 24 h blocks
  advancement regardless of elapsed days.
- Every change writes `pacing_events` (`WARMUP_ADVANCE` / `WARMUP_ROLLBACK`) + `audit_logs` + a
  `config_version` bump + a panel notification, and re-materialises `eff_*` through P13's config service.
- `packages/domain/src/copy/pacing-copy.ts` — the warm-up/Safe Mode copy strings, with the
  `SAFE_MODE_DISCLAIMER` co-presence requirement and the `BANNED_CLAIMS` scan (en + hi).
- `app/backend/src/engine/pacing/metrics.ts` — the four pacing metrics, label allow-list respected.
- `docs/evidence/P13-reserve-concurrency.md` — the verbatim 50-parallel-claim run (200 iterations) and the
  p99 `reserve()` latency measured locally.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Safe Mode → Warm-up*; *Signal-driven health* (bands only, for the multipliers this phase reads) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *Groups* (the per-tier group caps and the band effects on them) |
| Safe Mode design | `.memory/research/2026-08-25-v1-design-safe-mode.md` | §2.5 (auditable tiers), §2.6 (reply rate is NOT a gate), §3.2 (band multipliers), §4.3 (audit trail), §5 (copy) |
| ADR | `.memory/decisions/0015-safe-mode-pacing-warmup-and-health.md` | all |
| Phase | `plan/v1/P13-pacing-ledger-and-warmup.md` | the seeded ladder table in *Risks / gotchas*; the files list P13 actually produced |
| Skill | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms · honest claims |
| Invariants | `.claude/rules/core-invariants.md` | all |

## Dispatch plan (SESSION-PROTOCOL E1 — 2 work units, sequential)
- **U1 — the evaluator** (`implementer`, sonnet/high): step 9. Files: `app/backend/src/engine/pacing/warmup-evaluator.ts` + its integration tests, `packages/domain/src/copy/pacing-copy.ts` + `.test.ts`.
- **U2 — metrics, test-22 warm-up half, evidence** (`implementer`, sonnet/high): step 10. Files: `app/backend/src/engine/pacing/metrics.ts` + `.test.ts`, `docs/evidence/P13-reserve-concurrency.md`.
- Not parallel-safe: U2's metrics module is imported by U1's evaluator.

## Ordered minimum steps
- [x] 1. (P13 step 9) The warm-up evaluator → `app/backend/src/engine/pacing/warmup-evaluator.ts`, run from
  the 5-minute per-instance pacing evaluator job (never from the send path), with the clock injected.
  Advance when: elapsed days ≥ `day_from` of the next tier **and** no hard restriction signal in 24 h
  **and** band ≥ WATCH-or-better per the rule (advance only in HEALTHY; **frozen** in WATCH; **one-tier
  rollback** in DEGRADED; CRITICAL is P16's pause). Every change: `pacing_events`
  (`WARMUP_ADVANCE` / `WARMUP_ROLLBACK`) + `audit_logs` + `config_version` bump + a panel notification, and
  re-materialises `eff_*` through P13's config service. Copy strings go in
  `packages/domain/src/copy/pacing-copy.ts` with the `SAFE_MODE_DISCLAIMER` co-presence requirement.
- [x] 2. (P13 step 10) Metrics and the evidence artefact →
  `app/backend/src/engine/pacing/metrics.ts` (`wp_pacing_reserve_seconds` histogram,
  `wp_pacing_deferrals_total{reason}`, `wp_pacing_denies_total{reason}`,
  `wp_warmup_tier_changes_total{direction}` — label allow-list respected, **no** `instance_id` label), and
  file `docs/evidence/P13-reserve-concurrency.md` with the verbatim 50-parallel-claim run (200 iterations)
  and the p99 `reserve()` latency measured locally.
  > **Carried-over blocker, found at P13 open:** `direction` is **not** in `@wp/server-kit`'s
  > `ALLOWED_LABELS` (`packages/server-kit/src/obs/metric-policy.ts`) and adding a label name requires an
  > ADR. Use the already-allowed **`result`** label with values `advance` / `rollback`
  > (the same precedent `wp_reaper_repairs_total{result}` set in P12 for exactly this reason), and record
  > the substitution in the session log. Do NOT widen `ALLOWED_LABELS` in this phase.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/engine/pacing/warmup.integration.test.ts` | `warmup_progresses_on_time_not_on_reply_rate` | injected clock, 0% reply rate, 40 simulated days → reaches tier 6; each step wrote `pacing_events` + `audit_logs` + a notification (**Safe Mode test 8**) |
| `app/backend/src/engine/pacing/warmup.integration.test.ts` | `warmup_freezes_in_watch_and_rolls_back_in_degraded` | WATCH → no advance across the due date; DEGRADED → one tier back, with events (**Safe Mode test 9**) |
| `app/backend/src/engine/pacing/warmup.integration.test.ts` | `a_hard_restriction_signal_in_the_last_24h_blocks_advancement` | due tier does not advance; reason code recorded |
| `app/backend/src/engine/pacing/warmup.integration.test.ts` | `no_path_skips_the_ramp` | property test: no plan, entitlement, override kind or API field sets `warmup_tier` directly except the audited admin path |
| `packages/domain/src/copy/pacing-copy.test.ts` | `pacing_copy_contains_no_banned_claims_and_carries_the_disclaimer` | `BANNED_CLAIMS` scan (en + hi) + `SAFE_MODE_DISCLAIMER` co-presence on every Safe Mode surface |
| `app/backend/src/engine/pacing/metrics.test.ts` | `every_pacing_metric_label_is_on_the_allow_list_and_none_is_instance_scoped` | registration-time policy check over the four metric names |

Mandatory-suite tests this phase makes green: **Safe Mode suite 8, 9**, and the copy half of **29**.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green. — **CI GREEN, all 20 steps**
  (`powershell -File scripts/gate.ps1`, 2026-09-02): unit 193 files/1141 tests, integration **252 files/906
  tests, zero failures** — the first fully green gate since P10 (the fleet flake class was fixed as this
  session's pre-phase U0). First gate attempt failed on a suite-C lease-key grammar gap (not this phase's
  code — see the C5 debugger loop in the files list); fixed, second run green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: **CHANGES-REQUESTED → fix round (all 2 CRITICAL + 4 MAJOR + 4 MINOR
  closed) → re-review of fixes: APPROVED-with-notes**, notes closed in a verified follow-up unit.
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] `docs/evidence/P13-reserve-concurrency.md` exists with the verbatim 50-parallel-claim output (200
  iterations) and the locally measured p50/p95/p99 (61.96/126.26/133.55 ms).
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->

### Pre-phase U0 — flaky-gate-test fixes (`debugger`; master-plan BLOCKER-CLASS, test-only, no production code)
- `app/backend/src/engine/fleet/fleet-c2-slow-redis.integration.test.ts` — changed: in-memory `createSlowFakeRedis` replaces the real-Redis proxy
- `app/backend/src/engine/fleet/__tests__/slow-fake-redis.ts` — created
- `app/backend/src/engine/fleet/fleet-recovery-storm.integration.test.ts` — changed: token-conservation throughput ceiling replaces wall-clock binning
- `app/backend/src/engine/fleet/fleet-connect-bucket-e3-edge.integration.test.ts` — changed: shared helper extracted, no behavior change
- `app/backend/src/engine/fleet/__tests__/fleet-bucket-snapshot.ts` — created (shared `readBucket`/`redisNowMs`)
- `app/backend/src/engine/fleet/__tests__/fleet-recovery-bucket-conservation.ts` — created
- `app/backend/src/engine/lease/lease-state-repo.edge.integration.test.ts` — changed: measured scan ceiling (5000) + non-truncation proof

### Unit U1 — the evaluator + copy (`implementer`, green)
- `app/backend/src/engine/pacing/warmup-decision.ts` — created: pure `decideWarmupAction()` decision table
- `app/backend/src/engine/pacing/warmup-evaluator.ts` — created: `runOnePacingEvaluatorSweep()`, `WarmupMetrics` seam, `PacingEvaluatorPublish` port
- `app/backend/src/engine/pacing/config-service-warmup-write.ts` — created: 300-line-cap split; warmup-tier-guarded UPDATE + `WARMUP_ADVANCE`/`WARMUP_ROLLBACK` event write + shared `updateEffRow`
- `app/backend/src/engine/pacing/warmup.integration.test.ts` — created: tests 8/9 + hard-signal block + `no_path_skips_the_ramp` + once-per-episode rollback + two-tenant isolation
- `app/backend/src/engine/pacing/config-service.ts` — changed: `kind:'warmup_tier'` routed through the guarded write with `expectedFromWarmupTier`/`toWarmupTier`/`reasonCodes`/`evidence`, `WarmupTierRaceLostError`; latent `toEffRow` integer-rounding bug fixed (floor caps, ceil gaps — only ever tightens)
- `app/backend/src/engine/cron/cron-wiring.ts` — changed: `pacingEvaluatorLoop` (5 min), `pacingPublish`/`warmupMetrics`/`env` deps, `NOOP_PACING_PUBLISH` with `// P17 wires this`
- `app/backend/src/engine/cron/single-flight.ts` — changed: `CRON_LOCK_KEYS.pacingEvaluator`
- `app/backend/src/engine/pacing/__tests__/pacing-test-helpers.ts` — changed: `warmupTier`/`warmupStartedAt`/`warmupTierSince`/`healthBand`/`healthState` fixture options
- `packages/domain/src/copy/pacing-copy.ts` + `pacing-copy.test.ts` — created: `PACING_COPY` with the disclaimer literal-duplication idiom
- `packages/domain/src/timing.ts` — changed: `pacingEvaluatorIntervalMs: 300_000`
- `packages/domain/src/index.ts` — changed: `PACING_COPY`/`PacingCopy` exported

### Unit U2 — metrics + evidence (`implementer`, green)
- `app/backend/src/engine/pacing/metrics.ts` + `metrics.test.ts` — created: `bindPacingMetrics()` (WeakMap
  idempotency); `wp_pacing_reserve_seconds` (histogram, no labels), `wp_pacing_deferrals_total{reason}`,
  `wp_pacing_denies_total{reason}` (registered per canon; no production call site yet — a reserve deny is a
  deferral under invariant 5; documented in the header), `wp_warmup_tier_changes_total{result}` (canon's
  `direction` substituted per the carried-over blocker; comment in place)
- `app/backend/src/engine/pacing/index.ts` — changed: `reserve()` timed via `reserveSeconds.startTimer()`
- `app/backend/src/engine/cron/cron-wiring.ts` — changed: `warmupMetrics` defaults to `bindPacingMetrics().warmupMetrics`
- `app/backend/src/engine/queue/send-loop-worker-wiring.ts` — changed: repointed to `bindPacingMetrics().deferralsTotal`
- `app/backend/src/engine/queue/send-loop-pacing-deferral-metrics.ts` — emptied to a documented no-op marker
  (consolidated into `engine/pacing/metrics.ts`; file DELETION was denied by session permissions — a future
  session should remove it)
- `app/backend/src/engine/pacing/reserve-concurrency.integration.test.ts` — changed: non-asserting
  `performance.now()` latency capture + p50/p95/p99 console summary (zero new assertions)
- `docs/evidence/P13-reserve-concurrency.md` — created: verbatim 200-iteration 50-parallel-claim run;
  p50 61.96 ms / p95 126.26 ms / p99 133.55 ms (local dev, contended-by-design measurement)

### E2 debugger loop (one red: `check-tenant-scope` via `cli-smoke.test.ts`)
- `app/backend/src/engine/pacing/warmup-evaluator.ts` — changed: `hasRecentHardSignal` and
  `isDegradedRollbackDue` widened to `(clientId, instanceId)` and `client_id` bound in every
  `pacing_events` query (invariant-4 defense-in-depth; `instance_id` alone happened to isolate)
- `scripts/registries/cross-tenant-queries.ts` — changed: `runOnePacingEvaluatorSweep` enumeration
  registered (fleet-wide bounded cron scan, re-scoped per row downstream — same class as
  `discover-instances`/`reap-expired-leases`)

### C2 edge-case pass (`test-engineer`, test-only)
- `app/backend/src/engine/pacing/warmup-decision.test.ts` — created: 13 pure decision-table cases (boundaries, floors/ceilings, paused/critical precedence, hard-signal vs rollback)
- `app/backend/src/engine/pacing/warmup-edge-concurrency.integration.test.ts` — created: race winner, replay no-op, crash-mid-"transaction" probe (left RED — real bug, fixed in the fix round)
- `app/backend/src/engine/pacing/warmup-edge-clock.integration.test.ts` — created: IST local midnight, São Paulo local-day, future/NULL `warmup_started_at` holds
- `app/backend/src/engine/pacing/warmup-edge.integration.test.ts` — placeholder (content split into the two files above; file deletion denied by session permissions — remove in a future session)

### C1 fix round (`db-engineer`, all 10 findings closed; pacing area 22 files/85 tests green, db 147, test:int 906)
- `db/migrations/0034_warmup_evaluator_definer_functions.sql` — created: role `wp_warmup` (NOLOGIN,
  BYPASSRLS, narrow grants), `wp_warmup_scan_due(p_limit)` (owner `wp_admin_app`, `ORDER BY random()`),
  `wp_warmup_apply_tier_change(...)` (owner `wp_warmup` — the ENTIRE guarded transition atomic in one
  function body); `wp_scheduler` keeps SELECT-only on `instance_pacing_state` (verified live)
- `app/backend/src/engine/pacing/warmup-evaluator.ts` — rewritten: scan via definer fn, reads under
  `tenantDb.withTenant`, per-instance try/catch (race-lost = quiet no-op; other errors logged ids-only and
  counted in the sweep outcome)
- `app/backend/src/engine/pacing/warmup-evaluator-row.ts` — created (300-line split)
- `app/backend/src/engine/pacing/config-service.ts` + `config-service-warmup-write.ts` — changed:
  `applyWarmupTierChangeAtomic` routes through the definer fn; `kind:'health_band'` now actually writes the
  band column AND the `BAND_CHANGE` event (latent bug found while anchoring); `eff_cold_ratio_floor` comment
  corrected
- `app/backend/src/engine/cron/cron-wiring.ts` — changed: threads `tenantDb`
- `app/backend/src/engine/pacing/warmup-episodes-and-guards.integration.test.ts` — created: second-episode
  rollback, paused-hold, critical-neither-advances-nor-rolls-back
- `app/backend/src/engine/pacing/warmup-no-path-skip.integration.test.ts` — created: property half over all
  other `ConfigChangeKind`s (seeded PRNG) + static half walking Zod schema `.shape` keys
- `app/backend/src/engine/pacing/{warmup,warmup-edge-clock,warmup-edge-concurrency}.integration.test.ts`,
  `metrics.test.ts` — changed per findings (atomicity probe green WITHOUT touching its assertions; sweep-abort
  test flipped to assert isolation; metrics test asserts exact per-label counts)
- `db/src/schema-version.ts` — changed: `EXPECTED_SCHEMA_VERSION` 33→34
- `db/schema/grants.snapshot.json` — regenerated; `db/tests/helpers/grants.ts` — `wp_warmup` added to
  `SNAPSHOT_ROLES`
- `scripts/registries/cross-tenant-queries.ts` — entry rewritten to describe the real mechanism

### Re-review follow-up (`db-engineer`, closes the APPROVED-with-notes items)
- `db/tests/wp-warmup-definer.test.ts` — created: EXECUTE-grantee lists pinned for both 0034 functions
  (`wp_warmup_scan_due` → exactly `[wp_admin_app, wp_scheduler]`; `wp_warmup_apply_tier_change` → exactly
  `[wp_scheduler, wp_warmup]`; zero PUBLIC grants)
- `db/tests/wp-warmup-role.test.ts` — created: NOLOGIN + deliberate-BYPASSRLS assertions; exact
  column-scoped grant enumeration; negative checks against wallet/session/auth/message_jobs/send_attempts
- `db/migrations/0035_trim_warmup_scan_due_projection.sql` — created: DROP+CREATE (return-column change),
  7-column projection (only what the sweep reads), owner/search_path/REVOKE/GRANT re-stated explicitly
- `app/backend/src/engine/pacing/warmup-evaluator.ts` — changed: comment names the real emitted reason code
  (`warmup_frozen_degraded`), fictional `no_episode_anchor` reference removed
- `app/backend/src/engine/pacing/warmup-evaluator-row.ts` — changed: `DueInstanceRow` trimmed to 7 fields
- `scripts/registries/cross-tenant-queries.ts` — changed: `projectedColumns` trimmed to match
- `db/src/schema-version.ts` — changed: `EXPECTED_SCHEMA_VERSION` 34→35

### C5 gate debugger loop (first gate run red on a suite-C grammar gap, not this phase's code)
- `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — changed: `LEASE_KEY_GRAMMAR`
  added to `assertAllKeysMatchGrammar` — the lease engine's legitimate `wp:{env}:c:<uuid>:lease:i:<uuid>`
  shape predates suite C and was never modeled; a killed agent's orphaned key surfaced it. Forensics proved
  no dropped cleanup in any file this session touched.

### Session-level (main session)
- `plan/v1/P13a-warmup-ladder.md` — changed: status, step boxes, this list
- `plan/README.md` — changed at C6: P13a row → done

## Risks / gotchas specific to this phase
- **Never reply-rate-gate the ramp** (design §2.6). A transactional sender (OTPs, invoices) will never hit a
  reply-rate threshold and would be trapped at tier 1 forever. Advancement is elapsed days + no hard
  restriction signal + band. Reply rate is a *soft health signal* owned by P16, not a gate here.
- **The evaluator never runs from the send path** (design §2.5 — this is exactly Blastup's bug: a
  fire-and-forget `_maybeAdvanceTier` with a swallowed `.catch(() => {})` inside the send loop). It runs
  from the 5-minute per-instance pacing evaluator job only.
- **`direction` is not an allowed metric label** — see step 2's carried-over blocker box. Use `result`.
- **Skipping the ramp is not purchasable** (safety boundary). `no_path_skips_the_ramp` is a property test,
  not a spot check: no plan, entitlement, override kind or API field may set `warmup_tier` directly except
  the one audited platform-admin path.
- **Do not build a health scorer here.** `health_band` is a column P16 writes. An untuned scorer shipped
  early silently throttles the first real accounts. These tests set the band directly.
- **Copy:** no string may claim Safe Mode prevents or guarantees against restrictions. The only permitted
  wording is `SAFE_MODE_DISCLAIMER`, verbatim, and `scripts/check-copy.ts` already enforces co-presence for
  any file naming the product surface — see `packages/domain/src/copy/onboarding.ts` for the established
  literal-duplication idiom that keeps the plain-substring scan honest.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P14 — pacing-guards-and-optout. Read plan/v1/P14-pacing-guards-and-optout.md and follow it
exactly: one phase, one session. Deps P13 and P13a are done (see plan/README.md). Do not start P15.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
