# P09 — session-fleet-and-drain

**Goal (one line):** a worker fleet that discovers and grabs sessions under admission control, connects them through a fleet-size-scaled budget, sheds or degrades under pressure, drains cleanly on SIGTERM, and reports the minimum saturation metrics every later threshold depends on.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Depends on:** P08 (must be `done`)
**Blocks:** P10, P11, P25, P26, P27

**Size warning:** this phase lands exactly on the 10-step ceiling. If step 8 (guards) is not green by
mid-session, stop after step 8 and split: steps 9-10 (worker wiring + the kill-9 / rolling-restart
integration harness) become `plan/v1/P09a-fleet-integration-harness.md`, and P10 waits on P09a, not P09.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; all migrations applied; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL O2).
- `instance_lease_state` (Postgres-minted fence), `lease.ts` heartbeat + monotonic watchdog and self-fencing exist from P06; every state write already carries a fence predicate.
- `EncryptedAuthStore` + bounded Signal key store exist from P07; `saveCreds` is upsert-safe and flushable.
- The pinned Baileys socket factory, `disconnect-map.ts` and the `link_state`/`health_state`/`desired_state` FSM exist from P08; at least one instance can reach `connected` on a dev box.
- `TIMING` is exported from `@wp/domain` with its ordering unit test (leaseTtl 30 s, heartbeat 10 s, takeoverGrace 15 s, watchdog 15 s, sendTimeout 45 s).
- ADRs 0013, 0015, 0017, **0018** accepted; 0020 (phase/session protocol) in force.
- `CROSS_TENANT_QUERIES` registry and the guard meta-assertion (`guard matched zero files`) exist from P00.

## What you are building (3-6 bullets)
- `deriveSessionCap()` and the worker budget config — `MAX_SESSIONS_PER_WORKER` stops being a constant and becomes arithmetic over a heap budget, with the ceiling 250 and floor 10 (ADR 0018 §3).
- The discovery scan (5 s ± 2 s, `ORDER BY random() LIMIT 50`) **bounded by** `admission.canAcceptLease()`, plus the unowned-instance gauge and the 3-cycle `INFRA_UNAVAILABLE` escalation.
- A fleet-size-scaled connect budget: `clamp(desiredOnline / 300, 8, 40)`/s fleet-wide in Redis, a per-worker 2/s burst-5 bucket, a deterministic per-instance offset, and the `PROVIDER_OUTAGE` freeze to 2/s.
- Shedding that is headroom-gated (at zero headroom the worker **degrades in place**, keeping sockets), and the SIGTERM drain sequence with `logout()` structurally unreachable.
- The minimum worker/fleet metrics (worker sessions, event-loop lag p99, per-session RSS estimate, **box-level** RSS, unowned instances, fleet headroom, connect-bucket wait) under the four-gauge `instance_id` label allow-list.
- Three CI guards: shutdown purity, **placement neutrality**, and the box-level memory assertion.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | § Worker fleet (scan predicate, `[R-37]` unowned visibility, drain sequence); § Reconnection and the disconnect map; § Observability (metric table); § Mandatory send-path and engine suite (tests 11-13) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | § What breaks first — rows **6** (scaled connect bucket), **10** (deploy wave size), **11** (shed/re-grab churn); § Fleet, boxes and box-level memory |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | **§3** derived cap + per-worker `mem_limit`, **§4** scaling rule / headroom gate / PG-unavailable rule, **§6** placement neutrality (CI-guarded) |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | — |
| Design | `.memory/research/2026-08-26-v1r-design-10k-concurrency.md` | §2.1 `deriveSessionCap`, §3.3 reconnection storms, §4.1 SLOs, §4.2 admission + shedding, §4.3 deploys, §8 folder additions |
| Invariants | `.claude/rules/core-invariants.md` | all (1, 2, 4, 5 bite hardest here) |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms; honest claims |
| Path rules | `.claude/rules/queue-*.md`, `.claude/rules/db-*.md` | all |

## Dispatch plan (written at session open 2026-09-01, SESSION-PROTOCOL E1)
- **U1** = steps 1-2 (budget + config keys + metrics + sampler, with unit tests) → implementer
- **U2** = steps 3-4 (admission + connect-budget, with unit tests + the fleet-wide-bucket integration test) → implementer — **parallel with U1**; U2 must NOT touch `platform/config.ts` (all inputs dependency-injected)
- **U3** = step 5 (discovery SQL + gauges SQL + discovery loop + CROSS_TENANT_QUERIES entries, unit + integration tests) → implementer
- **U4** = steps 6-7 (shed + drain, unit + integration tests) → implementer — **parallel with U3** (disjoint files)
- **U5** = step 8 (three guards + guard tests + ci wiring + ALL compose edits incl. step 9's `mem_limit`/`stop_grace_period`) → implementer
- **U6** = step 9 minus compose (session-worker wiring + signal handlers) → implementer — **parallel with U5** (U5 owns compose; U6 owns `roles/session-worker.ts`)
- **U7** = step 10 (synthetic fleet harness + fleet-recovery integration tests, mandatory 12/13) → implementer
Waves: [U1 ∥ U2] → [U3 ∥ U4] → [U5 ∥ U6] → U7. Size-warning checkpoint sits after U5.

## Ordered minimum steps
- [x] 1. `deriveSessionCap()` + worker budget config: `heapBudgetMb − processBaselineMb`, `measuredSessionMb ?? plannedSessionMb`, `× 0.85`, floor 10, ceiling 250; config keys `WORKER_HEAP_BUDGET_MB=3072`, `WORKER_PROCESS_BASELINE_MB=200`, `WORKER_PLANNED_SESSION_MB=35` (the **pessimistic** bracket is the default until P10 measures), `WORKER_SESSION_SAFETY_FACTOR=0.85`; boot assertion that `--max-old-space-size` equals `WORKER_HEAP_BUDGET_MB` → `app/backend/src/engine/fleet/budget.ts`, `app/backend/src/platform/config.ts`
- [x] 2. Worker sampler (5 s) + the minimum fleet metrics with the four-gauge `instance_id` allow-list: `wp_worker_sessions`, `wp_worker_eventloop_lag_p99`, `wp_session_rss_bytes_est` (RSS **slope** per session, not total/N), `wp_box_rss_bytes`, `wp_worker_session_cap`, `wp_connect_bucket_wait_seconds` → `app/backend/src/engine/fleet/metrics.ts`, `app/backend/src/engine/fleet/sampler.ts`
- [x] 3. `AdmissionController` (`accepting|holding|shedding|draining`) over a 3-sample trend, never a single spike: `holding` at `sessions ≥ cap` or `rss > 80%` of budget or `lagP99 > 200 ms`; `shedding` at `rss > 92%` **only while `wp_fleet_capacity_headroom > 0`**, otherwise degrade in place (stop claiming, stop accepting leases, keep sockets open) → `app/backend/src/engine/fleet/admission.ts`
- [x] 4. Connect budget: fleet-wide Redis token bucket `sysKey('tb:connect')` at `clamp(desiredOnline/300, 8, 40)`/s, per-worker in-process bucket 2/s burst 5, deterministic per-instance offset `xxhash32(instanceId) % 60_000`, and the `PROVIDER_OUTAGE` freeze to 2/s on >20% of the fleet disconnecting with 503 inside 5 min → `app/backend/src/engine/fleet/connect-budget.ts`
- [x] 5. Discovery loop: one SQL file with the blueprint's exact predicate (`desired_state='online' AND deleted_at IS NULL AND link_state IN ('linked','pairing') AND health_state <> 'logged_out' AND (lease_seen_at IS NULL OR lease_seen_at < now() - interval '45 seconds') ORDER BY random() LIMIT 50`), 5 s ± 2 s jitter, gated on `canAcceptLease()`, soft yield at 0.9× cap when lag p99 > 200 ms; plus the `wp_instances_unowned` / `wp_fleet_capacity_headroom` gauge query and the 3-consecutive-cycle escalation to `degraded` + `needs_user_action='INFRA_UNAVAILABLE'`; register both queries in `CROSS_TENANT_QUERIES` with role + reason + projected columns → `db/queries/discover-instances.sql`, `db/queries/fleet-gauges.sql`, `app/backend/src/engine/fleet/discovery.ts`, `scripts/cross-tenant-queries.ts`
- [x] 6. Shedding: least-harm victim order (most recently acquired → idle, no in-flight send and no conversation activity in 60 s → smallest queue depth), never an instance with an in-flight send or a pairing in progress; release is `sock.end()` + graceful lease release, never `logout()`; `wp_shed_no_taker_total` when a shed instance is not re-grabbed within two scan cycles → `app/backend/src/engine/fleet/shed.ts`
- [x] 7. Drain (SIGTERM, `stop_grace_period ≥ 45s`): stop grabbing → stop claiming → wait ≤ 20 s for in-flight sends (anything still in flight → `needs_reconcile`, never a blind retry) → flush `saveCreds` → `sock.end()` every session → release every lease → close pools → `exit 0`; deploy wave size `max(1, floor(fleetSessions × 0.02 / sessionsPerWorker))` exported for the runbook → `app/backend/src/engine/fleet/drain.ts`
- [x] 8. Three guards, each with the `guard matched zero files` meta-assertion, wired into `scripts/ci.{ps1,sh}`: **shutdown purity** (the drain/shed module graph cannot reach `unlink()`/`logout()` — mandatory test 11), **placement neutrality** (`discovery.ts` and `shed.ts` may not import any health-scoring, pause, restriction-history or IP-diversity module — ADR 0018 §6), **box memory** (`Σ worker mem_limit + OS reserve ≤ box RAM`, refuses to start otherwise) → `scripts/check-shutdown-purity.ts`, `scripts/check-placement-neutrality.ts`, `scripts/check-box-memory.ts`, `scripts/ci.ps1`, `scripts/ci.sh`, `infra/compose/docker-compose.dev.yml`
- [x] 9. Wire the session-worker role: sampler → admission → discovery → connect budget → lease grab → socket factory; SIGTERM/SIGINT → drain; per-worker `mem_limit` and `stop_grace_period: 45s` in compose → `app/backend/src/roles/session-worker.ts`, `infra/compose/docker-compose.dev.yml`
- [x] 10. Fleet integration harness against the **synthetic** mock-WS sockets from P08 (no bulk real numbers): `kill -9` storm takeover, rolling restart, connect-bucket conformance → `app/backend/test/integration/fleet/fleet-recovery.int.test.ts`, `app/backend/test/support/synthetic-fleet.ts`

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/engine/fleet/budget.test.ts` | `cap_is_135_at_18mb_and_69_at_35mb` | `(3072−200)/18×0.85 → 135`, `/35 → 69`; the numbers are labelled derived-until-P10 |
| `app/backend/src/engine/fleet/budget.test.ts` | `cap_floor_is_ten_and_ceiling_is_250` | absurd inputs clamp both ways |
| `app/backend/src/engine/fleet/budget.test.ts` | `measured_session_mb_wins_over_planned` | `measuredSessionMb` set ⇒ `plannedSessionMb` unused |
| `app/backend/src/engine/fleet/budget.test.ts` | `boot_fails_when_max_old_space_size_disagrees_with_heap_budget` | process refuses to start, named error |
| `app/backend/src/engine/fleet/metrics.test.ts` | `instance_id_label_is_allowed_on_at_most_four_gauges` | registering a fifth `instance_id` gauge throws |
| `app/backend/src/engine/fleet/metrics.test.ts` | `session_rss_estimate_is_a_slope_not_total_over_n` | fixed baseline + ramp ⇒ estimate ≈ slope, not `rss/sessions` |
| `app/backend/src/engine/fleet/admission.test.ts` | `single_lag_spike_does_not_stop_grabbing` | 1 bad sample of 3 ⇒ still `accepting` |
| `app/backend/src/engine/fleet/admission.test.ts` | `holding_at_cap_or_eighty_percent_rss_or_lag` | each of the three triggers alone flips to `holding` |
| `app/backend/src/engine/fleet/admission.test.ts` | `zero_headroom_degrades_in_place_instead_of_shedding` | headroom 0 + rss 95% ⇒ no victims chosen, sockets untouched, capacity alert raised (scope delta row 11) |
| `app/backend/src/engine/fleet/admission.test.ts` | `draining_never_accepts_a_lease` | `canAcceptLease()` false in `draining` |
| `app/backend/src/engine/fleet/connect-budget.test.ts` | `connect_rate_clamps_between_8_and_40` | 1k ⇒ 8/s, 10k ⇒ 33/s, 25k ⇒ 40/s |
| `app/backend/src/engine/fleet/connect-budget.test.ts` | `per_instance_offset_is_deterministic_and_under_60s` | same id ⇒ same offset, always < 60 000 ms, spread is not clustered |
| `app/backend/src/engine/fleet/connect-budget.test.ts` | `provider_outage_freezes_bucket_to_two_per_second` | >20% 503 disconnects in 5 min ⇒ rate 2/s and the banner flag set |
| `app/backend/test/integration/fleet/connect-budget.int.test.ts` | `connect_bucket_is_fleet_wide_not_per_worker` | 3 worker instances share one Redis bucket; total connects/s ≤ rate |
| `app/backend/src/engine/fleet/discovery.test.ts` | `discovery_stops_grabbing_when_admission_is_holding` | zero lease-grab calls while `holding` |
| `app/backend/src/engine/fleet/discovery.test.ts` | `discovery_soft_yields_at_ninety_percent_cap_under_lag` | grab stops at `0.9 × cap` when lag p99 > 200 ms |
| `app/backend/test/integration/fleet/discovery.int.test.ts` | `discovery_never_returns_an_instance_with_a_live_lease` | seeded fresh `lease_seen_at` rows are invisible to the scan |
| `app/backend/test/integration/fleet/discovery.int.test.ts` | `unowned_instance_becomes_degraded_with_infra_unavailable_after_three_cycles` | 3 cycles unowned ⇒ `health_state='degraded'`, `needs_user_action='INFRA_UNAVAILABLE'`, audit row, **zero jobs failed or deleted** |
| `app/backend/test/integration/fleet/discovery.int.test.ts` | `two_tenants_instances_do_not_interfere_in_one_scan` | isolation suite B style: tenant A's rows never appear in tenant B's counters |
| `app/backend/src/engine/fleet/shed.test.ts` | `shed_never_selects_an_inflight_send_or_a_pairing_instance` | both excluded regardless of ordering score |
| `app/backend/src/engine/fleet/shed.test.ts` | `shed_victim_order_is_most_recent_idle_smallest_queue` | deterministic ordering over a fixture set |
| `app/backend/test/integration/fleet/shed.int.test.ts` | `shed_releases_the_lease_gracefully_and_queued_jobs_are_untouched` | instance re-grabbed within one scan cycle; job count/state byte-identical |
| `app/backend/test/integration/fleet/drain.int.test.ts` | `drain_completes_within_45s_and_flushes_creds` | exit 0, creds row updated, every lease released |
| `app/backend/test/integration/fleet/drain.int.test.ts` | `inflight_send_past_twenty_seconds_becomes_needs_reconcile` | job in `needs_reconcile`, **not** requeued, not failed |
| `scripts/__tests__/check-shutdown-purity.test.ts` | `logout_is_unreachable_from_the_shutdown_path` | **mandatory 11** — static module-graph analysis; planting an `unlink()` import turns it red |
| `scripts/__tests__/check-placement-neutrality.test.ts` | `discovery_and_shed_cannot_import_health_or_restriction_history` | planting a `modules/health` import in `discovery.ts` turns it red; a plain `health_state` SQL literal does **not** |
| `scripts/__tests__/check-box-memory.test.ts` | `sum_of_worker_mem_limits_plus_os_reserve_must_fit_box_ram` | 15 × 3.5 GB on a 64 GB box fails with a named error |
| `app/backend/test/integration/fleet/fleet-recovery.int.test.ts` | `kill_dash_9_storm_reconnects_within_bucket_rate` | **mandatory 13** — N synthetic sessions killed; takeover ≤ 45 s; observed connects/s never exceed the bucket |
| `app/backend/test/integration/fleet/fleet-recovery.int.test.ts` | `rolling_deploy_causes_zero_re_QR_and_zero_unresolved` | **mandatory 12** — restart under load: zero QR re-issues, zero unresolved jobs, zero lost jobs |
| `app/backend/test/integration/fleet/fleet-recovery.int.test.ts` | `takeover_does_not_regress_the_fence` | `wp_fence_regression_total = 0` across the storm |

Mandatory-suite tests this phase makes green: **11, 12, 13** (and tests 3-6 from P06 must stay green — re-run them).

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (attempt 3, all 18 steps, 2026-09-01 ~10:48).
- [x] Named tests above exist and pass; no test is skipped or `.only`. (Several named files were split/relocated for the 300-line lint cap — every case name preserved verbatim; map in the file list above.)
- [x] `reviewer` verdict recorded: APPROVED-with-notes after CHANGES-REQUIRED → FIX-P09-A → re-review; notes fixed inline (see verdict trail).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding — answers in the session log.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- CONFIRMED list, appended as dispatches report. The reviewer reviews exactly this list. -->
- `app/backend/src/engine/fleet/budget.ts` — created (U1): deriveSessionCap, assertHeapBudgetMatchesNodeFlags, HeapBudgetMismatchError
- `app/backend/src/engine/fleet/budget.test.ts` — created (U1)
- `app/backend/src/engine/fleet/metrics.ts` — created (U1): bindFleetMetrics, six fleet metrics, no instance_id labels (allow-list enforcement already existed in packages/server-kit/src/obs/metric-policy.ts — untouched)
- `app/backend/src/engine/fleet/metrics.test.ts` — created (U1)
- `app/backend/src/engine/fleet/sampler.ts` — created (U1): createFleetSampler, SessionRssRingBuffer, estimateSessionRssSlopeBytes
- `app/backend/src/platform/config.ts` — changed (U1): WORKER_HEAP_BUDGET_MB / WORKER_PROCESS_BASELINE_MB / WORKER_PLANNED_SESSION_MB / WORKER_SESSION_SAFETY_FACTOR
- `app/backend/src/engine/fleet/types.ts` — created (U2): AdmissionState, WorkerSample, AdmissionController, InstanceId
- `app/backend/src/engine/fleet/admission.ts` — created (U2): createAdmissionController (3-sample trend, headroom-gated shed, degrade-in-place)
- `app/backend/src/engine/fleet/admission.test.ts` — created (U2)
- `app/backend/src/engine/fleet/connect-budget.ts` — created (U2): computeConnectRatePerSec, instanceConnectOffsetMs, createOutageTracker (injected Redis port — real port wired in U6), createFleetTokenBucket, createFleetConnectGate
- `app/backend/src/engine/fleet/connect-budget.test.ts` — created (U2)
- `app/backend/src/engine/fleet/connect-budget.integration.test.ts` — created (U2): fleet-wide bucket on real Redis
- `app/backend/src/engine/fleet/xxhash32.ts` — created (U2): pure-TS xxHash32
- `app/backend/src/engine/fleet/scripts/take-token.lua` — created (U2): atomic token take using Redis TIME
- `app/backend/src/engine/fleet/shed.ts` — created (U4): chooseShedVictims (exclusions + most-recent/idle/smallest-queue comparator), shedVictims via injected ports, no-taker tracking, bindShedMetrics (wp_shed_no_taker_total)
- `app/backend/src/engine/fleet/shed.test.ts` — created (U4)
- `app/backend/src/engine/fleet/shed.integration.test.ts` — created (U4): real lease shed, re-grab promptness, jobs byte-identical
- `app/backend/src/engine/fleet/drain.ts` — created (U4): createDrain (canonical sequence, per-phase withBudget hang protection, injected exit), markNeedsReconcile (status='processing' predicate, idempotent), deployWaveSize
- `app/backend/src/engine/fleet/drain.test.ts` — created (U4): sequencing, hung-port budget, deployWaveSize
- `app/backend/src/engine/fleet/drain.integration.test.ts` — created (U4): 45s completion + creds flush + lease release; needs_reconcile never-requeue
- `db/queries/discover-instances.sql` — created (U3): delegates to existing wp_lease_scan_unowned definer fn (predicate already matched verbatim; no migration)
- `db/queries/fleet-gauges.sql` — created (U3): unowned_count + desired_online_count
- `db/queries/instance-mark-infra-unavailable.sql` — created (U3): client-scoped conditional IS DISTINCT FROM escalation UPDATE
- `app/backend/src/engine/fleet/discovery.ts` — created (U3): scanForDiscovery, readFleetGauges, publishWorkerCap, readFleetCapacityHeadroom, markInfraUnavailableIfChanged, createDiscoveryLoop
- `app/backend/src/engine/fleet/discovery.test.ts` — created (U3)
- `app/backend/src/engine/fleet/discovery.integration.test.ts` — created (U3): live-lease invisibility, 3-cycle escalation under wp_app role, two-tenant isolation
- `app/backend/src/platform/metrics/discovery-metrics.ts` — created (U3): wp_instances_unowned + wp_fleet_capacity_headroom
- `packages/domain/src/copy/infra-unavailable-copy.ts` — created (U3): INFRA_UNAVAILABLE_COPY (en-only, matching PARKED_COPY precedent)
- `packages/domain/src/index.ts` — changed (U3): export line
- `scripts/registries/cross-tenant-queries.ts` — changed (U3): discover-instances + fleet-gauges entries (role wp_scheduler)
- `scripts/check-tenant-scope.ts` — changed (debugger): comment-aware stripComments() before literal-span pairing (false positive on drain.ts; also closed a latent false-negative exposure in two tenancy repos)
- `scripts/guards/check-tenant-scope.test.ts` — changed (debugger): both-direction pinning tests + perf-count update
- `scripts/guards/__fixtures__/tenant-scope/queries.ts` — changed (debugger): apostrophe-comment fixture symbols
- `scripts/guards/module-graph.ts` — created (U5): shared pure import-graph walker for both graph guards
- `scripts/check-shutdown-purity.ts` — created (U5): drain/shed module graph cannot reach logout()/unlink()/baileys (mandatory 11)
- `scripts/guards/check-shutdown-purity.test.ts` — created (U5)
- `scripts/check-placement-neutrality.ts` — created (U5): import-graph guard, BANNED_PLACEMENT_PATH_PREFIXES (ADR 0018 §6); health_state SQL literal explicitly legal
- `scripts/guards/check-placement-neutrality.test.ts` — created (U5)
- `scripts/check-box-memory.ts` — created (U5): strict scope-delta box budget ((RAM−OS−baselines)×0.68+baselines), named error, hand-rolled compose scanner
- `scripts/guards/check-box-memory.test.ts` — created (U5)
- `scripts/guards/registry.ts` — changed (U5): three new guards, activatesIn P09 (22 registered)
- `package.json` — changed (U5): three check:* script entries
- `scripts/ci-steps.ts` — changed (U5): three new steps (ci.ps1/ci.sh are thin wrappers — correctly NOT edited, phase file's expectation corrected)
- `infra/compose/docker-compose.dev.yml` — changed (U5): session-worker service, profiles [worker], mem_limit 3584m, stop_grace_period 45s
- `scripts/guards/single-claim-lib.ts` — changed (debugger 2): SET-clause-bounded patterns (`(?:(?!\bWHERE\b)[^;])*?`) so WHERE predicates on status='processing' no longer false-positive; false-negative impossibility argued from SQL grammar
- `scripts/guards/check-single-claim.test.ts` — created (debugger 2): 17 cases, both directions incl. sneaky shapes
- `scripts/guards/__fixtures__/single-claim/*` — created (debugger 2): 4 fixtures
- `app/backend/src/engine/session/expected-takeover-check.ts` — created (U6): real [R-13w] predicate over instance_lease_state (tenant-scoped SELECT; closes the P08 handoff)
- `app/backend/src/engine/session/expected-takeover-check.test.ts` — created (U6): 13 unit tests
- `app/backend/src/engine/session/expected-takeover-check.integration.test.ts` — created (U6): expected_takeover_suppresses_the_pause + unexpected_440_still_pauses
- `app/backend/src/engine/fleet/fleet-wiring.ts` — created (U6): bootWorkerBudget, createRedisOutagePort (INCR/EXPIRE + MGET + SET EX + EXISTS), fleet ConnectGate composition, sampler/admission/shed wiring, discovery passthrough
- `app/backend/src/engine/fleet/fleet-wiring.test.ts` — created (U6): 8 tests
- `app/backend/src/engine/session/fleet-adapters.ts` — created (U6): SessionInventory/ShedPorts/DrainSession/InFlightPort adapters (inFlightSendCount/lastConversationActivity/queueDepth stubbed pending P11/P21; acquiredAt + pairingInProgress real)
- `app/backend/src/engine/session/fleet-adapters.test.ts` — created (U6): 6 tests
- `app/backend/src/engine/session/session-worker-discovery.integration.test.ts` — created (U6): migrated 1:1 from session-worker-scan.integration.test.ts (old file inert as .deleted; registry.has/handle-identity assertions per widened discovery scope)
- `app/backend/src/engine/session/session-worker-runner-factory.ts` — changed (U6): real expectedTakeoverCheck wired, tenantDb param
- `app/backend/src/engine/session/session-worker-composition.ts` — changed (U6): fleet wiring, bootstrapScan retired, runOneDiscoveryCycle/beginDrain/timing/maxScanRows seams
- `app/backend/src/engine/session/registry.ts` — changed (U6): RunnerHandle.inventorySnapshot()
- `app/backend/src/engine/session/runner.ts` — changed (U6): populates inventorySnapshot
- `app/backend/src/roles/session-worker.ts` — changed (U6): rewrite — bootWorkerBudget, discovery-driven scan timer, SIGTERM/SIGINT → createDrain (registered once)
- `app/backend/src/engine/session/session-worker-two-workers.c2.integration.test.ts` — changed (U6): tenantDb arg
- `app/backend/src/engine/session/session-worker-composition.fence-liveness.integration.test.ts` — changed (U6): scan shim removed, robustness fixes
- `app/backend/src/engine/session/session-worker-scan.edge.integration.test.ts` — changed (U6): scan shim removed, robustness fixes
- `scripts/registries/cross-tenant-queries.ts` — changed (U6): bootstrapScan entry retired
- `app/backend/src/engine/session/connect-gate.ts` — changed (U6b): named export DEFAULT_PER_WORKER_BURST = 5
- `app/backend/src/engine/session/connect-offset-wave.ts` — created (U6b): createWaveConnectTracker, CONNECT_OFFSET_WAVE_THRESHOLD
- `app/backend/src/engine/session/connect-offset-wave.test.ts` — created (U6b)
- `app/backend/src/engine/session/runner-types.ts` — changed (U6b): StartInput.waveConnect, pendingOffsetTimer state
- `app/backend/src/engine/session/runner.ts` — changed (U6b): cancellable fire-and-forget offset wait before first socket open (linked + wave only; pairing never delayed; ordering deviation documented)
- `app/backend/src/engine/session/runner-connect-offset.test.ts` — created (U6b): 4 named tests
- `app/backend/src/engine/session/session-worker-composition.ts` — changed (U6b): waveConnectTracker per discovery cycle, waveConnect threaded through grab; (U7): bindLeaseMetrics wired into the composed LeaseManager (production counters were silently dead), SessionWorker.stopHeartbeatOnly() kill9 port
- `app/backend/src/engine/session/synthetic-fleet-support.ts` — created (U7): synthetic worker handles (kill9/drain/scan), counting socket factory, bounded-offset id minting
- `app/backend/src/engine/fleet/fleet-recovery.integration.test.ts` — created (U7, fixed debugger 3): all three tests green — mandatory 12, mandatory 13 (takeover ≤45s real timers, honest 1-worker takeover), fence non-regression
- `app/backend/src/engine/lease/lease-manager.ts` — changed (debugger 3): acquire() returns graceMs as data instead of awaiting it inline (the inline await serialized the whole discovery grab loop)
- `app/backend/src/engine/lease/lease-manager.types.ts` — changed (debugger 3): SessionLease.graceMs
- `app/backend/src/engine/session/runner-types.ts` — changed (debugger 3): SessionLeaseLike.graceMs
- `app/backend/src/engine/session/runner.ts` — changed (debugger 3): connect-gate take moved off start()'s inline path; gate → grace → offset → socket-open as ONE deferred cancellable chain; start() returns once the lease is acquired/registered
- `app/backend/src/engine/fleet/discovery.ts` — changed (debugger 3): DISCOVERY_STALE_MS 45s → 30s (**recorded deviation from the phase-pinned SQL predicate**: 45s staleness consumed the entire ≤45s takeover SLA before any grab could run — canon was internally inconsistent; mutual exclusion is unchanged (Redis TTL + fence + grace-before-socket-open); the wp_instances_unowned gauge/alert stays at canon 45s → ADR note at C6)
- `app/backend/src/engine/session/runner-lease-grace-offset.test.ts` — created (debugger 3): 4 pinning tests (no serialization; socket never opens before grace on non-graceful takeover; grace-then-offset composition; teardown cancels)
- `app/backend/src/engine/lease/lease-manager{.test,.edge.test,.c2.test}.ts`, `lease-fence.concurrency.integration.test.ts`, `lease-release.integration.test.ts` — changed (debugger 3): grace assertions re-anchored to SessionLease.graceMs (same properties)
- `app/backend/src/engine/session/runner-test-{fixtures,support}.ts`, `runner-connect-offset.test.ts`, `runner-disconnect.edge.integration.test.ts`, `session-worker-composition.fence-liveness.integration.test.ts`, `session-worker-two-workers.c2.integration.test.ts`, `runner-heartbeat.integration.test.ts`, `app/backend/src/engine/lease/heartbeat-fence-loss-mid-pairing.c2.integration.test.ts` — changed (debugger 3): bounded polls / deferred-open accommodations, no assertion relaxed
- `diag.log` (repo root) — deleted (debugger 3): stale pre-session stray blocking check-tree
- `app/backend/src/engine/fleet/fleet-unit-e3-edge.test.ts` — created (E3): 20 boundary/trend/escalation/drain edge tests
- `app/backend/src/engine/fleet/fleet-integration-e3-edge.integration.test.ts` — created (E3): 4 real-infra concurrency edges (one-token bucket race, 20% outage boundary, racing escalation loops → exactly one audit row, no double ownership)
- `app/backend/src/engine/fleet/fleet-c2-unit.test.ts` — created (C2): 8 probe cases incl. the zombie-registry pin (now positive-named)
- `app/backend/src/engine/fleet/fleet-c2.integration.test.ts` — created (C2): 4 real-infra probe cases incl. the end-to-end zombie-registry pin
- `app/backend/src/engine/session/fleet-adapters.test.ts` — created (FIX-P09-A): CRITICAL-1 + C2 adapter pins (8 tests)
- `app/backend/src/engine/session/runner-connect-gate-abort.test.ts` — created (FIX-P09-A): teardown/drain aborts parked takers
- `app/backend/src/engine/session/publish-worker-cap-wiring.integration.test.ts` — created (FIX-P09-A): two-worker positive headroom + gauge
- `app/backend/src/engine/session/connect-gate.ts` — changed (FIX-P09-A): ConnectGateTakeOptions {signal} (backward-compatible)
- `app/backend/src/engine/session/runner-disconnect.ts` — changed (FIX-P09-A): reconnect take() under its own abort controller
- `app/backend/src/engine/fleet/fleet-wiring.ts` — changed (FIX-P09-A): isOwnershipFresh threaded through buildDiscoveryLoop

<!-- Expected-set fully reconciled. Path corrections vs the planning guesses: harness support landed as `app/backend/src/engine/session/synthetic-fleet-support.ts`; all integration tests are colocated `src/**/*.integration.test.ts` (repo convention, not test/integration/); guard tests live in `scripts/guards/*.test.ts` (not scripts/__tests__/); ci.ps1/ci.sh unchanged by design (thin wrappers over ci-steps.ts). -->

## Risks / gotchas specific to this phase
- **The placement-neutrality guard will fight the scan predicate.** The blueprint's discovery SQL legitimately filters `health_state <> 'logged_out'` — that is link liveness, not placement by health history. Write the guard against the **module graph** (no import of `modules/health`, restriction/pause history, or anything IP-related), not against the string `health_state`, and pin both directions with the two test cases named above. A guard that bans the SQL literal will be deleted by the next session; a guard that bans nothing is not a guard.
- **Do not build `candidate-queue.ts`.** The scheduler-published candidate queue replaces the SQL scan only above the ADR 0018 §4 threshold. `ORDER BY random() LIMIT 50` is a seq scan and that is accepted at v1 size. Note it in the session log; do not optimise it now.
- **Do not shrink `TIMING` to make an integration test fast.** Takeover ≤ 45 s is `leaseTtl 30 s + takeoverGrace 15 s`; the test gets a 60 s budget and real timers. Injecting a fake clock into the lease path invalidates exactly the property being proven.
- **Real numbers are not the tool here.** Tests 12 and 13 run on synthetic mock-WS sockets (P08 harness). Bulk-registering real numbers to test a fleet is both a ban risk on the founder's own numbers and out of scope — measurement of real per-session cost is P10 (Gate A).
- **Quote nothing.** 135 / 69 / 18 MB / 35 MB are *derived* bracket figures. They may appear in code as defaults and in the session log labelled derived; they may not appear in any panel string, doc or customer-facing text before Gate A (P10) and Gate B (P26). ADR 0018 §8.
- **`sock.end()` never `logout()` — in shed as well as drain.** Shedding a lease so another worker re-grabs it is capacity movement; `logout()` would unlink the tenant's phone and force a re-QR. The static guard covers both modules; keep `shed.ts` inside the guard's glob.
- **Zero headroom is the dangerous state.** Without the headroom gate a full fleet sheds and re-grabs the same sessions forever (scope delta row 11). Degrade in place: stop claiming, keep sockets, inbound keeps working, jobs stay queued, raise the alert. A degraded worker must never fail or delete a job (invariant 5).
- **A Postgres hiccup must not drop sockets.** Only a fence conflict self-fences (ADR 0018 §4). If discovery's query throws, the loop backs off and retries; it does not release leases and it does not end sockets.
- **Box RSS is not the sum of worker RSS you trust.** Read the host gauge; 15 workers each "healthy" under their own `mem_limit` can still OOM the box, which is why `check-box-memory.ts` refuses to start rather than warn.
- **Honest copy for `INFRA_UNAVAILABLE`:** state what is true — our system could not keep this number connected right now, queued messages are safe and will send when it reconnects. Do not blame WhatsApp, do not promise a time, no banned claims; the string goes through `check-copy.ts`.

## C1 verdict trail (session 2026-09-01)
- First pass: **CHANGES-REQUIRED** — 3 CRITICAL (drain does not cancel the deferred open chain → post-release socket rebuild possible; publishWorkerCap never called in production → headroom always ≤0, shedding unreachable; fleet gate take() retries unbounded/uncancellable), 5 WARNING (shed endSocket throw skips lease release; escalation streak counts lost grab races → healthy contended instance can be flagged INFRA_UNAVAILABLE; markNeedsReconcile lacks instance_id predicate; unbounded HDEL prune; discover-instances.sql header contradicts the 30s stale window), 3 SUGGESTION (distinct degrade-in-place reason; per-cycle capacity source; minute-stamped outage bucket keys). Confirmed clean: invariant 5 job safety, shutdown purity, grace honored before first open, Lua bucket atomicity, label hygiene, honest copy, tenant isolation, no evasion, fence/generation guards.

- C2 all-cases probe: 15 cases — 12 PASS (incl. crash-window idempotency, slow-not-down Redis at 1.9s/2s, cap replay/corrupt-field pruning, cross-tenant escalation isolation, streak-map boundedness), 2 documented metric-only limitations (no-taker counter across restart), 1 REAL BUG pinned red at unit + real-infra level: shed leaves a zombie registry entry (endSocket without registry.delete → the shedding worker can never re-grab; grab short-circuits on registry.has). Routed into FIX-P09-A with C1's findings.
- FIX-P09-A dispatched: C1 CRITICAL 1-3 + WARNING 4-8 + SUGGESTION 9/11 + C2 zombie-registry bug; orchestrator deviation on CRITICAL 3 recorded (abortable take + per-attempt deadline + in-chain retry, NO lease release on expiry — lease churn under a freeze defeats the freeze).
- FIX-P09-A landed: all 12 items green with pinning tests (202 tests engine areas, fleet-recovery 3/3, typecheck + 22 guards green). Notable new/changed: fleet-adapters teardownNoRelease on drain AND shed (+registry.delete); ConnectGateTakeOptions.signal + per-session AbortController aborted in teardown (runner.ts, runner-disconnect.ts); publishWorkerCap per cycle (+publish-worker-cap-wiring.integration.test.ts); isOwnershipFresh escalation gate (tenant-scoped inline SQL, no registry entry needed); markNeedsReconcile instance_id predicate; chunked HDEL; absolute-minute outage buckets; distinct degrade reason; ShedResult endOk/releaseOk; discover-instances.sql header corrected; runner-connect-gate-abort.test.ts + fleet-adapters.test.ts created. Suggestion 10 skipped (not a one-liner) — carried as an open note. WATCH: fleet-integration-e3-edge last-token race test flaked once (pre-existing nondeterminism, passed all other runs).

- Re-review (fixes only): **APPROVED-with-notes** — all 8 fix groups sound; CRITICAL-3 no-release-on-expiry decision explicitly endorsed. Notes fixed inline by the main session: (1) try/finally registry.delete in the shed adapter (a throwing socket end must not recreate the zombie entry now that the release leg still runs); (2) catch around the deferred buildAndWireSocket (fail-safe log-only, ids only). Verified: 4 affected test files 18/18 green, typecheck clean.
- `app/backend/src/engine/session/fleet-adapters.ts` — changed (note-fix, main session)
- `app/backend/src/engine/session/runner.ts` — changed (note-fix, main session)
- FIX-P09-B (lint conformance, zero behavior change; post-re-review code motion verified by identical test populations + guard runs):
  - splits: discovery.ts → +discovery-caps.ts/-escalation.ts/-types.ts; fleet-wiring.ts → +fleet-wiring-connect-gate.ts; runner.ts → +runner-deferred-open.ts/+runner-connection-update.ts; session-worker-composition.ts → +session-worker-discovery-wiring.ts/+session-worker-sweep.ts; scripts/guards/single-claim-lib.ts → +single-claim-spans.ts; scripts/check-tenant-scope.ts → +scripts/guards/tenant-scope-spans.ts; six oversized test files split by topic (case names preserved verbatim; fleet-recovery → -storm + -rolling-restart; fleet-c2/e3-edge/connect-budget/discovery/drain integration + heartbeat.c2 likewise); shared test seeds relocated to engine/fleet/__tests__/ (guard exemption convention)
  - non-split: drain.ts UPDATE layout (no-plain-set trip), connect-offset describe wording (no-offset-pagination trip), sysKey in two tests (key-construction), unused-var/prefer-const nits

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P10 — measure-session-cost. Read plan/v1/P10-measure-session-cost.md and follow it exactly:
one phase, one session. Deps P09 are done (see plan/README.md). Do not start P11.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
