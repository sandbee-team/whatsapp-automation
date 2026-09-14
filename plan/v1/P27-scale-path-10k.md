# P27 — scale-path-10k

**Goal (one line):** the five levers that make 10,000 connected sessions a purchasing decision instead of a rewrite exist and are proven — session-worker/send-worker split behind the existing lease, Sentinel-backed `redis-ctl` in a hard three-way Redis split, a Postgres read replica carrying panel reads, a multi-host no-git deploy, and a costed, measured path from the number P26 proved to 10,000.
**Status:** todo · **Size:** L · **Session:** 1 of 1 (see the split line)
**Depends on:** P26 (must be `done`)
**Blocks:** nothing in the phase list (P28 depends on P25) — but **Gate C** and every capacity/price claim depend on this phase and P26.

**Size warning:** this is the largest remaining v1 phase and `plan/README.md` already anticipates a split per lever. **Split line:** if the Redis failover drill (step 5) is not green by mid-session, stop after step 5 and split — **P27 keeps steps 1-5** (headroom math, dispatch seam, `ROLE=send-worker`, Redis split + Sentinel, failover drill) and **`plan/v1/P27a-replica-hosts-and-scale-path.md` takes steps 6-10** (read replica, read routing, multi-host deploy, the two-host run, the published scale path). The demonstrable outcome ("10× the measured per-box count across N workers and ≥2 hosts, panel unchanged") and the Gate-C statement then land in **P27a**. Record the split in `plan/README.md` at C6 and write P27a's file before closing.

**What this phase does NOT deliver:** 10,000 live sessions. At the derived bracket that is 180-350 GB of session RAM and 5-10 app boxes — a funding decision (`plan/README.md`, closing note). This phase delivers the architecture, the guards and the measured extrapolation.

## Prerequisites (facts, not phases)
- P26 is `done` and **Gate B is closed**: `docs/capacity/` holds the measured per-box session count, the measured load model (sends/day, statements/send, durable bytes/send) and the 1,000-instance chaos + drift evidence.
- P09-P10 artefacts exist and are green: `engine/fleet/{budget,admission,discovery,shed,drain,connect-budget,wake,metrics,sampler}.ts`, `deriveSessionCap()`, `deployWaveSize()`, `scripts/check-box-memory.ts`, `scripts/check-placement-neutrality.ts`, `app/backend/test/support/{mock-wa-peer,synthetic-fleet}.ts`.
- The Redis three-way split **already exists logically** (P07: `redisSig` / `redisCache` handles, `redis-sig` on `noeviction`). This phase adds HA on `redis-ctl` and makes the split *enforced*, not conventional.
- ADRs 0009, 0013, 0015, 0016, 0017, **0018**, 0019 accepted; 0020 (phase/session protocol) in force. `.claude/rules/core-invariants.md` unchanged.
- **≥ 2 Linux hosts** (or 2 VMs) reachable over a private network, cgroup v2, with SSH and Docker. Figures from the Windows dev box are not publishable (same rule as P10).
- **Founder open item 7 (Redis HA spend) must be answered before step 4 provisions anything.** If it is unanswered: build the Sentinel-aware client, the compose topology and the drill in dev, do **not** provision production hardware, and carry the spend decision into the session log as an open item. Do not quietly skip Sentinel — it is the difference between "a Redis loss pauses the fleet" and "a Redis loss pauses the fleet and nobody notices for 15 minutes".
- **Founder open item 8 (deploy impact tolerance)** is informational here: the runbook states ~55-60 min at 10k with ≤2% down at any instant. If the founder needs zero-impact deploys, that is a connection-plane split and is v2+ — write it down, do not attempt it.
- **O3 applies to step 2.** The dispatch seam touches the message lifecycle. No accepted ADR covers the transport, so step 2 opens with `/decide` → `.memory/decisions/0021-send-dispatch-seam.md` recording: transport choice, the fence check, the attempt-id single-flight, and the explicit statement that a lost dispatch is an existing `needs_reconcile`, never a re-send.

## What you are building (3-6 bullets)
- **Fleet headroom as arithmetic, not vibes**: `fleetHeadroom()` / `boxesRequired()` in `@wp/domain`, feeding `wp_fleet_capacity_headroom` (already the gate for shedding, scope delta row 11) and the N+1-box policy from design §3.10.
- **A `SendTransport` seam** so the process that *holds the socket* and the process that *drains the queue* can be different: fence-checked, attempt-id-idempotent remote dispatch, default-off, byte-identical behaviour when off.
- **`ROLE=send-worker`** (claim → guards → reserve → wallet → render → dispatch) and a sessions-only `session-worker`, with a module-graph guard that the send-worker can never reach Baileys — that guard is what keeps the deploy cadences genuinely separate (design §4.3).
- **Redis split enforced + HA**: a prefix→client binding with a CI guard, `redis-ctl` behind Sentinel with a replica, batched-renew Lua pinned to one `redis-ctl` slot, and a failover drill that proves fail-safe behaviour on both sides of the lease TTL.
- **A Postgres read replica** with a read-only reporting pool, RLS enforced on the replica, a lag gauge, read-your-writes stickiness, primary fallback, and a guard that no send-path module can import it.
- **Multi-host deploy without git** (ADR 0009 §deployment, steps 1-8) plus the two-host run and the published, costed `docs/capacity/scale-path-10k.md` — the artefact that turns "reach 10k" into a purchase order.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | **§ What breaks first — all 12 rows and their thresholds** (this phase closes 3, 10, 11 and re-verifies 1, 2, 4, 5, 6, 7, 8, 12); § Fleet, boxes and box-level memory; **§ Cost at 2k/5k/10k/25k — both bracket tables**; § The one load model; § WAL and backups |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | **§3** derived cap + box `mem_limit` assertion · **§4** the no-singleton-O(active)-under-5-min rule and its thresholds · **§5** `redis-sig` is `noeviction`, only rebuildable caches are LRU · **§6** placement neutrality, no proxies, stable egress IP · **§7** the one load model, tiered RTO, derived deploy wave size |
| ADR | `.memory/decisions/0009-infrastructure-topology-and-no-git-deployment.md` | whole — Tier B/C shapes and **the 9 numbered deployment steps** (build → save/registry → migrate-before-rollout → rolling → SOPS → tag rollback → contracts checksum → self-hosted CI) |
| ADR | `.memory/decisions/0016-v1-v2-scope-split.md` | the no-quoting gate |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | **§ Roadmap past 5,000** (the lever order — this phase does levers 2, 3, 4 and refuses 5) · § The honest capacity table · § Failure behaviour matrix (rows: Redis down, Redis flushed, Postgres down, worker dies) |
| Design | `.memory/research/2026-08-26-v1r-design-10k-concurrency.md` | §2.5 data-tier shapes · §3.2 lease/Redis split · §3.9 backup/RTO · §3.10 blast radius + N+1 · §4.1 SLOs · §4.2 admission/shedding · §4.3 deploys · §4.4 backpressure · §4.5 graceful degradation · §8 folder layout |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | honest claims; **no proxies, no rotation, no IP diversity** |
| Path rules | `.claude/rules/db-*.md`, `.claude/rules/queue-*.md`, `.claude/rules/api-*.md` | all |

## Ordered minimum steps
- [ ] 1. **Headroom and fleet-plan math in `@wp/domain`, tests first** (pure, no I/O): `fleetHeadroom({boxes, sessionsPerBox, desiredOnline})` returning `{headroomSessions, headroomRatio, nPlusOneSatisfied, deficitReason?}` (never negative — a deficit is a named reason), `boxesRequired(connected, perSessionMb, boxRamGb, osReserveGb)` returning **both** bracket answers, and `costEnvelope()` used only by the published doc. Wire the value into the existing `wp_fleet_capacity_headroom` gauge and the fleet-gauge query. → `packages/domain/src/capacity/fleet-headroom.ts`, `packages/domain/src/capacity/fleet-plan.ts` (+ `.test.ts`), `app/backend/src/engine/fleet/metrics.ts` (changed), `db/queries/fleet-gauges.sql` (changed)
- [ ] 2. **`/decide` ADR 0021, then the `SendTransport` seam.** Port + two implementations: `inprocess` (today's behaviour, default) and `remote` (HTTP POST on the private network to the lease owner's dispatch port). The remote path carries `(client_id, instance_id, fence, attempt_id, payload)`; the owner **refuses on fence mismatch** (no send, `wp_dispatch_fence_reject_total`), keeps an in-process single-flight map on `attempt_id` so a retried request transmits once, and returns the provider result. A transport timeout leaves the attempt `dispatched` → the existing P12 `needs_reconcile` path; there is **no blind re-send**. → `.memory/decisions/0021-send-dispatch-seam.md`, `app/backend/src/engine/send/transport.ts`, `app/backend/src/engine/send/transport-inprocess.ts`, `app/backend/src/engine/send/transport-remote.ts`, `app/backend/src/engine/send/dispatch-server.ts`, `app/backend/src/platform/config.ts` (changed: `SEND_TRANSPORT`, `DISPATCH_PORT`, `DISPATCH_TIMEOUT_MS`)
- [ ] 3. **`ROLE=send-worker` + sessions-only `session-worker`.** `send-worker` runs claim → guards → pacing reserve → wallet debit → render → `SendTransport`; `session-worker` gains `WORKER_CLAIMS_ENABLED=false` mode (holds sockets, serves dispatch, renews leases, handles inbound). Dependency-cruiser rule: `roles/send-worker.ts` must not reach `provider/**` or `engine/fleet/**`; `engine/send/transport-remote.ts` must not import Baileys. Both services in dev + prod compose with their own `mem_limit`. → `app/backend/src/roles/send-worker.ts`, `app/backend/src/roles/session-worker.ts` (changed), `packages/config/dependency-cruiser.cjs` (changed), `scripts/check-role-boundaries.ts` (+ `scripts/__tests__/check-role-boundaries.test.ts`), `scripts/ci.ps1`, `scripts/ci.sh`, `infra/compose/docker-compose.dev.yml`, `infra/compose/docker-compose.prod.yml`
- [ ] 4. **Enforce the Redis three-way split and put `redis-ctl` behind Sentinel.** A prefix→client binding table (`wp:ctl:*`→`redisCtl`, `wp:sig:*`→`redisSig`, `wp:cache:*`→`redisCache`) that throws at runtime on a cross-client key; Sentinel-aware `redisCtl` (master name, 3 sentinels, reconnect-on-`+switch-master`, dedicated heartbeat connection with a 2 s timeout per design §4.5); batched-renew Lua keys pinned to one `redis-ctl` slot with an assertion; `redis-sig` stays `noeviction`, `redis-cache` stays `allkeys-lru` (ADR 0018 §5). CI guard for the binding with the zero-files meta-assertion. → `app/backend/src/platform/redis.ts` (changed), `app/backend/src/platform/redis-keyspace.ts` (+ `.test.ts`), `scripts/check-redis-keyspace.ts` (+ `scripts/__tests__/check-redis-keyspace.test.ts`), `infra/compose/docker-compose.dev.yml` (`redis-ctl-replica`, `redis-sentinel-1..3`), `infra/compose/docker-compose.prod.yml`
- [ ] 5. **Redis failover drill under load** (integration, synthetic fleet): kill the `redis-ctl` master mid-run and assert (a) Sentinel promotes, batched renew resumes, `wp_fence_regression_total = 0`; (b) if the gap exceeds the lease TTL, the watchdog self-fences fail-safe — sends stop, jobs untouched, sockets closed, banner raised — and recovery needs no human; (c) `redis-sig` and `redis-cache` are unaffected by a `redis-ctl` failover. Runbook section written in the same step. → `app/backend/test/integration/fleet/redis-failover.int.test.ts`, `docs/RUNBOOK.md` (changed: "redis-ctl failover", "what a Redis loss looks like in the panel")
- [ ] 6. **Postgres read replica + reporting pool.** Streaming replica in compose (`hot_standby=on`, `hot_standby_feedback=on`), a `wp_reporting` role (SELECT-only, no send-path table writes, `statement_timeout`), a reader pool with `default_transaction_read_only=on`, `SET LOCAL app.client_id` + **RLS FORCE verified on the replica**, `wp_replica_lag_seconds` gauge, and bounded fallback to primary when the replica is down or lag exceeds `REPLICA_MAX_LAG_MS`. → `db/migrations/<next>_reporting_role.sql`, `db/grants-snapshot.sql` (changed), `app/backend/src/platform/db/reader.ts` (+ `.test.ts`), `app/backend/src/platform/config.ts` (changed), `infra/compose/docker-compose.dev.yml` (`postgres-replica`)
- [ ] 7. **Route panel reads to the reader, explicitly.** A `READ_REPLICA_QUERIES` registry (same shape as `CROSS_TENANT_QUERIES`: query id, module, reason, staleness tolerance) listing the conversation list, instance card, queue-status rollups, broadcast progress and wallet history reads; read-your-writes stickiness (`REPLICA_STICKY_MS` after any mutation for that client, carried in the tenant context); a guard that no send-path module (`claim`, `reserve`, wallet debit, lease, outbox relay, engine/**) imports the reader; a two-tenant isolation test **on the replica**. → `app/backend/src/platform/db/read-replica-queries.ts`, `app/backend/src/platform/db/read-routing.ts` (+ `.test.ts`), `scripts/check-reader-usage.ts` (+ `scripts/__tests__/check-reader-usage.test.ts`), `app/backend/test/integration/db/reader-isolation.int.test.ts`, the registered module read paths (changed)
- [ ] 8. **Multi-host deploy scripts, no git anywhere** (ADR 0009 steps 1-8): `ops/hosts.json` (host id, role mix, RAM, worker count, one stable egress IP recorded as *addressing*), image build + ship via self-hosted registry, **migrate before rollout**, health-gated rolling `rollout` whose wave size comes from `deployWaveSize()` and never exceeds 2% of fleet sessions at any instant, rollback to the previous tag, per-host box-memory assertion. → `ops/hosts.json`, `ops/deploy/build-image.ps1`, `ops/deploy/ship-image.ps1`, `ops/deploy/migrate.ps1`, `ops/deploy/rollout.ps1`, `ops/deploy/rollback.ps1`, `ops/deploy/wave.ts` (+ `ops/deploy/__tests__/rollout.test.ts`), `scripts/check-box-memory.ts` (changed: iterate `ops/hosts.json`), `infra/compose/docker-compose.prod.yml` (changed: per-host profiles)
- [ ] 9. **The two-host run** (this is the demonstrable outcome). Run A — **control plane at 10,000 instance rows** using a null-socket profile (no Baileys memory): assert no singleton loop is O(active) faster than 5 min, discovery scan time, PG connections ≤ `pool × workers` through PgBouncer, metric series under the cardinality budget, connect-bucket conformance at `clamp(desiredOnline/300, 8, 40)`. Run B — **real synthetic sockets at 10× the measured per-box count across ≥4 workers on ≥2 hosts** with the panel untouched: SSE, instance card, queue status all work; zero double ownership; zero re-QR; zero fence regressions; a full host kill recovers under the metered bucket. Both runs write JSONL artefacts and a `hosts:` fingerprint. → `app/backend/test/support/null-socket-profile.ts`, `scripts/measure/multi-host-run.ts`, `app/backend/test/integration/fleet/multi-host.int.test.ts`, `docs/measurements/raw/<date>-p27-run{A,B}-*.jsonl`
- [ ] 10. **Publish the costed path and finish the runbook.** `docs/capacity/scale-path-10k.md`: measured N from P26 → 10,000, both brackets, app boxes, `redis-sig` GB, DB tier + replica, storage/WAL/backup at the one load model, RTO per tier (~1 h ≤2,000 · 4-6 h at 10k from backup · ~15 min via promotion), deploy duration, and the 12 "what breaks first" rows each marked `done / threshold-gated at N / not yet needed`. Banner: `MEASURED to N · EXTRAPOLATED above N · Gate C open — nothing here may be quoted to a customer`. Extend `check-capacity-gate` to this file and `check-copy` to its figures. Runbook sections: capacity headroom + N+1, zero-headroom degrade-in-place, shed thrashing, adding a host, losing a host. → `docs/capacity/scale-path-10k.md`, `docs/RUNBOOK.md` (changed), `scripts/check-capacity-gate.ts` (changed), `scripts/check-copy.ts` (changed)

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/domain/src/capacity/fleet-headroom.test.ts` | `headroom_is_zero_when_every_box_is_needed` | 5 boxes × 2,000 holding 10,000 ⇒ ratio 0, `nPlusOneSatisfied` false |
| `packages/domain/src/capacity/fleet-headroom.test.ts` | `headroom_never_returns_a_negative_number` | over-subscribed fleet ⇒ 0 plus a named `deficitReason`, never `-N` |
| `packages/domain/src/capacity/fleet-headroom.test.ts` | `n_plus_one_requires_absorbing_the_largest_single_box` | uneven boxes ⇒ the largest box's load is the requirement (design §3.10) |
| `packages/domain/src/capacity/fleet-plan.test.ts` | `boxes_required_returns_both_bracket_answers_never_one_number` | 10,000 ⇒ `{optimised: 5, pessimistic: 10}`; a single-number API does not exist (ADR 0018 §2) |
| `packages/domain/src/capacity/fleet-plan.test.ts` | `a_plan_without_a_measurement_source_is_labelled_derived` | missing `measuredFrom` ⇒ output tagged `DERIVED`, never `MEASURED` |
| `app/backend/src/engine/send/transport.test.ts` | `remote_dispatch_with_a_stale_fence_never_transmits` | zero `sendMessage` calls, named error, `wp_dispatch_fence_reject_total` +1 |
| `app/backend/src/engine/send/transport.test.ts` | `the_same_attempt_id_dispatched_twice_transmits_once` | single-flight map; second call returns the first result, provider called once |
| `app/backend/src/engine/send/transport.test.ts` | `a_transport_timeout_leaves_the_attempt_dispatched_and_never_resends` | job → `needs_reconcile`, zero second transmit, zero requeue (invariants 2 and 5) |
| `app/backend/src/engine/send/transport.test.ts` | `inprocess_and_remote_produce_identical_job_and_attempt_rows` | same fixture through both transports ⇒ identical durable rows bar ids/timestamps |
| `app/backend/test/integration/send/remote-dispatch.int.test.ts` | `a_send_worker_drives_a_socket_owned_by_another_process` | end-to-end send with `SEND_TRANSPORT=remote`, delivery events written once |
| `app/backend/test/integration/send/remote-dispatch.int.test.ts` | `dispatch_after_a_takeover_is_refused_by_the_new_owner` | lease moved mid-flight ⇒ refusal, no duplicate message, `message_wa_ids` unchanged |
| `scripts/__tests__/check-role-boundaries.test.ts` | `send_worker_module_graph_cannot_reach_baileys` | planting a `provider/baileys` import in `roles/send-worker.ts` turns it red |
| `scripts/__tests__/check-role-boundaries.test.ts` | `guard_matches_a_non_zero_number_of_files` | the meta-assertion |
| `app/backend/src/platform/redis-keyspace.test.ts` | `every_prefix_is_bound_to_exactly_one_client` | duplicate or missing binding throws at module load |
| `app/backend/src/platform/redis-keyspace.test.ts` | `writing_a_sig_key_through_the_ctl_client_throws` | cross-client write refused at runtime, not just at lint |
| `scripts/__tests__/check-redis-keyspace.test.ts` | `a_raw_prefix_literal_outside_its_owning_client_turns_the_guard_red` | planted `wp:sig:` literal in `engine/**` fails CI |
| `app/backend/test/integration/fleet/redis-failover.int.test.ts` | `sentinel_promotion_resumes_batched_renew_without_a_fence_regression` | `wp_fence_regression_total = 0` across the failover; leases survive |
| `app/backend/test/integration/fleet/redis-failover.int.test.ts` | `a_failover_longer_than_the_lease_ttl_stops_sends_and_preserves_every_job` | self-fence fail-safe; job count and states byte-identical before/after |
| `app/backend/test/integration/fleet/redis-failover.int.test.ts` | `a_ctl_failover_does_not_disturb_sig_or_cache` | zero `redis-sig` errors, zero decrypt failures attributed to the failover |
| `app/backend/test/integration/fleet/redis-failover.int.test.ts` | `batched_renew_lua_keys_live_on_one_ctl_slot` | slot assertion fails if a key moves off the pinned slot |
| `app/backend/src/platform/db/reader.test.ts` | `a_write_statement_on_the_reader_pool_is_refused` | `INSERT` through the reader ⇒ read-only transaction error, not a silent success |
| `app/backend/src/platform/db/reader.test.ts` | `lag_above_the_threshold_falls_back_to_the_primary` | lag > `REPLICA_MAX_LAG_MS` ⇒ primary used, `wp_replica_fallback_total` +1 |
| `app/backend/src/platform/db/read-routing.test.ts` | `read_your_writes_sticks_that_client_to_the_primary` | after a mutation the same client's reads hit primary for `REPLICA_STICKY_MS` |
| `app/backend/test/integration/db/reader-isolation.int.test.ts` | `rls_is_enforced_on_the_replica_for_both_tenants` | isolation suite A rules hold on the reader; tenant B sees zero of tenant A's rows |
| `scripts/__tests__/check-reader-usage.test.ts` | `no_send_path_module_can_import_the_reader_pool` | planting the reader in the claim module turns it red |
| `ops/deploy/__tests__/rollout.test.ts` | `wave_size_comes_from_deploy_wave_size_and_stays_under_two_percent` | 10k fleet at the measured cap ⇒ ≤2% down at any instant; a hand-set larger wave is refused |
| `ops/deploy/__tests__/rollout.test.ts` | `rollout_refuses_to_start_if_migrate_has_not_run` | ADR 0009 step 3 ordering enforced, named error |
| `ops/deploy/__tests__/rollout.test.ts` | `no_ops_script_contains_a_vcs_command` | any `git`/`gh` token in `ops/**` turns it red (ADR 0003) |
| `app/backend/test/integration/fleet/multi-host.int.test.ts` | `two_hosts_share_one_lease_space_with_zero_double_ownership` | every instance owned exactly once across both hosts for the whole run |
| `app/backend/test/integration/fleet/multi-host.int.test.ts` | `ten_thousand_instance_rows_break_no_singleton_loop_cadence` | no O(active) loop runs faster than 5 min; discovery, scheduler and health cadences recorded (ADR 0018 §4) |
| `app/backend/test/integration/fleet/multi-host.int.test.ts` | `metric_series_stay_under_the_cardinality_budget_at_ten_thousand` | `instance_id` on ≤4 gauges; total series under budget (scope delta row 7) |
| `app/backend/test/integration/fleet/multi-host.int.test.ts` | `losing_a_whole_host_preserves_every_queued_job` | host killed ⇒ takeover under the metered bucket, zero jobs failed or deleted (invariant 5) |
| `app/backend/test/integration/fleet/multi-host.int.test.ts` | `the_panel_endpoints_are_unchanged_across_the_run` | the same contract snapshot passes before and after the split — no panel change was needed |
| `scripts/__tests__/check-capacity-gate.test.ts` | `scale_path_doc_must_carry_the_measured_and_extrapolated_banner` | stripping the banner or the `N=` turns it red |

Mandatory-suite tests this phase makes green: **none new** — but **11, 12, 13** (shutdown purity, rolling deploy, kill-storm) and P26's Gate-B suite must be re-run and stay green under `SEND_TRANSPORT=remote` and under the split roles. This phase closes scope-delta rows **3, 10, 11** and verifies rows **1, 2, 4, 5, 6, 7, 8, 12** at fleet scale.

## Definition of done
- [ ] Every step box above is ticked.
- [ ] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [ ] Named tests above exist and pass; no test is skipped or `.only`.
- [ ] The full suite is green **twice**: once with `SEND_TRANSPORT=inprocess` and once with `remote`.
- [ ] `docs/capacity/scale-path-10k.md` exists with the measured N, both brackets, the per-tier RTO, the 12-row status table and the Gate-C banner; every extrapolated figure names its measured basis.
- [ ] ADR 0021 (dispatch seam) is written and its decision matches the shipped code.
- [ ] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [ ] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [ ] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list. Expected set below — correct it, do not trust it. -->
- `.memory/decisions/0021-send-dispatch-seam.md` — created
- `packages/domain/src/capacity/fleet-headroom.ts`, `fleet-plan.ts` (+ `.test.ts`) — created
- `app/backend/src/engine/send/transport.ts`, `transport-inprocess.ts`, `transport-remote.ts`, `dispatch-server.ts` (+ `transport.test.ts`) — created
- `app/backend/src/roles/send-worker.ts` — created
- `app/backend/src/roles/session-worker.ts` — changed: sessions-only mode, dispatch server wiring
- `app/backend/src/engine/fleet/metrics.ts` — changed: `wp_fleet_capacity_headroom`, dispatch + replica gauges
- `db/queries/fleet-gauges.sql` — changed: headroom inputs
- `app/backend/src/platform/redis.ts` — changed: Sentinel-aware `redisCtl`, dedicated heartbeat connection
- `app/backend/src/platform/redis-keyspace.ts` (+ `.test.ts`) — created
- `app/backend/src/platform/db/reader.ts`, `read-routing.ts`, `read-replica-queries.ts` (+ tests) — created
- `db/migrations/<next>_reporting_role.sql` — created · `db/grants-snapshot.sql` — changed
- `app/backend/src/platform/config.ts` — changed: `SEND_TRANSPORT`, `DISPATCH_PORT`, `DISPATCH_TIMEOUT_MS`, `WORKER_CLAIMS_ENABLED`, `REDIS_CTL_SENTINELS`, `REPLICA_URL`, `REPLICA_MAX_LAG_MS`, `REPLICA_STICKY_MS`
- `app/backend/test/integration/{send/remote-dispatch,fleet/redis-failover,fleet/multi-host,db/reader-isolation}.int.test.ts` — created
- `app/backend/test/support/null-socket-profile.ts` — created
- `scripts/measure/multi-host-run.ts` — created
- `scripts/check-role-boundaries.ts`, `scripts/check-redis-keyspace.ts`, `scripts/check-reader-usage.ts` (+ their `__tests__`) — created
- `scripts/check-box-memory.ts` — changed: per-host iteration over `ops/hosts.json`
- `scripts/check-capacity-gate.ts`, `scripts/check-copy.ts`, `scripts/ci.ps1`, `scripts/ci.sh`, `packages/config/dependency-cruiser.cjs` — changed
- `ops/hosts.json`, `ops/deploy/{build-image,ship-image,migrate,rollout,rollback}.ps1`, `ops/deploy/wave.ts`, `ops/deploy/__tests__/rollout.test.ts` — created
- `infra/compose/docker-compose.dev.yml` — changed: `redis-ctl-replica`, `redis-sentinel-1..3`, `postgres-replica`, `send-worker`
- `infra/compose/docker-compose.prod.yml` — changed: per-host profiles, split roles
- `docs/capacity/scale-path-10k.md` — created · `docs/RUNBOOK.md` — changed · `docs/measurements/raw/<date>-p27-run{A,B}-*.jsonl` — created

## Risks / gotchas specific to this phase
- **The dispatch seam is the one place this phase can create a duplicate message.** Two mitigations are mandatory and neither is optional: the fence check on the owner side, and `attempt_id` single-flight. A dispatch timeout is *not* retried by the send-worker — it becomes `needs_reconcile` and the echo reconciler decides. If you find yourself writing "retry the dispatch", stop: that is invariant 2 and invariant 3 at the same time.
- **Do not move the pacing reserve or the wallet debit into the session-worker.** They stay on the send-worker side, before dispatch, exactly where they are today. Moving money or pacing across a network hop is a new failure mode nobody asked for.
- **Sentinel changes the client, not the semantics.** A promotion still loses in-flight Redis state; `redis-ctl` holds leases, buckets and pub/sub — all rebuildable — but a promotion that outlasts the lease TTL must self-fence fail-safe. Test both sides of the TTL, not just the happy failover.
- **A `redis-sig` failure is not a `redis-ctl` failure.** Never "fix" a sig memory alert by adding eviction (ADR 0018 §5): evicting a Signal session record makes already-encrypted inbound customer mail permanently unreadable.
- **A read replica silently breaks tenant isolation if RLS is not verified there.** The replica has the same schema, but the *role* and `SET LOCAL app.client_id` path is new. Run isolation suite A against the reader; do not assume.
- **Read-your-writes is where the panel will look broken.** A tenant sends a message and the list still says "0 sent" because the read went to a 900 ms-stale replica. Stickiness after mutation, a lag gauge, and primary fallback — all three, or route that endpoint to the primary and register the reason.
- **The panel must not change.** The demonstrable outcome says "panel unchanged". If a lever requires a frontend change, the lever is wrong; the contract snapshot test is the check.
- **"Two hosts" on one machine is not two hosts.** Two compose projects on separate networks prove lease and Redis behaviour; they do **not** prove NIC, cross-host latency or a real host loss. Label the artefact honestly with what it actually was.
- **Run A is a control-plane run, not a memory run.** Null sockets cost almost nothing; 10,000 of them says nothing about RAM. The RAM answer comes from P10's per-session bracket × the fleet, and it stays `EXTRAPOLATED`.
- **Placement neutrality holds under every optimisation here** (ADR 0018 §6): `discovery.ts` and `shed.ts` still may not read health, pause or restriction history, and there is no notion of IP diversity. One stable public egress IP per host is ordinary addressing. **No proxies, ever** — and nothing in this phase may spread a tenant's numbers across hosts "for safety", which is rotation wearing a different hat.
- **Nothing here becomes a customer-facing number.** Gate C needs ≥2,000 concurrent in production within SLO for 7 days. Until then the only honest sentence is *"the architecture has no known ceiling below 10,000 and has been measured to N"*, with N stated (ADR 0018 §8, ADR 0016).
- **Take the split line rather than half-finishing a lever.** Half a Redis failover story is worse than none: it looks HA and is not.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P28 — admin-internal-api-and-panel. Read plan/v1/P28-admin-internal-api-and-panel.md and follow it exactly:
one phase, one session. Deps P25 (and P27) are done (see plan/README.md). Do not start P29.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
