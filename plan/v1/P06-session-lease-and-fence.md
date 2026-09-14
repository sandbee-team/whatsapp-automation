# P06 — session-lease-and-fence

**Goal (one line):** exactly one worker can own a WhatsApp session at a time — a Redis lease for mutual exclusion, a Postgres-minted fence in the new `instance_lease_state` table asserted by every write predicate, a batched renew heartbeat, and a monotonic watchdog that self-fences a hung Redis within 15 s.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Depends on:** P03, P01 (must be `done`)
**Blocks:** P07, P08, P09, P11

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL O2).
- P02 shipped: `whatsapp_instances`, RLS FORCE, the four Postgres roles (`wp_app`, `wp_scheduler`, `wp_admin_app`, `wp_migrator`), the role-grant snapshot test, isolation suite A, `tenantKey()`/`sysKey()`.
- P03 shipped: `message_jobs`, the non-partitioned uniqueness authorities, `db/queries/claim-jobs.sql` with its filed `EXPLAIN (ANALYZE, BUFFERS)` artefact.
- P01 shipped: config, redacting logger, metrics registry, `@wp/server-kit` error mapper.
- ADRs 0013, 0015, 0016, 0017, 0018, 0020 accepted. No socket code exists yet — Baileys arrives in P08; this phase must not import it.
- There is no git. The "Files created or changed this session" list is the diff.

## What you are building (3-6 bullets)
- `instance_lease_state` — the narrow table that now owns `current_fence`, `owner_worker_id`, `lease_seen_at`, `released_at`; `whatsapp_instances.current_fence` and `.lease_seen_at` are **dropped** in the same migration.
- `LeaseManager.acquire()` — Redis `SET NX PX` with a placeholder → Postgres mints the fence → compare-and-set the fence into the lease value → `takeoverGraceMs` wait unless the previous owner released cleanly.
- A **batched-renew** heartbeat: one Lua call and one Postgres statement per worker per 10 s covering every lease it holds, returning per-instance 0/1 — the shape that survives 1,000+ concurrent sessions unchanged (scope delta "What breaks first" row 2).
- Self-fencing with exactly three triggers and one explicit non-trigger: **Postgres unavailability never self-fences** (row 12).
- The fence predicate wired into `db/queries/claim-jobs.sql` (join moved to `instance_lease_state`), the cross-tenant discovery scan query, the `CROSS_TENANT_QUERIES` registry entry and the grant snapshot — the four consequences the scope delta pins to this phase.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | "Lease + fence (single writer)" (incl. the `TIMING` object), "Worker fleet" (scan predicate only), failure table rows "Worker loses Redis", "Redis flushed", "Auth-state fence conflict", mandatory tests 3-6 |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | "What breaks first" rows **2** and **12**; "The merged canonical claim" incl. the paragraph after it (grants / discovery scan / `CROSS_TENANT_QUERIES` land **here**); "Isolation suite A exemption list" |
| Engine design | `.memory/research/2026-08-25-v1-design-engine-and-scale.md` | §3.1 algorithm + Lua, §3.2 failure modes, §3.3 lease-holder-only claim |
| 10k design | `.memory/research/2026-08-26-v1r-design-10k-concurrency.md` | §3.2 (the `instance_lease_state` DDL, batched renew Lua, autovacuum settings) |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §4 (normative scaling rule, batched renew at 1,000, "only a fence conflict self-fences") |
| ADR | `.memory/decisions/0013-*.md` | provider boundary — no evasion methods may appear on any interface |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md` | all |

## Dispatch plan (written at session open 2026-08-31 per SESSION-PROTOCOL E1 — this file predates dispatch plans)

Reality deltas found at O1/O2 that the units below already account for: the 0010 shell created `instance_lease_state` (so step 1 is ADDITIVE — the phase-file risk's second case); `whatsapp_instances` never carried `current_fence`/`lease_seen_at` (nothing to drop; the schema test still asserts absence); `claim-jobs.sql` already joins `instance_lease_state` (ADR 0026), so step 3 reduces to keep-green + re-file the EXPLAIN; the "fourth exemption" and the cross-tenant scan/renew mechanics are settled by ADR 0029 (filed at open).

- **U1** (db-engineer, contains the migration — runs ALONE): steps 1 + 2 + 3.
- **U2** (implementer — parallel with U3): step 4 (`TIMING.redisCommandTimeoutMs` only).
- **U3** (db-engineer — parallel with U2): step 5 (lease SQL files, repo, `CROSS_TENANT_QUERIES`, repo-level tests incl. fence monotonicity + stale-fence zero-rows).
- **U4** (implementer): steps 6 + 7 (Lua scripts, lease Redis client, `SessionOwner` port, `LeaseManager.acquire()`, mandatory test 3).
- **U5** (implementer): steps 8 + 9 (heartbeat, watchdog, self-fence, release, flush recovery, metrics; mandatory tests 4-6).

Test files adapt the phase-file's `app/backend/tests/**` paths to the repo's colocated convention (`app/backend/src/engine/lease/*.test.ts` / `*.integration.test.ts`, support code in `engine/lease/test-support/`), matching how P03-P05 landed their tests.

## Ordered minimum steps

- [x] **1. Migration: `instance_lease_state`, and drop the two columns it replaces.** *(landed as ADDITIVE migration `0018` on the P03/0010 shell; `whatsapp_instances` never carried the two columns — nothing dropped; schema test asserts absence)* DDL exactly as the 10k design §3.2 (PK `instance_id`, `client_id uuid NOT NULL`, `current_fence bigint NOT NULL DEFAULT 0`, `owner_worker_id text`, `lease_seen_at`, `released_at`, `fillfactor=60`, `ils_stale_idx`, `autovacuum_vacuum_scale_factor=0.02`, `autovacuum_vacuum_cost_limit=2000`), RLS `FORCE` + tenant policy, then `ALTER TABLE whatsapp_instances DROP COLUMN current_fence, DROP COLUMN lease_seen_at`. Grants: `wp_app` SELECT/INSERT/UPDATE, `wp_scheduler` SELECT, `wp_admin_app` **SELECT only** (add it to the "admin cannot write a send-path table" list in the snapshot fixture). Dispatch `db-engineer`. → `db/migrations/00NN_instance_lease_state.sql` (next free number), `app/backend/tests/integration/db/grant-snapshot.test.ts` fixture
- [x] **2. Register the table in isolation suite A and resolve the exemption conflict in writing.** *(resolved via ADR 0029: no fourth `SUITE_A_INDEX_EXEMPTIONS` entry — `ils_stale_idx` registered in `CANONICAL_AUTHORITY_KEYS` per the ADR 0022 mechanism; pin test `instance_lease_state_is_the_fourth_and_last_exemption` added)* `instance_lease_state` does not lead with `client_id` (PK is the globally unique `instance_id`), which is exactly the shape of the delta's three-entry exemption list — so suite A's `exactly_three_exemptions` assertion must become **four**, named, with the reason. Do **not** silently loosen the guard: run `/decide` and file a short ADR amendment recording the fourth entry, then update the suite. → `app/backend/tests/isolation/suite-a.test.ts`, `.memory/decisions/00NN-instance-lease-state-exemption.md`
- [x] **3. Move the claim's fence join to `instance_lease_state` and re-file the EXPLAIN.** *(join already moved in P03/ADR 0026 — `claim-jobs.sql` untouched; claim suites re-proven green post-0018; EXPLAIN re-filed at `docs/evidence/P06-claim-explain.md`)* Edit `db/queries/claim-jobs.sql` so the predicate is `JOIN instance_lease_state ls ON ls.instance_id = j.instance_id … AND ls.current_fence = $fence` (meaning unchanged; lock clause stays `FOR UPDATE OF j SKIP LOCKED`). P03's claim tests must stay green untouched. Re-run `EXPLAIN (ANALYZE, BUFFERS)` and overwrite the filed artefact. → `db/queries/claim-jobs.sql`, `docs/artefacts/claim-explain.md`
- [x] **4. `TIMING` in `@wp/domain` with its ordering test.** *(P00 had shipped everything but `redisCommandTimeoutMs: 2_000` — added with assertions inside the existing `timing_ordering_invariants_hold` case)* One exported frozen object: `leaseTtlMs 30_000 · heartbeatMs 10_000 · takeoverGraceMs 15_000 · watchdogMs 15_000 · redisCommandTimeoutMs 2_000 · sendTimeoutMs 45_000 · claimExpiryMs 90_000 · reaperGraceMs 30_000 · reconcileWindowMs 600_000`, asserting `sendTimeout < claimExpiry − reaperGrace` and `takeoverGrace + leaseTtl > watchdog`. If P00 already shipped the object, add only the missing fields. → `packages/domain/src/timing.ts`, `packages/domain/src/timing.test.ts`
- [x] **5. The four lease SQL files + the repo that loads them.** *(five files on disk — the mint's read-released SELECT is its own file because `loadQuery` is one-statement-per-file; repo enforces same-transaction execution; both CROSS_TENANT_QUERIES entries registered; guards:meta green)* `lease-mint-fence.sql` (`SELECT … FOR UPDATE` of the existing row for `released_at`, then `INSERT … ON CONFLICT (instance_id) DO UPDATE SET current_fence = instance_lease_state.current_fence + 1, owner_worker_id=$w, lease_seen_at=now(), released_at=NULL RETURNING current_fence` — monotonic by construction), `lease-renew-batch.sql` (`UPDATE … FROM unnest($ids::uuid[], $fences::bigint[]) t WHERE ls.instance_id=t.instance_id AND ls.current_fence=t.fence AND ls.owner_worker_id=$w RETURNING ls.instance_id` — rows **not** returned are fence conflicts), `lease-release.sql` (sets `owner_worker_id=NULL, released_at=now()` guarded by fence), `lease-scan-unowned.sql` (blueprint "Worker fleet" predicate, now reading `ls.lease_seen_at`, `ORDER BY random() LIMIT 50` — query only, the loop is P09). Add the scan to `CROSS_TENANT_QUERIES` with role `wp_scheduler`, reason and projected columns. → `db/queries/lease-*.sql`, `app/backend/src/engine/lease/lease-state-repo.ts`, `scripts/cross-tenant-queries.ts`
- [x] **6. Redis Lua scripts + a lease Redis client with a hard 2 s command timeout.** *(key shape is `tenantKey(env, client, 'lease', 'i', instance)` = `wp:{env}:c:{client}:lease:i:{instance}` — the sanctioned helper's shape, not the phase literal; recorded deviation)* `acquire.lua` (`SET NX PX` a `{worker}|PENDING` placeholder), `set-fence.lua` (compare-and-set the minted fence into the value, returns 0 if we no longer hold it), `renew-batch.lua` (N keys, one round trip, returns a 0/1 array), `release.lua` (compare-and-delete). Keys are `wp:{env}:lease:c:{client}:i:{instance}` via `tenantKey()` — Redis isolation suite C must still pass. → `app/backend/src/engine/lease/scripts/{acquire,set-fence,renew-batch,release}.lua`, `app/backend/src/engine/lease/lease-redis.ts`
- [x] **7. `LeaseManager.acquire()`.** *(mandatory test 3 first half green — one winner, loser null, grace enforced, fence strictly higher; the "first self-fences" assertion lands with U5's heartbeat)* Order is fixed: Redis NX placeholder → PG mint → `set-fence` CAS (0 ⇒ abort, release nothing, no socket) → skip the grace only if the row's previous `released_at` is within 60 s, else wait `takeoverGraceMs` → hand back a `SessionLease { instanceId, clientId, fence, workerId }`. No socket is opened here; the socket owner is an injected `SessionOwner` port (`onFenceLost(instanceId, cause)`), implemented by a fake in tests and by P08 for real. Test 3. → `app/backend/src/engine/lease/lease-manager.ts`, `app/backend/src/engine/lease/session-owner.port.ts`
- [x] **8. Batched heartbeat + monotonic watchdog.** *(exactly-three triggers in pure self-fence.ts; PG failure keeps lease+socket and only pauses claiming via isClaimingAllowed(); watchdog on process.hrtime.bigint())* One `renew-batch.lua` call and one `lease-renew-batch.sql` statement per tick for all held leases. Self-fence triggers are **exactly three**: (a) the Redis array returns 0 for that key, (b) a *successful* PG renew omits that instance (fence conflict), (c) no successful Redis renewal completed within `watchdogMs`, measured on `process.hrtime.bigint()`, never `Date.now()`. **Non-trigger, explicitly:** any PG error, timeout or unavailability — log, count, keep the lease, keep the socket, stop claiming. Tests 6 + `postgres_unavailability_does_not_self_fence`. → `app/backend/src/engine/lease/heartbeat.ts`, `app/backend/src/engine/lease/self-fence.ts`
- [x] **9. Release, stale-fence rejection and Redis-flush recovery, with the three metrics.** *(mandatory tests 4 (existing paths) + 5 green; three counters registered without instance_id labels; mint's read statement extended to return prev owner for the takeover counter)* Graceful `release()` (abort in flight → `SessionOwner.close()` → `release.lua` → `lease-release.sql`); a stale fence writes zero rows on the claim and on `lease-renew-batch`; after `FLUSHALL` a re-acquire mints a strictly higher fence and claiming resumes. Register `wp_lease_takeovers_total`, `wp_lease_lost_total{cause}`, `wp_fence_regression_total` (no `instance_id` label — the four-gauge allow-list). Tests 4 (paths that exist today) + 5. → `app/backend/src/engine/lease/lease-manager.ts`, `app/backend/src/platform/metrics/lease-metrics.ts`

## Tests that prove it

| Test file | Case | Asserts |
|---|---|---|
| `app/backend/tests/concurrency/lease-fence.test.ts` | `two_workers_cannot_hold_one_session` | two `LeaseManager`s race one instance: one `SessionLease`, the loser gets `null`; the second acquirer waits `takeoverGraceMs` before it is handed a lease; the first self-fences (mandatory 3) |
| `app/backend/tests/concurrency/lease-fence.test.ts` | `fence_is_strictly_monotonic_under_50_parallel_acquires` | 50 parallel mints → 50 distinct, strictly increasing fences; no value reused |
| `app/backend/tests/integration/engine/stale-fence.test.ts` | `stale_fence_cannot_claim_save_purge_or_write_events` | a stale fence yields **zero rows** from `claim-jobs.sql` and from `lease-renew-batch.sql`; the job stays `queued` (mandatory 4 — P07 extends this file with `setKeys`/`purge`) |
| `app/backend/tests/integration/engine/redis-flush.test.ts` | `redis_flush_does_not_deadlock_claims` | `FLUSHALL` mid-run → next acquire mints a higher fence, claiming resumes within one scan interval, `wp_fence_regression_total` = 0 (mandatory 5) |
| `app/backend/tests/unit/engine/watchdog.test.ts` | `hung_redis_connection_self_fences_within_15s` | a never-resolving Redis client + fake timers: `onFenceLost(cause='watchdog')` fires at ≤15 s and every renew command carries a 2 s timeout (mandatory 6) |
| `app/backend/tests/integration/engine/watchdog.test.ts` | `half_open_tcp_self_fences_within_15s` | same, against a `net` server that accepts and never replies (`app/backend/tests/support/hung-tcp-proxy.ts`) |
| `app/backend/tests/unit/engine/watchdog.test.ts` | `clock_jump_backwards_does_not_delay_the_watchdog` | wall clock moved −10 min mid-tick; the monotonic deadline is unchanged |
| `app/backend/tests/integration/engine/heartbeat.test.ts` | `batched_renew_covers_every_owned_lease_in_one_round_trip` | 25 leases → exactly 1 Redis call and 1 SQL statement per tick; all 25 `lease_seen_at` advance |
| `app/backend/tests/integration/engine/heartbeat.test.ts` | `renew_partial_loss_self_fences_only_the_lost_instance` | one key returns 0 → that instance fences, the other 24 keep their leases |
| `app/backend/tests/integration/engine/heartbeat.test.ts` | `postgres_unavailability_does_not_self_fence` | PG pool made to throw for 30 s: zero `onFenceLost` calls, lease retained, `wp_lease_lost_total` unchanged (scope delta row 12) |
| `app/backend/tests/integration/engine/lease-release.test.ts` | `graceful_release_lets_the_next_owner_skip_the_grace` | after `release()`, the next acquire connects without waiting `takeoverGraceMs`; `released_at` is set |
| `app/backend/tests/integration/engine/lease-release.test.ts` | `a_released_lease_older_than_60s_still_costs_the_full_grace` | stale `released_at` does not skip the grace |
| `app/backend/tests/isolation/suite-a.test.ts` | `instance_lease_state_is_the_fourth_and_last_exemption` | the exemption list is exactly four named entries; a fifth turns the suite red |
| `app/backend/tests/integration/db/grant-snapshot.test.ts` | `wp_admin_app_cannot_write_instance_lease_state` | no INSERT/UPDATE/DELETE grant for `wp_admin_app` |
| `app/backend/tests/integration/db/schema.test.ts` | `whatsapp_instances_no_longer_carries_a_fence` | `current_fence` and `lease_seen_at` are absent from `whatsapp_instances` |
| `packages/domain/src/timing.test.ts` | `timing_constants_satisfy_the_ordering_invariants` | `sendTimeout < claimExpiry − reaperGrace`; `takeoverGrace + leaseTtl > watchdog` |

Mandatory-suite tests this phase makes green: **3, 4 (claim + lease-state write paths; `setKeys`/`purge` cases added in P07), 5, 6.**

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
### Actual (running list, updated per unit — supersedes the predicted list below)
U1 (steps 1-3):
- `db/migrations/0018_instance_lease_state.sql` — created (additive: released_at, fillfactor/autovacuum, ils_stale_idx, grants fixup, lease_owner_renew policy, wp_lease_scan_unowned definer fn)
- `docs/evidence/P06-claim-explain.md` — created (EXPLAIN re-filed post-0018; join move itself landed in P03/ADR 0026)
- `db/schema/instance-lease-state.ts` — changed (releasedAt mirror column)
- `db/src/schema-version.ts` — changed (EXPECTED_SCHEMA_VERSION 17 → 18; later 18 → 19 with migration 0019, missed by FIX-A and caught by migrate-runner at the C5 gate)
- `db/src/isolation/tenant-tables.ts` — changed (CANONICAL_AUTHORITY_KEYS lease_seen_at entry; SEND_PATH_TABLES += instance_lease_state)
- `db/tests/isolation-suite-a.test.ts` — changed (new pin case)
- `db/tests/grants-snapshot.test.ts` — changed (admin-cannot-write case + lease-scan definer hardening case)
- `db/tests/schema-assertions.test.ts` — changed (whatsapp_instances_no_longer_carries_a_fence)
- `db/schema/grants.snapshot.json` — regenerated
- `.memory/decisions/0029-instance-lease-state-exemption-and-cross-tenant-access.md` — created at session open (orchestrator /decide)

U2 (step 4):
- `packages/domain/src/timing.ts` — changed (redisCommandTimeoutMs 2_000)
- `packages/domain/src/timing.test.ts` — changed (new assertions in timing_ordering_invariants_hold)

U3 (step 5):
- `db/queries/lease-mint-read-released.sql` — created
- `db/queries/lease-mint-fence.sql` — created
- `db/queries/lease-renew-batch.sql` — created
- `db/queries/lease-release.sql` — created
- `db/queries/lease-scan-unowned.sql` — created (calls wp_lease_scan_unowned; predicate lives in migration 0018)
- `app/backend/src/engine/lease/lease-state-repo.ts` — created
- `app/backend/src/engine/lease/lease-fence.concurrency.integration.test.ts` — created
- `app/backend/src/engine/lease/stale-fence.integration.test.ts` — created
- `scripts/registries/cross-tenant-queries.ts` — changed (lease-renew-batch + lease-scan-unowned entries)

U4 (steps 6-7):
- `app/backend/src/engine/lease/scripts/acquire.lua` — created
- `app/backend/src/engine/lease/scripts/set-fence.lua` — created
- `app/backend/src/engine/lease/scripts/renew-batch.lua` — created
- `app/backend/src/engine/lease/scripts/release.lua` — created
- `app/backend/src/engine/lease/lease-redis.ts` — created (hard 2 s per-command timeout, rejects on timeout)
- `app/backend/src/engine/lease/session-owner.port.ts` — created (no reconnect(); safety boundary documented)
- `app/backend/src/engine/lease/lease-manager.ts` — created (acquire(); release() lands in U5)
- `app/backend/src/engine/lease/lease-manager.test.ts` — created
- `app/backend/src/engine/lease/lease-fence.concurrency.integration.test.ts` — changed (two_workers_cannot_hold_one_session, first half)

U5 (steps 8-9):
- `app/backend/src/engine/lease/self-fence.ts` — created (pure exactly-three-trigger decisions)
- `app/backend/src/engine/lease/heartbeat.ts` — created (one Redis call + one SQL statement per tick; isClaimingAllowed())
- `app/backend/src/platform/metrics/lease-metrics.ts` — created (+ `lease-metrics.test.ts`)
- `app/backend/src/engine/lease/test-support/hung-tcp-proxy.ts` — created
- `app/backend/src/engine/lease/watchdog.test.ts` — created
- `app/backend/src/engine/lease/watchdog.integration.test.ts` — created
- `app/backend/src/engine/lease/heartbeat.integration.test.ts` — created
- `app/backend/src/engine/lease/lease-release.integration.test.ts` — created
- `app/backend/src/engine/lease/redis-flush.integration.test.ts` — created
- `app/backend/src/engine/lease/lease-manager.ts` — changed (release(), takeover/regression metrics)
- `app/backend/src/engine/lease/lease-state-repo.ts` — changed (MintFenceResult.prevOwnerWorkerId)
- `db/queries/lease-mint-read-released.sql` — changed (SELECT released_at, owner_worker_id)
- `app/backend/src/engine/lease/lease-manager.test.ts` — changed
- `app/backend/src/engine/lease/lease-fence.concurrency.integration.test.ts` — changed (mandatory 3 second half: first owner self-fences)

E3 edge pass (test-engineer):
- `app/backend/src/engine/lease/lease-manager.edge.test.ts` — created (4 tests)
- `app/backend/src/engine/lease/heartbeat.edge.test.ts` — created (3 tests)
- `app/backend/src/engine/lease/lease-state-repo.edge.integration.test.ts` — created (12 tests; RLS write-path probe runs under SET LOCAL ROLE wp_app)

E2 debugger fix (after the unit-suite red):
- `db/queries/lease-mint-fence.sql` — changed (ON CONFLICT DO UPDATE gains `WHERE instance_lease_state.client_id = $client_id` — tenant predicate; zero rows on tenant mismatch already throws in mintFence)
- `.memory/lessons/2026-08-31-guards-meta-does-not-run-guard-logic.md` — created (+ MEMORY.md index line)

C2 all-cases pass (test-engineer):
- `app/backend/src/engine/lease/heartbeat.c2.test.ts` — created (incl. REAL FINDING pin: tick re-entrancy)
- `app/backend/src/engine/lease/lease-manager.c2.test.ts` — created (incl. REAL FINDING pin: future released_at skips grace)
- `app/backend/src/engine/lease/lease-state-repo.c2.integration.test.ts` — created (crash-mid-mint, replay, cross-worker renew, retry storm)

C1 FIX-A (db-engineer — reviewer CRITICALs 1-3 + suggestion 10):
- `db/migrations/0019_lease_renew_policy_fix.sql` — created (policy pair lease_owner_renew_select/_update replaces FOR UPDATE-only policy; wp_lease_scan_unowned clamps max_rows to [0,500], floors stale_ms at 0)
- `db/src/tenant-db.ts` — changed (WorkerQueryable/WorkerDb/createWorkerDb — withWorker pins GUC + statement to one transaction)
- `db/src/index.ts` — changed (exports)
- `app/backend/src/engine/lease/lease-state-repo.ts` — changed (renewBatch requires WorkerDb; doc fixed)
- `app/backend/src/engine/lease/heartbeat.ts` — changed (pgSql typed WorkerDb; compile-only)
- `app/backend/src/engine/lease/test-support/worker-as-role.ts` — created (SET LOCAL ROLE wp_app + worker GUC composition for tests)
- `app/backend/src/engine/lease/lease-renew-cross-tenant-rls.integration.test.ts` — created (load-bearing two-tenant renew under wp_app; red on 0018 shape)
- renew call-site test updates: lease-state-repo.edge/.c2, stale-fence, heartbeat.integration/.c2/.edge, lease-fence.concurrency, watchdog.test/.integration
- `.memory/decisions/0029-...md` — changed (§3 amended to the two-policy + withWorker shape)

C1 FIX-B (implementer — reviewer warnings 5-8, suggestion 9, C2 finding 1):
- `app/backend/src/engine/lease/heartbeat.ts` — changed (tick skip-if-running + skip metric + stop() awaits all in-flight; watchdog missing-baseline skip + no re-insertion after remove())
- `app/backend/src/engine/lease/lease-manager.ts` — changed (grace delta >= 0 guard; sessionOwnerPort getter + releaseLeaseFence re-export removed)
- `app/backend/src/engine/lease/scripts/acquire.lua` — changed (atomic SET ... PX ... NX)
- `app/backend/src/platform/metrics/lease-metrics.ts` — changed (+ wp_lease_heartbeat_ticks_skipped_total) (+ test)
- `app/backend/src/engine/lease/heartbeat.c2.test.ts`, `lease-manager.c2.test.ts` — flipped to assert safe behavior; `heartbeat.edge.test.ts` — new baseline-skip test

C5 gate conformance (formatting + lint, no behavior change):
- Prettier pass over the session's files; unused stub params removed (`heartbeat.c2.test.ts`, `watchdog.test.ts`)
- max-lines splits with re-exports, test names byte-identical: `lease-manager.types.ts`, `lease-manager.release.test.ts`, `heartbeat.watchdog-baseline.edge.test.ts`, `lease-state-repo.c2.cross-worker.integration.test.ts`, `lease-state-repo.edge.renew-fence.integration.test.ts` — created; `test-support/lease-manager-fixtures.ts`, `test-support/lease-state-repo-c2-fixtures.ts`, `test-support/lease-state-repo-edge-fixtures.ts` — created; the five oversized files trimmed accordingly

C5 gate fixes (post-lint-split):
- `app/backend/src/engine/lease/__tests__/lease-state-repo-c2-fixtures.ts`, `__tests__/lease-state-repo-edge-fixtures.ts` — moved from test-support/ (the tenant-scope guard's exemption is the tests?/__tests__/.test-suffix convention; test-support/ is scanned) + import updates in the four consuming test files
- `db/src/schema-version.ts` — 18 → 19 (0019 bump FIX-A missed; caught by migrate-runner)
- `app/backend/src/engine/lease/heartbeat.c2.test.ts` — turn-counting flake fixed with deterministic deferred signals (root cause: loadQuery's first-call fs read outlasting a fixed 10-turn flush under full-suite load); comment trimmed for max-lines
- `.memory/lessons/2026-08-31-heartbeat-c2-test-turn-counting-flake.md` — created (+ MEMORY.md index line)

### Predicted at authoring time (kept for reference)
- `db/migrations/00NN_instance_lease_state.sql` — created
- `db/queries/lease-mint-fence.sql` — created
- `db/queries/lease-renew-batch.sql` — created
- `db/queries/lease-release.sql` — created
- `db/queries/lease-scan-unowned.sql` — created
- `db/queries/claim-jobs.sql` — changed: fence join moved to `instance_lease_state`
- `docs/artefacts/claim-explain.md` — changed: EXPLAIN re-filed after the join move
- `packages/domain/src/timing.ts` — created/changed
- `packages/domain/src/timing.test.ts` — created
- `app/backend/src/engine/lease/lease-manager.ts` — created
- `app/backend/src/engine/lease/lease-state-repo.ts` — created
- `app/backend/src/engine/lease/lease-redis.ts` — created
- `app/backend/src/engine/lease/heartbeat.ts` — created
- `app/backend/src/engine/lease/self-fence.ts` — created
- `app/backend/src/engine/lease/session-owner.port.ts` — created
- `app/backend/src/engine/lease/scripts/{acquire,set-fence,renew-batch,release}.lua` — created
- `app/backend/src/platform/metrics/lease-metrics.ts` — created
- `scripts/cross-tenant-queries.ts` — changed: `lease-scan-unowned.sql` registered
- `app/backend/tests/**` — the test files named above
- `.memory/decisions/00NN-instance-lease-state-exemption.md` — created (step 2)

## Risks / gotchas specific to this phase
- **The exemption conflict is real, not a formality.** `instance_lease_state` cannot lead with `client_id` and the delta says the exemption list is *exactly three*. Editing the assertion without an ADR turns a guard into decoration. Do step 2 before step 5 or suite A goes red for a reason nobody attributed.
- **P03 already joins `instance_lease_state`.** Check whether P03 created a placeholder table to make its claim compile. If it did, step 1 becomes an **additive** migration (add missing columns, index, storage params, grants, RLS) plus the two `DROP COLUMN`s — never a `DROP TABLE`. Record which case you hit.
- **Deviation to record: grace-skip authority.** The engine design §3.1 puts a `released` marker in Redis with `PX 2000`; that window is dead by the time a TTL-expiry takeover happens (≥30 s later), so this phase uses `instance_lease_state.released_at` (read `FOR UPDATE` inside the mint transaction, fresh within 60 s) and does **not** implement the Redis marker. Note the deviation in the session log; if the reviewer disagrees, `/decide`.
- **Do not self-fence on Postgres trouble.** The single easiest way to fail this phase is a `catch` that treats a PG timeout like a fence conflict — at 1,000 sessions that drops the whole fleet on a checkpoint stall. Fence conflict = a statement that *succeeded* and omitted our row. Everything else is a retry.
- **Watchdog on the monotonic clock only.** `Date.now()` under NTP correction or a container clock jump either fences everything at once or never fences at all.
- **Batched from day one.** A per-session `setInterval` is 1,000 timers and 1,000 Redis calls at the threshold in scope-delta row 2; the renew API takes a *set* of leases and returns a per-instance result, even when the set has one element.
- **Safety boundary:** self-fencing releases a lease; it never re-links, never rotates, never picks another number, and never auto-resumes an instance out of a paused/restricted state. `SessionOwner` gets `close()` — it must not gain `reconnect()` in this phase; reconnect policy is P08.
- **No Baileys import in this phase.** If a step seems to need a socket, it belongs to P08; use the `SessionOwner` fake.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P07 — session-auth-store. Read plan/v1/P07-session-auth-store.md and follow it exactly:
one phase, one session. Deps P06 are done (see plan/README.md). Do not start P08.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
