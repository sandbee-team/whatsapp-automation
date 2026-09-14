# P03 — db-queue-and-claim

**Goal (one line):** `message_jobs` (monthly partitions), every non-partitioned uniqueness authority, and the single merged `db/queries/claim-jobs.sql` exist, executable, with a filed `EXPLAIN (ANALYZE, BUFFERS)` artefact.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P02 (must be `done`)
**Blocks:** P06, P11, P12, P13, P18

## Prerequisites (facts, not phases)
- Postgres **17** + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` (ROLE=migrate runner, P02) applies cleanly on a fresh volume. Identity columns on partitioned tables require PG 17 — a PG 16 box fails step 2 with a confusing error.
- P02 landed: all canonical enums (blueprint §Data model → *Canonical enums*, plus the delta's `broadcast_status`, `wallet_state`, `msg_direction`, `chat_kind`), `clients`/`users`/`memberships`, `wallet_accounts` + `client_pricing` + `price_lists`/`price_list_items`, the four Postgres roles, RLS `FORCE`, the grant snapshot test, isolation suite A, the boot schema-version assertion. If an enum this phase needs is missing, add it in step 2's migration and record it in the files list.
- `@wp/domain` exports the generated TS unions for the DB enums (P00/P02) — test 23 compares against them.
- ADRs **0013-0020 accepted**. Quick gate green on the tree as found: `pnpm run typecheck && pnpm run guards:meta` (SESSION-PROTOCOL **O2**); run the full `scripts/ci.ps1` at open ONLY if the previous session's C5 evidence is missing from its session log.
- No design decision is open for this phase: the claim is already specified verbatim in the delta, so skip **O3** and go straight to E1.
- Carried from P02: the monthly partition rollover job this phase builds (db/src/partitions.ts) must cover `wallet_ledger` as well as `message_jobs` — 0004 seeded only current+2 months and `wp_ensure_month_partition` EXECUTE is owner-only (reviewer N14).
- Carried from P02: `wp_scheduler`'s narrow column grants on `message_jobs`/`whatsapp_instances` land in THIS phase's migration (0005 left it with schema_migrations SELECT only); regenerate `db/schema/grants.snapshot.json` deliberately (vitest --update) in the same step.
- Carried from P02: isolation suite B (two-tenant background paths) starts here with the first background worker; suite A + the grant snapshot auto-extend via `db/src/isolation/tenant-tables.ts` — new tenant tables must be registered there in the same task that creates them.

## What you are building (3-6 bullets)
- `message_jobs`: monthly-partitioned parent, PK `(id, created_at)`, every CHECK, the five indexes, RLS FORCE + grants, plus a re-runnable partition maintenance helper.
- The four non-partitioned uniqueness authorities: `message_job_refs`, `message_wa_ids` (created **in its final both-directions shape**), `delivery_event_ids`, `send_attempts` — plus `delivery_events` (weekly partitions), whose dedupe authority is `delivery_event_ids`.
- The DDL shells the claim joins, DDL only, logic owned by later phases: `whatsapp_instances`, `instance_lease_state`, `campaigns` (create only what P02 did not already create).
- `db/queries/claim-jobs.sql` — the merged canonical claim, copied **verbatim** from the delta, loaded from that one file, with a guard that no second statement can set `status='processing'`.
- Evidence: a two-worker race proving exactly one winner, and `EXPLAIN (ANALYZE, BUFFERS)` of the exact statement against a seeded fixture, filed at `docs/evidence/P03-claim-explain.md`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Data model → Durable queue*; *Durable queue, scheduler & send pipeline → The canonical claim*; *Testing strategy → Mandatory send-path and engine suite* (tests 2, 21, 22, 23) |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Corrections found after synthesis* item 1 (now resolved — see gotchas) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *The merged canonical claim*; *Schema delta* (incl. *Groups* `message_jobs` ALTERs, *Conversations and messages* `message_wa_ids`); *Where the balance is checked* |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | — |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | — |
| Skill | `.claude/skills/queue-engineering/SKILL.md` | Job claiming · Idempotency · Pause/resume (already preloaded in implementer/test-engineer dispatches; Read only from db-engineer) |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md` | all |

## Ordered minimum steps
Migration numbers assume P02 ended at `0005` (its files list says it did). If it ended elsewhere, use the next free 4-digit numbers and write the real names into the files list.

**Dispatch plan (E1 work units - 4 dispatches, 3 serial slots):**
- **Unit A** (db-engineer) = steps 1+2+3+4 - all DDL: migrations 0006-0009, schema mirrors, partition helper, plus `db/test/schema-assertions.test.ts` + `db/test/partitions.test.ts` red-first. If it passes the ~20-min budget mid-way, split after step 2.
- **Unit B** (implementer) = steps 5+6 - the claim module end to end: `claim-jobs.sql` (pasted verbatim into the dispatch), loader, `check-single-claim` guard + ci wiring, `claimOne` repo, `claim.integration.test.ts` red-first.
- **Unit C** (implementer, IN PARALLEL with B - disjoint scopes) = step 7 - guard registrations (`db/test/**`, `scripts/check-tenant-scope.ts`, grants snapshot).
- **Unit D** (db-engineer) = step 8 - seed fixture + `EXPLAIN` evidence + `claim-plan.test.ts`.
Serial order: A -> (B || C) -> D. Tests are written red-first inside the unit that owns the step - never all upfront.

- [x] 1. `message_jobs` parent + partitions + partition helper -> `db/migrations/0006_message_jobs.sql`, `db/schema/message-jobs.ts`, `db/src/partitions.ts`, `db/queries/ensure-partitions.sql`; write `db/test/schema-assertions.test.ts` and `db/test/partitions.test.ts` red-first in this dispatch (cases from the table below - the catalog-property cases then stay green as later steps add tables). Includes every column and CHECK from the blueprint **plus** the delta's group shape (`recipient_e164` nullable, `mj_recipient_shape`), the five indexes, `FILLFACTOR 70`, RLS `ENABLE`+`FORCE` with the `client_id` policy, and grants (`wp_app`, `wp_scheduler` R/W; `wp_admin_app` **no** INSERT/UPDATE/DELETE). Helper creates current + 2 months and is a no-op on re-run.
- [x] 2. The uniqueness authorities, all non-partitioned -> `db/migrations/0007_queue_uniqueness_authorities.sql`, `db/schema/message-job-refs.ts`, `db/schema/message-wa-ids.ts`, `db/schema/delivery-event-ids.ts`, `db/schema/send-attempts.ts`. `message_wa_ids` is created in its **final** shape: PK `(client_id, instance_id, direction, wa_msg_id)`, `message_id` nullable, `inbox_message_id`/`inbox_message_created_at` present.
- [x] 3. `delivery_events`, weekly partitions, `detail jsonb` <=250 B, dedupe via `delivery_event_ids` -> `db/migrations/0008_delivery_events.sql`, `db/schema/delivery-events.ts`; register the weekly cadence in `db/src/partitions.ts`.
- [x] 4. The claim's join shells, **DDL only** -> `db/migrations/0009_claim_join_shells.sql`. Create only what does not already exist: `whatsapp_instances` (final shape, **without** `current_fence`/`lease_seen_at`/`health_score`), `instance_lease_state` (narrow: `instance_id` PK, `client_id`, `current_fence bigint NOT NULL DEFAULT 0`, `owner_worker_id`, `lease_seen_at`), `campaigns` (`id`, `client_id`, `status broadcast_status`, timestamps). Header comment states P06 and P23 own the logic and must `ALTER`, never `CREATE`.
- [x] 5. `db/queries/claim-jobs.sql` - the merged canonical claim (the dispatching session pastes it from the delta **verbatim into the dispatch text**; the subagent never opens `.memory/research/**`), add the header comment (lock clause rationale; INNER JOIN on `wallet_accounts` is fail-closed; `LEFT JOIN campaigns`; never re-transcribed) -> plus loader `db/src/queries.ts` and guard `scripts/check-single-claim.ts` (fails if any file other than `claim-jobs.sql` contains `status='processing'` in an UPDATE), wired into `scripts/ci.ps1`/`ci.sh` with the guard meta-assertion.
- [x] 6. `claimOne(ctx, {instanceId, band, fence, workerId, claimExpiryMs, ledgerDate})` over that file -> `app/backend/src/modules/queue/queue.repo.ts`, `app/backend/src/modules/queue/index.ts`. No ORM re-implementation; zero rows is a normal return value, not an error. Write the failing `app/backend/src/modules/queue/claim.integration.test.ts` red-first in this dispatch, then make it green.
- [x] 7. Register the new tables everywhere the guards look -> `db/test/isolation-suite-a.test.ts` (all new tenant tables; exemption list stays exactly the three delta entries), `db/test/role-grants.snapshot.json` + its diff test, `scripts/check-tenant-scope.ts` (`claim-jobs.sql` is tenant-scoped - it needs **no** `CROSS_TENANT_QUERIES` entry).
- [x] 8. Seed the fixture, run and file the plan -> `db/seeds/queue-explain-fixture.sql` (5 clients x 10 instances, ~200k `queued` jobs spread across 3 monthly partitions, mixed bands), `docs/evidence/P03-claim-explain.md` (verbatim `EXPLAIN (ANALYZE, BUFFERS)` output, the partition count actually scanned, and the row confirming no `Sort` node); write `db/test/claim-plan.test.ts` red-first in this dispatch, then make it green.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/test/schema-assertions.test.ts` | `no_unique_index_on_a_partitioned_table_without_the_partition_key` | catalog scan: every UNIQUE/PK on a partitioned relation includes its partition key (**test 21**) |
| `db/test/schema-assertions.test.ts` | `exactly_one_table_carries_a_reserve_counter` | the set of tables with a reserve-counter column is ⊆ `{pacing_ledger}`; `message_jobs` carries none (**test 22**, tightened to *exactly one* at P13) |
| `db/test/schema-assertions.test.ts` | `enum_parity_db_vs_domain` | every `pg_enum` label set equals its `@wp/domain` union, both directions (**test 23**) |
| `db/test/schema-assertions.test.ts` | `every_new_queue_table_leads_with_client_id_or_is_on_the_exemption_list` | exemption list is exactly the delta's three entries |
| `db/test/schema-assertions.test.ts` | `no_foreign_key_points_at_message_jobs` | zero FKs referencing the partitioned parent |
| `db/test/partitions.test.ts` | `ensure_partitions_creates_current_plus_two_months` | monthly for `message_jobs`, weekly for `delivery_events` |
| `db/test/partitions.test.ts` | `ensure_partitions_is_idempotent_when_rerun` | second run creates nothing and does not throw |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `two_workers_cannot_double_claim_one_job` | 2 concurrent transactions, 1 job → exactly one `RETURNING` row; the loser's whole transaction rolls back (**test 2**) |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `claim_does_not_increment_attempts` | `attempts` byte-identical after a successful claim |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `stale_fence_yields_zero_claims` | `instance_lease_state.current_fence <> $fence` → 0 rows, job still `queued` |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `non_connected_health_state_yields_zero_claims_and_preserves_every_job` | `degraded`/`paused`/`logged_out` → 0 rows, 0 jobs failed or deleted |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `session_epoch_mismatch_yields_zero_claims` | relinked number never sends the old epoch's jobs |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `suspended_client_yields_zero_claims` | `clients.status <> 'active'` → 0 rows |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `missing_wallet_row_yields_zero_claims` | INNER JOIN is fail-closed |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `wallet_empty_stops_claims_and_leaves_every_job_queued` | `state='empty'` → 0 rows; job count/status unchanged; `health_state` untouched |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `a_concurrent_wallet_debit_is_not_blocked_by_a_claim` | `FOR UPDATE OF j` only — no lock taken on `wallet_accounts` |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `claim_orders_by_next_attempt_at_then_id_within_a_band` | oldest eligible job in the requested band wins; another band is never returned |
| `app/backend/src/modules/queue/claim.integration.test.ts` | `another_tenants_job_is_never_returned` | two clients, same instance label → 0 cross-tenant rows |
| `db/test/claim-plan.test.ts` | `claim_plan_uses_message_jobs_claim_idx_and_never_seq_scans` | `EXPLAIN` text contains `message_jobs_claim_idx`, contains no `Seq Scan on message_jobs`, contains no `Sort` |
| `scripts/__tests__/check-single-claim.test.ts` | `a_second_statement_setting_status_processing_fails_the_guard` | guard is red on a planted violation and reports a non-zero matched-file count |

Mandatory-suite tests this phase makes green: **2, 21, 22, 23**.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] `docs/evidence/P03-claim-explain.md` exists and contains verbatim `EXPLAIN (ANALYZE, BUFFERS)` output of the exact statement in `db/queries/claim-jobs.sql`.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `scripts/check-tenant-scope.ts` — E2 fix (post-execution): test files excluded from THIS guard's scan set only (fixtures legitimately seed cross-tenant data; runtime code stays fully scanned); guard was red on the tree, 63 files / 0 violations after
- `scripts/guards/cli-smoke.test.ts` — E2 fix: serial spawnSync -> it.concurrent.each + promisified execFile, same assertions; unit suite 30s -> ~4s
- `db/migrations/0007_message_jobs.sql` — created (P02 ended at 0006, not 0005 — numbers shifted +2)
- `db/migrations/0008_queue_uniqueness_authorities.sql` — created
- `db/migrations/0009_delivery_events.sql` — created
- `db/migrations/0010_claim_join_shells.sql` — created
- `db/schema/message-jobs.ts` — created
- `db/schema/message-job-refs.ts` — created
- `db/schema/message-wa-ids.ts` — created
- `db/schema/delivery-event-ids.ts` — created
- `db/schema/send-attempts.ts` — created
- `db/schema/delivery-events.ts` — created
- `db/schema/whatsapp-instances.ts` — created (join-shell mirror; repo convention mirrors every table)
- `db/schema/instance-lease-state.ts` — created (join-shell mirror)
- `db/schema/campaigns.ts` — created (join-shell mirror)
- `db/schema/custom-types.ts` — changed: `bytea` customType added
- `db/schema/enums.ts` — changed: +4 pgEnum mirrors (broadcast_status, msg_direction, chat_kind, event_type)
- `db/schema/index.ts` — changed: +9 SCHEMA_TABLES entries + barrel exports
- `packages/domain/src/enums/index.ts` — changed: +BROADCAST_STATUSES/MSG_DIRECTIONS/CHAT_KINDS/EVENT_TYPES, +4 PG_ENUMS keys
- `packages/domain/src/index.ts` — changed: barrel exports
- `db/src/partitions.ts` — created (covers message_jobs monthly, delivery_events weekly, wallet_ledger monthly — carried P02 item)
- `db/src/index.ts` — changed: export ensureAllPartitions
- `db/src/isolation/tenant-tables.ts` — changed: +9 TENANT_TABLE_COVERAGE entries
- `db/src/queries.ts` — created
- `db/queries/ensure-partitions.sql` — created
- `db/queries/claim-jobs.sql` — created
- `db/seeds/queue-explain-fixture.sql` — created
- `db/tests/schema-assertions.test.ts` — created (dir is `db/tests/` (plural) — repo convention; phase file's `db/test/` paths corrected throughout this list)
- `db/tests/partitions.test.ts` — changed: +2 P03 cases appended to the existing P02 file
- `db/tests/schema-parity.test.ts` — changed: +smallint/boolean udt_name map entries
- `db/tests/claim-plan.test.ts` — created
- `db/tests/isolation-suite-a.test.ts` — changed: rule consumes CANONICAL_AUTHORITY_KEYS registry; +guard-power test, +every-table-has-a-client_id-leading-index assertion
- `db/src/isolation/tenant-tables.ts` — changed (again, Unit C): +CANONICAL_AUTHORITY_KEYS registry (per-index canon reasons for the 9 tables)
- `db/schema/grants.snapshot.json` — regenerated (deliberate --update; diff reviewed: purely additive, new tables only)
- `scripts/check-tenant-scope.ts` — changed: TENANT_TABLES literal synced (+9, Unit A); .sql files were never actually scanned — added sqlStatementSpans branch (Unit C)
- `scripts/guards/check-tenant-scope.test.ts` — changed: +4 tests for the .sql scanning branch
- `scripts/guards/__fixtures__/tenant-scope/queries.sql` — created (fixture)
- `app/backend/src/modules/queue/queue.repo.ts` — created
- `app/backend/src/modules/queue/index.ts` — created
- `app/backend/src/modules/queue/claim.integration.test.ts` — created
- `scripts/check-single-claim.ts` — created
- `scripts/__tests__/check-single-claim.test.ts` — created
- `scripts/guards/__fixtures__/single-claim/` (bad-second-claim.ts, clean.ts, bad-claim.sql) — created
- `scripts/guards/registry.ts` — changed: check-single-claim registered (guard #16)
- `package.json` — changed: check:single-claim chained into check:tenant-scope (ci-steps.ts already runs that script; no separate ci.ps1/ci.sh edit needed)
- `vitest.config.ts` (root) — changed: *.integration.test.ts excluded from test:unit
- `app/backend/vitest.config.ts` — created (integration-test project config)
- `app/backend/package.json` — changed: test:int script + vitest devDependency
- `app/backend/src/platform/db/db-url.ts` — created (DATABASE_URL resolver)
- `db/src/queries.test.ts` — created (loader unit tests)
- `db/migrations/0011_message_jobs_updated_at.sql` — created (debugger: canon claim/debit SET updated_at; blueprint prose column list omitted convention timestamps)
- `db/migrations/0012_scheduler_column_grants.sql` — created (wp_scheduler column-narrow: SELECT 15 claim-read cols + UPDATE 9 claim-SET cols on message_jobs; narrow SELECT on clients/wallet_accounts; carried P02 item)
- `db/tests/migrate-runner.test.ts` — changed: stale pinned migration-count assertion 6 → 12 (pre-existing drift)
- `scripts/check-sql-lint.ts` — changed (debugger): anchored SET_PATTERN → findSetViolations statement-kind tracker; UPDATE...SET and CREATE FUNCTION/PROCEDURE SET are legitimate, standalone SET still red
- `scripts/guards/check-sql-lint.test.ts` — changed: +3 tests (claim shape passes, SECURITY DEFINER SET search_path passes, post-UPDATE standalone SET fails)
- `scripts/guards/__fixtures__/sql/` (clean-claim-shape.sql, clean-security-definer-set.sql, bad-plain-set-after-update.sql) — created
- `scripts/guards/check-tenant-scope.test.ts` — changed (again, debugger): +3 tests pinning the test-path exemption convention to exactly test files
- `app/backend/src/modules/queue/claim.edge-cases.integration.test.ts` — created (C2: 9 edge probes — crash-rollback residue, replay, boundary <=, drain order, live SKIP LOCKED, epoch both directions, per-instance fence blast radius)
- `db/tests/queue-constraints.test.ts` — created (C2: 5 CHECK/PK boundary probes; provider_event_id global-dedupe intent pinned)
- `db/src/schema-version.ts` — changed (C1 fix: EXPECTED_SCHEMA_VERSION 6 → 12; doc lines for 0007-0012)
- `db/tests/helpers/grants.ts` — changed (C1 fix: weekly-aware partition canonicalizer; columnGrants from role_column_grants)
- `db/tests/helpers/grants.test.ts` — created (canonicalizer unit tests, monthly + weekly)
- `db/tests/grants-snapshot.test.ts` — changed (C1 fix: admin write check unions column-level; wp_scheduler message_jobs column sets pinned to the claim exactly)
- `scripts/guards/scan-config.ts` — changed (C1 fix: GuardResult.filesScanned)
- `scripts/guards/__fixtures__/single-claim/` +bad-lowercase-claim.sql, +bad-parameterized-claim.ts, +bad-drizzle-claim.ts, +clean-drizzle.ts (C1 fix: bypass-path fixtures)
- `scripts/guards/__fixtures__/sql/alter-table-set-storage.sql` — created (note 12 fixture)
- `scripts/guards/__fixtures__/sql/bad-alter-role-set.sql` — created (re-review W1: ALTER ROLE SET stays banned)
- `scripts/guards/__fixtures__/single-claim/` +bad-second-claim-semicolon-in-string.ts, +bad-claim-semicolon-in-comment.sql, +bad-drizzle-claim-nested-object.ts, +bad-drizzle-claim-split-builder.ts (re-review W2/W3 fixtures; clean-drizzle.ts extended)
- `package.json` — changed (again): test:int runs @wp/db AND app-backend integration suites (C1 finding 7)
- `docs/evidence/P03-claim-explain.md` — created
- `app/backend/src/modules/queue/claim.{rls,race,ordering,campaign,eligibility,bounds}.integration.test.ts` — created (wp-2d: claim.integration.test.ts split into six focused files; 49 tests total)
- `app/backend/src/modules/queue/claim.integration.test.ts` — removed (superseded by the six-file split)
- `app/backend/src/modules/queue/__tests__/claim-test-helpers.ts` — created (wp-2d, as claim-test-helpers.ts) then moved under __tests__/ (final C5 fix: file sat outside the tenant-scope guard's test-path exemption — 10 violations; moved + 7 imports fixed)
- `.memory/decisions/0026-tenant-qualified-joins-in-canonical-claim.md` — created (wp-2d)

## Risks / gotchas specific to this phase
- **`inbound_message_ids` is struck.** Blueprint correction item 1 is resolved in the delta (*Conversations and messages*): `message_wa_ids` is the **single** uniqueness authority for both directions, PK `(client_id, instance_id, direction, wa_msg_id)`. Create that final shape here so P21 has nothing to invent and nothing to ALTER. A separate `(instance_id, external_id)` table has no `client_id`, goes red in isolation suite A under RLS FORCE, and creates two authorities for one question. **v1 writes `direction='out'` rows only** — the `direction='in'` half and the two `inbox_*` columns belong to v2's inbox product (ADR 0021).
- **Test 22 is a subset assertion at P03, not an equality one.** `pacing_ledger` does not exist until P13, so write the assertion as "no table other than `pacing_ledger` carries a reserve counter" and leave a comment naming P13 as the phase that tightens it to *exactly one*. Writing it as equality now produces a red test nobody can fix in this session.
- **Partition pruning does not happen in the claim.** There is no `created_at` predicate, so the planner builds an `Append` over every monthly partition. That is accepted (each old partition's partial `WHERE status='queued'` index is near-empty), but the artefact must record how many partitions were actually scanned and the per-partition loop cost — it is the number that decides whether P26 needs empty-partition detachment. Do **not** "fix" it by adding a `created_at` window: that silently strands far-future scheduled jobs.
- **The lock clause is `FOR UPDATE OF j SKIP LOCKED` and stays that way.** An unqualified `FOR UPDATE` row-locks the client's single hot `wallet_accounts` row on every claim from every instance — it serialises the whole workspace and deadlocks against the P18 debit. `a_concurrent_wallet_debit_is_not_blocked_by_a_claim` is the test that keeps it honest.
- **PG 17 only.** `id bigint GENERATED ALWAYS AS IDENTITY` on a partitioned table needs PostgreSQL 17. If the dev box is 16, the failure message is unhelpful — check `server_version_num` first rather than debugging the DDL.
- **Ownership collisions with later phases.** P06 must `ALTER` `instance_lease_state`, P08 `whatsapp_instances`, P23 `campaigns` — never `CREATE`. Write that in the migration header, or two phases will fight over the same table. Equally: `whatsapp_instances` must be created here **without** `current_fence`, `lease_seen_at` and `health_score`, which live in `instance_lease_state` and `instance_pacing_state`.
- **Safety boundary.** The claim is exactly where an evasion mechanism would be smuggled in. No column, parameter or "admin override" may let a caller skip the fence, health, epoch, client-status or wallet predicates; there is no second claim statement and no ORM variant; `ORDER BY priority_weight DESC` (absolute priority) is banned as starvation. Every predicate lives **inside** the UPDATE — checked outside means reject (blueprint review checklist). No tenant-settable field appears on `message_jobs`.
- **Pause must preserve work.** Every zero-claim path in this phase must leave the job row `queued` and untouched — assert row counts and statuses in the negative tests, not just "0 rows returned".
- **If the session clock runs out**, the split line is after Unit B (step 6): `P03a-registrations-and-explain.md` carries steps 7-8 (Units C and D). Add the row to `plan/README.md` and write its next-session prompt instead.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P04 — auth-signup-and-onboarding. Read plan/v1/P04-auth-signup-and-onboarding.md and follow it
exactly: one phase, one session, target 30-45 minutes. Deps P02 (and P03) are done (see plan/README.md).
Do not start P05. Open with SESSION-PROTOCOL O1-O3 (quick gate: `pnpm run typecheck && pnpm run guards:meta`).
Execute the file's Dispatch plan as work units (if the file predates dispatch plans, group its steps into
3-5 units by file cluster first and write the plan in), TDD red-first inside each unit, agent roster per
CLAUDE.md; the main session pastes any canon content into dispatch texts — subagents never open
`.memory/research/**`. Stop at the first red test and dispatch debugger; a unit past ~20 minutes gets
split. Close with SESSION-PROTOCOL C1-C7 (C1 and C2 in parallel; ONE full gate at C5).
```
