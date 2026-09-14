# P02 — db-foundations-and-isolation

**Goal (one line):** The database exists and is *provably* tenant-isolated: canonical enums, tenancy + wallet/pricing tables, the `ROLE=migrate` runner, the boot schema-version assertion, RLS FORCE, four Postgres roles, the grant snapshot and isolation suite A.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Size warning:** this phase sits exactly at the 10-step cap. If your session is a single 3-4 hour sitting, **split before you start**: steps 1-7 stay `P02`; steps 8-10 become `P02a-isolation-suite-a-and-grants` (add that row to `plan/README.md` and make P03 depend on P02a).
**Depends on:** P01 (must be `done`)
**Blocks:** P03, P04

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 are up via `infra/compose/docker-compose.dev.yml`, and the dev database is **empty of application objects** (no `public` tables besides what this phase creates).
- Quick gate green on the tree as you found it: `pnpm run typecheck && pnpm run guards:meta` (SESSION-PROTOCOL **O2**; a red quick gate is the previous session's bug, fix it first). Full `scripts/ci.ps1` at open ONLY if the previous session's C5 evidence is missing.
- P00 created the ADR 0014 tree (`app/backend/src/{roles,platform,modules}`, `db/{schema,migrations,queries,src}`, `packages/domain`), the pnpm workspace, TS project references and all `scripts/check-*.ts` guards including the guard meta-assertion.
- P01 created `@wp/server-kit` (config loader, redacting logger, error mapper, `TenantContext`) and envelope encryption. No table in this phase stores ciphertext, so nothing here calls the crypto.
- ADRs **0002, 0003, 0014, 0017, 0018, 0019, 0020** are accepted. No `/feature` run is needed: the schema for this phase is already decided (SESSION-PROTOCOL **O3**).
- Prices seeded here are **placeholders** (scope delta, open question 1). They are internal-only until the founder sets real numbers.

## What you are building (3-6 bullets)
- One forward-only migration runner (`ROLE=migrate`, advisory-locked, checksummed) plus a boot assertion that every other role refuses to start against a database at the wrong schema version.
- Migrations `0001`-`0005`: extensions + the canonical enum set, tenancy (`plans`, `plan_limits`, `users`, `clients`, `memberships` incl. the one-workspace-per-user index), the monthly-partition helper, wallet + pricing (the tables the P04 signup transaction needs), and RLS + roles + grants.
- Drizzle mirrors in `db/schema/` for exactly the tables created here, with a parity test against `information_schema`.
- The tenant-table registry: coverage set, non-tenant allow-list with reasons, and the **exactly three** suite-A index exemptions.
- Isolation suite A (all-tables inversion, including partitions) and the role-grant snapshot test.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | `## Data model` → *Canonical enums*, *Tenancy*; `## Security, tenant isolation & encryption` → *Isolation, four layers*; `## Testing strategy` → tests 21, 23 |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | `## Schema delta` → conventions, the **isolation suite A exemption list**, the **migration placement rule**, *Tenancy*; `## Wallet and metering` → *Pricing and top-up* |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | §5 (tenancy, the one index) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | §1 (schema), §3 (`frozen` absorbing), §11 (pricing is pricing) |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | `plan_limits.max_connected_instances` semantics (connected is the metered unit) |
| Data design | `.memory/research/2026-08-25-v1-design-data-and-security.md` | §1.2 tenancy columns · §3.4 worker vs RLS · §3.5 the isolation suite |
| Repo structure | `.memory/research/2026-08-25-v1-design-repo-structure.md` | §3.4 process roles · §6.4 migrations |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md` | all |
| Protocol | `plan/SESSION-PROTOCOL.md` | O1-O3, E1-E3, C1-C7 |

## Ordered minimum steps

- [x] 1. **Migration runner + pool.** Forward-only `NNNN_<slug>.sql` runner: `CREATE TABLE IF NOT EXISTS schema_migrations (version int PK, slug text, checksum bytea, applied_at timestamptz)`, `pg_advisory_lock(hashtext('wp:migrate'))` around the whole run, one transaction per file, refuse to run if an already-applied file's checksum changed, and refuse to run any file numbered below `max(version)`. → `db/src/pool.ts`, `db/src/migrate.ts`, `app/backend/src/roles/migrate.ts`, `scripts/db-migrate.ps1`
- [x] 2. **Boot assertions for every non-migrate role.** `EXPECTED_SCHEMA_VERSION` is a compiled constant; on boot assert `max(schema_migrations.version) === EXPECTED_SCHEMA_VERSION` and exit non-zero with a named error otherwise; second assertion (ADR 0019 §1): no `wallet_accounts` row has `max_rate_minor = 0`. Wire both into the role bootstrap. → `db/src/schema-version.ts`, `app/backend/src/platform/db/assert-schema-version.ts`, `app/backend/src/platform/db/assert-db-preconditions.ts`
- [x] 3. **Migration 0001 — extensions and the canonical enum set** (`citext`, `pgcrypto`; enums `job_status`, `job_priority`, `job_kind`, `attempt_state`, `wa_health`, `wa_link_state`, `instance_desired_state`, `pause_reason`, `client_status`, `user_status`, `membership_role`, `client_onboarding_step`, `wallet_state`, `wallet_entry_kind` — labels **lower_snake**, verbatim from the blueprint and the scope delta), mirrored as `as const` arrays + unions in `@wp/domain`. Feature enums (broadcast, chat, contact) are **not** created here — migration placement rule. → `db/migrations/0001_extensions_and_enums.sql`, `db/schema/enums.ts`, `packages/domain/src/enums/index.ts`
- [x] 4. **Migration 0002 — tenancy.** `plans`, `plan_limits` (incl. `max_connected_instances`, `max_registered_instances` default `3 ×` slots, `max_broadcast_recipients` default 20000), `users` (`full_name NOT NULL`, `email citext UNIQUE`, `phone_e164`, `phone_verified_at`, `status`), `clients` (`company_name NOT NULL`, `slug citext UNIQUE`, `status`, `timezone` default `Asia/Kolkata`, `plan_id`, `onboarding_step`, `owner_user_id`, `deleted_at`), `memberships` + **`CREATE UNIQUE INDEX memberships_one_workspace_per_user_uq ON memberships (user_id)`**. `instance_grants` is **not** created (ADR 0017 §5 collapses it out of the default path; scope-delta open question 9). → `db/migrations/0002_tenancy.sql`, `db/schema/tenancy.ts`
- [x] 5. **Migration 0003 — the monthly-partition helper.** `wp_ensure_month_partition(parent regclass, month date)`: creates `<parent>_yYYYYmMM` if absent **and** applies `ENABLE`+`FORCE ROW LEVEL SECURITY` and the tenant policy to the new partition (a partition queried directly does not inherit the parent's policy). Idempotent. P03 reuses it for `message_jobs`. → `db/migrations/0003_partition_helper.sql`
- [x] 6. **Migration 0004 — wallet and pricing** (created here, not in P18 — the signup transaction needs them; scope delta migration placement rule): `price_lists`, `price_list_items` (global), `client_pricing`, `wallet_accounts` (`max_rate_minor bigint NOT NULL CHECK (max_rate_minor > 0)`, **no default**), `wallet_ledger` (`PK (client_id, seq)`, `PARTITION BY RANGE (created_at)`, current + next 2 months via step 5), `wallet_ledger_ext_refs` (non-partitioned `UNIQUE (client_id, external_ref)`). Seed `default_inr` (`text` 15p, `media` 25p, `group_text` 15p, `group_media` 25p) with a `-- PLACEHOLDER: founder sets the real numbers` header comment. All money is `bigint` paise. → `db/migrations/0004_wallet_and_pricing.sql`, `db/schema/wallet.ts`
- [x] 7. **Migration 0005 — RLS, four roles, grants.** For every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY` and one policy `USING`/`WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid)` (`clients` keys on `id`). Roles: `wp_migrator` (DDL only), `wp_app` (no `BYPASSRLS`; **no UPDATE/DELETE on `wallet_ledger` or `wallet_ledger_ext_refs`** — append-only), `wp_scheduler` (narrow SELECT only), `wp_admin_app` (`BYPASSRLS`, SELECT only, writes revoked). Add `withTenant(clientId, fn)` doing `set_config('app.client_id', $1, true)` inside the transaction. → `db/migrations/0005_rls_roles_and_grants.sql`, `db/src/tenant-db.ts`
- [x] 8. **The tenant-table registry.** `TENANT_TABLE_COVERAGE` (table → tenant key column), `ISOLATION_NON_TENANT_TABLES` (each with a non-empty reason: `users`, `plans`, `plan_limits`, `price_lists`, `price_list_items`, `schema_migrations`), `SUITE_A_INDEX_EXEMPTIONS` = **exactly** `campaign_recipients`, `wallet_charge_guards`, `contact_import_errors`, and `SEND_PATH_TABLES`. Plus a pure `checkCoverage(catalogRows, registry)` so the checker is testable without a live hole. → `db/src/isolation/tenant-tables.ts`, `db/src/isolation/coverage.ts`
- [x] 9. **Isolation suite A.** Enumerate `pg_class` `relkind IN ('r','p')` in `public` — **partitions included** — and assert coverage, `rowsecurity` + `forcerowsecurity`, unset-context ⇒ zero rows, cross-tenant SELECT/UPDATE/DELETE ⇒ zero rows, every tenant index leads with `client_id` except the three exemptions, and that every allow-list entry names a table that exists. → `db/tests/isolation-suite-a.test.ts`
- [x] 10. **Role-grant snapshot.** Dump `information_schema.role_table_grants` for the four roles to a checked-in artefact and diff it in a test; assert `wp_app` lacks `BYPASSRLS`, lacks UPDATE/DELETE on the ledger tables, and that `wp_admin_app` has no write grant on any `SEND_PATH_TABLES` entry **that exists**. → `db/schema/grants.snapshot.json`, `db/tests/grants-snapshot.test.ts`

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/tests/migrate-runner.test.ts` | `migrations_apply_in_order_and_are_recorded_with_a_checksum` | `schema_migrations` holds 5 rows, ascending, each with a non-null checksum |
| `db/tests/migrate-runner.test.ts` | `re_running_the_runner_on_a_migrated_database_is_a_no_op` | zero files re-applied, exit 0 (SESSION-PROTOCOL idempotency rule) |
| `db/tests/migrate-runner.test.ts` | `an_edited_applied_migration_fails_the_runner` | checksum drift ⇒ non-zero exit, nothing applied |
| `db/tests/migrate-runner.test.ts` | `two_concurrent_runners_apply_every_migration_exactly_once` | advisory lock serialises; no duplicate `schema_migrations` row, no error |
| `app/backend/src/platform/db/assert-schema-version.test.ts` | `a_role_refuses_to_boot_when_the_database_is_behind_the_expected_version` | throws a named error; process exit is non-zero |
| `app/backend/src/platform/db/assert-db-preconditions.test.ts` | `boot_fails_if_any_wallet_account_has_a_zero_max_rate` | ADR 0019 §1 — the gate must not fail open |
| `db/tests/enum-parity.test.ts` | `enum_parity_db_vs_domain` | every PG enum's label set equals its `@wp/domain` mirror, both directions (**mandatory test 23**) |
| `db/tests/tenancy.test.ts` | `a_second_membership_for_a_user_is_rejected_at_the_database` | unique violation, not an application check (scope delta, Tenancy) |
| `db/tests/tenancy.test.ts` | `dropping_memberships_one_workspace_per_user_uq_breaks_no_test_except_that_one` | the future teams migration is one `DROP INDEX` |
| `db/tests/tenancy.test.ts` | `clients_slug_and_users_email_are_unique_case_insensitively` | `citext` is actually in force |
| `db/tests/partitions.test.ts` | `a_new_month_partition_has_client_id_rls_enabled_and_forced` | direct-to-partition access is not a hole |
| `db/tests/partitions.test.ts` | `ensure_month_partition_is_idempotent` | second call is a no-op, no error |
| `db/tests/partitions.test.ts` | `no_unique_index_on_a_partitioned_table_without_the_partition_key` | schema assertion over every partitioned table (**mandatory test 21**) |
| `db/tests/wallet-schema.test.ts` | `wallet_accounts_max_rate_minor_rejects_zero_and_negative` | `CHECK (> 0)` exists and there is no default |
| `db/tests/wallet-schema.test.ts` | `wallet_ledger_external_ref_uniqueness_lives_on_the_non_partitioned_side_table` | insert-conflict on `wallet_ledger_ext_refs`, not on the partitioned parent |
| `db/tests/wallet-schema.test.ts` | `no_money_column_is_a_floating_point_type` | catalog scan: no `real`/`double precision` anywhere; every `*_minor` is `bigint` |
| `db/tests/schema-parity.test.ts` | `every_drizzle_declared_column_exists_in_the_database_with_the_same_type` | `db/schema/*.ts` mirrors cannot drift from the migrations |
| `db/tests/isolation-suite-a.test.ts` | `every_base_table_and_partition_is_tenant_covered_or_allow_listed_with_a_reason` | the inversion; partitions included |
| `db/tests/isolation-suite-a.test.ts` | `a_table_without_client_id_is_reported_by_the_coverage_checker` | **this is the founder demo**: feed the checker a catalog row for `demo_bad_table` ⇒ one finding |
| `db/tests/isolation-suite-a.test.ts` | `every_tenant_table_has_rowsecurity_and_forcerowsecurity_true` | `FORCE`, not merely `ENABLE` |
| `db/tests/isolation-suite-a.test.ts` | `an_unset_client_context_returns_zero_rows_from_every_tenant_table` | fail-closed; no `|| 'default'` anywhere |
| `db/tests/isolation-suite-a.test.ts` | `tenant_b_cannot_select_update_or_delete_tenant_a_rows` | 0 rows on all three verbs, per tenant table |
| `db/tests/isolation-suite-a.test.ts` | `every_tenant_index_leads_with_client_id_except_the_three_named_exemptions` | index-prefix scan over `pg_index` |
| `db/tests/isolation-suite-a.test.ts` | `the_suite_a_index_exemption_list_is_exactly_three_entries` | the list is `campaign_recipients`, `wallet_charge_guards`, `contact_import_errors` and nothing else |
| `db/tests/isolation-suite-a.test.ts` | `every_allow_listed_non_tenant_table_exists` | a stale allow-list entry is a red build |
| `db/tests/grants-snapshot.test.ts` | `role_table_grants_match_the_checked_in_snapshot` | any silent grant change is a red build |
| `db/tests/grants-snapshot.test.ts` | `wp_app_cannot_update_or_delete_wallet_ledger` | append-only is a grant, not a convention (ADR 0019 §1) |
| `db/tests/grants-snapshot.test.ts` | `wp_app_does_not_have_bypassrls` | `pg_roles.rolbypassrls = false` |
| `db/tests/grants-snapshot.test.ts` | `wp_admin_app_has_no_write_grant_on_any_existing_send_path_table` | parameterised over `SEND_PATH_TABLES ∩ existing` — grows itself in P03/P13 |

Mandatory-suite tests this phase makes green: **23** (`enum_parity_db_vs_domain`, over the enums that exist now — P03 re-asserts it after the queue tables) and **21** (`no_unique_index_on_a_partitioned_table_without_the_partition_key`, over `wallet_ledger` — P03 keeps it green for `message_jobs`). Plus the unnumbered blueprint suites **isolation suite A** and **role-grant snapshot diff**.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] The founder demo was run live: `CREATE TABLE demo_bad_table (id bigint primary key, note text);` → `pnpm -F @wp/db test isolation-suite-a` goes **red** naming `demo_bad_table` → `DROP TABLE demo_bad_table;` → green again. Both outputs pasted into the session log.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed) — verdict recorded in .memory/sessions/2026-08-26-P02-db-foundations-and-isolation.md.
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `infra/compose/docker-compose.dev.yml` — changed: host ports parameterized (`POSTGRES_PORT`/`REDIS_PORT`, defaults unchanged) — this machine's native postgres/redis own 5432/6379; wp dev runs on 55432/56379 via `.secrets/dev.env`
- `.secrets/dev.env` — created (machine-local, never snapshotted): compose credentials + `DATABASE_URL` for dev/test
- `db/src/pool.ts` — created: `createPool()` over pg.Pool; no process.env reads in db/src
- `db/src/migrate.ts` — created: forward-only runner (advisory lock, sha256 checksums, per-file transactions, checksum-drift + below-max refusal, named errors)
- `db/vitest.config.ts` — created: db integration-test project (tests/**, fileParallelism false)
- `db/package.json` — changed: `test` script; deps pg, @types/pg, vitest
- `db/tests/helpers/db-url.ts` — created: admin URL resolver (env → .secrets/dev.env)
- `db/tests/helpers/scratch-db.ts` — created: scratch-database factory for runner tests
- `db/tests/fixtures/migrations-basic/0001_widgets.sql` — created (test fixture)
- `db/tests/fixtures/migrations-basic/0002_gadgets.sql` — created (test fixture)
- `db/tests/migrate-runner.test.ts` — created: 5 cases incl. concurrency + checksum drift
- `app/backend/src/roles/migrate.ts` — created: ROLE=migrate entrypoint (server-kit config loader, exit non-zero on failure)
- `app/backend/package.json` — changed: @types/node devDep
- `app/backend/tsconfig.json` — changed: `"types": ["node"]`
- `scripts/db-migrate.ps1` — created: loads .secrets/dev.env, runs the migrate role
- `package.json` — changed: `test:int` now runs the real db suite (`pnpm -F @wp/db run test`)
- `vitest.config.ts` — changed: db/tests glob removed from the unit suite (integration lives behind `test:int`)
- `db/src/schema-version.ts` — created: `EXPECTED_SCHEMA_VERSION` compiled constant
- `db/src/index.ts` — changed: re-exports pool/migrate/schema-version public API
- `app/backend/src/platform/db/assert-schema-version.ts` — created: fail-closed schema-version boot assertion (named error)
- `app/backend/src/platform/db/assert-db-preconditions.ts` — created: wallet zero-max-rate gate via SECURITY DEFINER count fn (fail-closed) + `assertDbPreconditionsOrExit`
- `app/backend/src/platform/db/assert-schema-version.test.ts` — created (unit, stubbed)
- `app/backend/src/platform/db/assert-db-preconditions.test.ts` — created (unit, stubbed)
- `db/migrations/0001_extensions_and_enums.sql` — created: citext+pgcrypto, the 14 canonical enums (runner slug pattern widened to allow underscores; main session)
- `packages/domain/src/enums/index.ts` — created: as-const label arrays + unions + `PG_ENUMS` manifest (job_status type exported as `PgJobStatus`; FSM's `JobStatus` pre-exists)
- `packages/domain/src/index.ts` — changed: enums re-export
- `db/schema/enums.ts` — created: drizzle pgEnum mirrors deriving labels from @wp/domain
- `db/package.json` — changed: drizzle-orm dep added
- `db/tests/helpers/migrated-db.ts` — created: memoized migrated dev-DB pool for suite files
- `db/tests/enum-parity.test.ts` — created: mandatory test 23, both directions
- `db/src/schema-version.ts` — changed: EXPECTED_SCHEMA_VERSION 0→1 (→ bumped with each later migration this phase; 5 at close)
- `db/migrations/0002_tenancy.sql` — created: plans, plan_limits (CHECKs), users, clients, memberships PK(client_id,user_id) + one-workspace unique index; no instance_grants
- `db/schema/custom-types.ts` — created: citext customType
- `db/schema/tenancy.ts` — created: drizzle mirrors of the 5 tenancy tables
- `db/schema/index.ts` — created: SCHEMA_TABLES parity manifest
- `db/tests/tenancy.test.ts` — created: 3 cases incl. drop-index-in-transaction proof
- `db/tests/schema-parity.test.ts` — created: both-direction drizzle↔DB column/type/nullability parity
- `db/migrations/0003_partition_helper.sql` — created: wp_ensure_month_partition (idempotent, seals partitions with ENABLE+FORCE RLS + tenant_isolation policy)
- `db/tests/partitions.test.ts` — created: 3 cases incl. generic mandatory-test-21 catalog scan
- `db/migrations/0004_wallet_and_pricing.sql` — created: 6 wallet/pricing tables; wallet_ledger PK corrected to (client_id, seq, created_at) — PG requires partition key in unique constraints; (client_id,seq) uniqueness = P18 allocator under account row lock; default_inr placeholder seed
- `db/schema/wallet.ts` — created: drizzle mirrors (bpchar custom type for char(3) parity)
- `db/schema/index.ts` — changed: SCHEMA_TABLES + 6 wallet tables
- `db/tests/wallet-schema.test.ts` — created: 3 cases incl. generic no-float-money catalog scan
- `db/migrations/0005_rls_roles_and_grants.sql` — created: 4 NOLOGIN roles (only wp_admin_app BYPASSRLS), ownership→wp_migrator, ENABLE+FORCE RLS + tenant_isolation on all tenant tables (+ existing partitions), wp_zero_max_rate_wallet_count() SECURITY DEFINER owned by wp_admin_app, explicit grant matrix (wp_app append-only on ledger tables)
- `db/src/tenant-db.ts` — created: createTenantDb().withTenant (UUID-validated, set_config transaction-local)
- `db/tests/tenant-db.test.ts` — created: 4 RLS/grant smoke cases under SET LOCAL ROLE wp_app
- `db/tests/migrate-runner.test.ts` — changed: real-dir case pinned to exactly 5 migrations
- `db/src/isolation/tenant-tables.ts` — created: TENANT_TABLE_COVERAGE, ISOLATION_NON_TENANT_TABLES (reasons), SUITE_A_INDEX_EXEMPTIONS (exactly 3), GLOBAL_UNIQUE_INDEXES (named-with-reason secondary global uniques), SEND_PATH_TABLES
- `db/src/isolation/coverage.ts` — created: pure checkCoverage + checkAllowListExists
- `db/src/isolation/coverage.test.ts` — created (unit)
- `db/src/isolation/tenant-tables.test.ts` — created: text-based sync test vs check-tenant-scope's literal list (cross-project TS import breaks both tsconfigs' rootDir)
- `scripts/check-tenant-scope.ts` — changed: TENANT_TABLES populated (guard active: 77 files, 0 violations)
- `scripts/guards/registry.ts` — changed: tenant-scope entry's stale activatesIn removed
- `scripts/check-tree.ts` — changed: db/ allow-list gains tests/ + vitest.config.ts (P02 structure; main session — fixed the red check-tree/cli-smoke guard tests caused by step 1's wiring)
- `db/tests/isolation-suite-a.test.ts` — created: the 8 suite-A cases (live inversion incl. partitions, RLS FORCE flags, unset-context fail-closed, cross-tenant 3-verb probes, index-prefix rule, exactly-3 exemption list, allow-list existence)
- `db/tests/helpers/grants.ts` — created: canonical grant dump + partition-name canonicalization (`_yNNNNmNN`)
- `db/tests/grants-snapshot.test.ts` — created: 4 cases (snapshot diff, ledger append-only grants, BYPASSRLS matrix, admin-no-write on existing SEND_PATH_TABLES — non-vacuous)
- `db/schema/grants.snapshot.json` — created: checked-in canonical grant snapshot (update via vitest --update after an intentional grant migration)
- `packages/domain/src/enums/consistency.test.ts` — created (E3): FSM JobStatus ↔ PG_ENUMS.job_status drift guard
- `db/tests/tenant-db-edge.test.ts` — created (E3): context-leak, interleaved tenants, rollback-on-throw, cross-tenant INSERT WITH CHECK
- `db/tests/tenancy.test.ts` — changed (E3): concurrent second-membership race case appended
- `db/tests/migrate-runner.test.ts` — changed (E3): mid-file-failure/recovery case + fixtures `db/tests/fixtures/migrate-mid-file-failure/0001_ok.sql`, `0002_mid_file_bad.sql`
- `db/migrations/0006_definer_hardening_and_grant_narrowing.sql` — created (C1 fixes M2/M4): boot-gate fn recreated with pinned `search_path` (mid-line SET clause, sql-lint-safe) + re-owned wp_admin_app; wp_app loses UPDATE/DELETE on client_pricing and DELETE on clients. EXPECTED_SCHEMA_VERSION → 6; migrate-runner pin → 6 (deviation from the spec's "5 migrations": review-driven hardening, forward-only rule kept absolute)
- `db/tests/helpers/grants.ts` — changed (C1 M1): canonical dump gains a pg_proc `functions` section (prosecdef/owner/proconfig)
- `db/tests/grants-snapshot.test.ts` — changed (C1 M1): boot-gate definer/owner/search_path pinning case
- `db/schema/grants.snapshot.json` — regenerated deliberately (0006 revokes + functions section)
- `.prettierignore` — changed: grants.snapshot.json excluded (machine-written; prettier array style conflicts with the snapshot serializer)
- `db/src/isolation/tenant-tables.ts` — changed (C1 M7): SEND_PATH_TABLES → 16 (adds whatsapp_instances, campaigns, campaign_recipients, outbox_events)
- `db/src/isolation/coverage.ts` + `coverage.test.ts` — changed (C1 N16): checkCoverageTablesExist (stale coverage entry = red)
- `db/src/tenant-db.ts` — changed (C1 N8): rollback failure never masks the original error; failed transactions destroy the pooled client
- `db/tests/isolation-suite-a.test.ts` — changed (C1 M3/N10/N11/N13): waiver-list exactly-two pin, zero-rows branch ≥6 parents, expression-index LEFT JOIN violation, exemption skip unique-only
- `db/tests/tenancy.test.ts` — changed (C1 N12): TRUNCATE CASCADE replaced with id-scoped deletes
- `app/backend/src/platform/db/assert-db-preconditions.ts` (+test) — changed (C1 N9): non-finite count fails closed
- `scripts/check-sql-lint.ts` + `scripts/guards/registry.ts` — changed (C1 N15): stale activatesIn/doc updated; role-boot guard registered
- `scripts/check-tree.ts` (+ `scripts/guards/check-tree.test.ts`) — changed (C1 M6): emitted-artifact deny scan under scripts/ (excl. __fixtures__/.mjs); 12 stale tsc artifacts deleted (check-tenant-scope.*, scan-config.*, cross-tenant-queries.*)
- `scripts/check-role-boot.ts` (+ `scripts/check-role-boot.test.ts`) — created (C1 M5): non-migrate role entrypoints must call the boot gate (activatesIn P04); wired into check:tenant-scope chain
- `package.json` — changed: check:tenant-scope chain += check-role-boot
- `db/src/tenant-db.ts` — changed (C1 N20): successful ROLLBACK returns the client to the pool; only rollback failure destroys it
- `db/tests/tenant-db-edge.test.ts` — changed (C1 N21): 2 fake-client rollback-path cases
- `db/tests/isolation-suite-a.test.ts` — changed (C1 N22): write-probe RLS-branch floor (≥4) so grant narrowing can't make it vacuous
- `app/backend/src/platform/db/assert-db-preconditions.ts` (+test) — changed (C1 N23): empty row / NULL count fail closed
- `db/src/isolation/tenant-tables.ts`, `scripts/check-sql-lint.ts` — changed (C1 N24): comment/doc corrections
- `docs/CONVENTIONS.md` — changed (C1 N24a): SECURITY DEFINER house rules section (0006 left byte-identical — applied migrations immutable)
- `scripts/check-role-boot.ts` (+test) — changed (C1 N25): recursive roles/** glob; exact-path migrate.ts exemption
- `db/tests/partitions.test.ts` — changed (C2): 2 month-boundary routing tests (inclusive FROM / exclusive TO at the exact boundary instant; absolute-instant vs calendar-text routing)

## Risks / gotchas specific to this phase
- **`current_setting('app.client_id', true)` returns `''`, not NULL, if the setting was ever set to an empty string in the session — and `''::uuid` raises.** Every policy uses `nullif(current_setting('app.client_id', true), '')::uuid`. A policy that throws instead of returning zero rows is a fail-open bug disguised as an error.
- **A partition queried directly does not use the parent's RLS policy.** `wp_ensure_month_partition` must apply `ENABLE`+`FORCE`+policy to each new partition, and suite A must enumerate `relkind IN ('r','p')`. Skipping this is a silent cross-tenant hole that no other test catches.
- **`FORCE` matters, `ENABLE` alone does not** for a table owner. `wp_migrator` owns the tables; without `FORCE` the app role's inherited paths can read everything. Assert both catalog flags.
- **`wallet_ledger` append-only is a GRANT, not a code habit.** If `wp_app` gets `UPDATE`/`DELETE` "just for the tests", the money invariant is gone and only the snapshot test would have caught it.
- **`max_rate_minor` must have no default.** With `DEFAULT 0` the claim predicate `balance_minor >= max_rate_minor` is always true and the wallet can never reach `empty` — the gate fails *open* while its test passes (ADR 0019 §1). Keep `CHECK (> 0)` plus the boot assertion.
- **Seeded prices are placeholders.** They may not reach any tenant-facing surface before the founder sets real numbers (scope delta, open question 1); pricing copy is owned by P18/P23/P29 and is subject to `scripts/check-copy.ts`.
- **Guard meta-assertion.** After this phase `scripts/check-tenant-scope.ts` finally has real tables to scan — confirm it reports a non-zero matched-file count (SESSION-PROTOCOL C4), otherwise it is an inert guard.
- **Do not create feature tables early.** `message_jobs`, `campaigns`, `contacts`, `chats`, `wallet_charge_guards` belong to their own phases (migration placement rule). The only exception in v1 is the wallet/pricing set in step 6, and it exists solely because the P04 signup transaction needs it.
- Safety boundary: nothing in this phase touches pacing, health or resume. If a step tempts you to add a "skip limits" column or a tenant-settable knob, stop — that is a forbidden mechanism (`.claude/skills/safety-compliance/SKILL.md`).
- NOTE (recorded at close): the phase spec said migrations 0001-0005; the C1 review added a sixth (0006_definer_hardening_and_grant_narrowing) rather than editing applied migrations — forward-only rule kept absolute.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P03 — db-queue-and-claim. Read plan/v1/P03-db-queue-and-claim.md and follow it exactly:
one phase, one session, target 30-45 minutes. Deps P02 are done (see plan/README.md). Do not start P04.
Open with SESSION-PROTOCOL O1-O3 (quick gate: `pnpm run typecheck && pnpm run guards:meta`; O3 is
pre-answered in the file: skip it). Execute the file's Dispatch plan: 4 work-unit dispatches, serial order
A -> (B || C) -> D, TDD red-first inside each unit, using the agent roster in CLAUDE.md. Paste the merged
claim SQL from the delta verbatim into Unit B's dispatch text — subagents never open `.memory/research/**`.
Stop at the first red test and dispatch debugger; a unit running past ~20 minutes gets split, never ground
through. Close with SESSION-PROTOCOL C1-C7 (C1 and C2 fire in parallel; ONE full gate at C5).
```
