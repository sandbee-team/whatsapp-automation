# P30 — plans-versions-and-entitlements

**Goal (one line):** A client's price, limits and entitlements are pinned to one immutable, versioned plan-catalogue row instead of mutable `plan_limits`/config.
**Status:** todo (blocked: founder approval of ADR 0050) · **Size:** M · **Session:** 1 of 1
**Depends on:** P28, P19, P29a (must be `done`)
**Blocks:** the v2 messaging-depth phases P34+ (ADR 0052, in design; P31-P33 retired), P30a

> **Amendment 2026-09-11 evening (ADR 0051):** the inbox is removed from v2, so there is no inbox consumer of the
> retention attribute. Plan attributes STAY (founder: "jo plan wala bola tha wo to admin panel me karna hi hai"); the
> retention attribute applies to message jobs, send attempts and delivery events (published defaults 13 months / 90 days),
> the enforcement job in P30a closes launch-checklist row 17, and the legal draft step describes those tables, not bodies
> or media. Next phase after P30a: P34 (messaging depth).

## Prerequisites (facts, not phases)
- ADR 0050's Status line reads `accepted` in `.memory/decisions/0050-plans-entitlements-and-admin-managed-pricing.md` (this phase must not start before that line reads `accepted`).
- Postgres 17 + Redis up via `infra/compose/docker-compose.dev.yml` (`docker compose up` / project's `pnpm db:migrate` clean on a fresh volume).
- Schema version is **75** at open — verify by listing `db/migrations/` (the highest file is `0075_clients_consent_tos_version.sql`) and by reading `db/src/schema-version.ts`; this phase's migration is the next free number (expected `0076`, but the planner/session must list the directory itself rather than trust this number, per ADR 0050's own migration-number note).
- The quick gate (`pnpm run typecheck && pnpm run guards:meta`) is green on the tree as found (SESSION-PROTOCOL O2).
- The dev-data reset (deleting all current `plans`/`plan_limits`/`client_pricing`/`client_limit_overrides` rows and reseeding) is agreed by the founder, 2026-09-11 (ADR 0050 "Founder answers" §2) — production has never run; if that stops being true before this session executes, STOP and re-open ADR 0050.
- ADR 0048 (scale: 10-15 clients now, 400-500 ever) and ADR 0019 (wallet mechanics, unchanged) accepted.
- **O3: the design is already decided** in ADR 0050 and its design doc. Do not run `/feature`; go straight to E1.

## What you are building (3-6 bullets)
- `plan_versions` (immutable once published, column-scoped `wp_app` grant + trigger) and `plan_entitlements` (closed enum, one row per value) beside the existing `plans`/`plan_limits`/`price_lists`/`client_pricing`; `client_plan_assignments` (tenant, one open row per client) and `client_entitlement_overrides` (tenant) added.
- One migration that resets and reseeds the plan/pricing catalogue in the exact ordered sequence ADR 0050 §8 specifies (release FKs, delete, reseed, re-point surviving clients, re-materialise `max_rate_minor`), because all current rows are disposable dev/test data.
- `resolveEffectiveEntitlements()` — the one resolver for every entitlement decision (override > plan version > fail-closed) — plus a shape-preserving `effective_client_limits` rebuild that keeps `reserve-pacing.sql` behaviourally identical.
- Signup reads its one-time credit and price list from the assigned plan version instead of `SIGNUP_CREDIT_MINOR`/`WALLET_LOW_BALANCE_THRESHOLD_MINOR` config, with the exact same provisioning shape (no refactor onto `creditWalletInTx`).
- The two live admission resolvers (`resolveEffectiveMaxBroadcastRecipients`, `resolveEffectiveMaxContacts`) and four entitlement gate call sites (`broadcasts`, `contacts_import`, `groups`, `webhooks`) move onto `plan_versions`/`plan_entitlements`, byte-identical `COALESCE(override, plan)`/`null`-means-no-plan contracts preserved.
- Four gate-enforced registries updated in lockstep with the migration: `PG_ENUMS`, the Drizzle schema mirror, the grants snapshot, and the tenant-tables isolation registry.
- ADR 0050 §8's two mandated counters — `wp_plan_entitlement_denied_total{entitlement}` (emitted on every `PlanEntitlementDisabledError`) and `wp_plan_version_published_total` (emitted on every successful publish) — registered in `packages/domain/src/obs/metric-inventory-admin.ts` and their real `counter(...)` call sites, satisfying `scripts/check-metric-inventory.ts`'s bidirectional check.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| ADR | `.memory/decisions/0050-plans-entitlements-and-admin-managed-pricing.md` | all (Decision §1-§9, Founder answers, Consequences) |
| Design doc | `.memory/research/2026-09-11-plans-pricing-admin-design.md` | §1-§4, §8-§9 (P30 unit scope), §10 (legal — NOT this phase, P30a) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | §11 (max_rate_minor / low_balance_threshold_minor materialisation) |
| ADR | `.memory/decisions/0015-safe-mode-and-pacing-invariants.md` | pacing/health/window are platform properties, never plan-loosenable |
| ADR | `.memory/decisions/0044-per-message-pricing-and-signup-credit-figures.md` | superseded in direction 2026-09-11; read only for the four price figures this migration reseeds (text 15 / media 25 / group_text 18 / group_media 30 paise) |
| ADR | `.memory/decisions/0048-scale-and-scope-rulings.md` | 400-500 clients ever — sizes every table/index decision |
| Invariants | `.claude/rules/core-invariants.md` | all — **3** (idempotency/immutability at storage) and **4** (tenant isolation) especially |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md`, `.claude/rules/api.md` | all |
| v1 module (signup) | `app/backend/src/modules/identity/signup.service.ts` | lines 161-257 (default-plan read, wallet insert, ledger insert — the shape to mirror, not refactor) |
| v1 module (signup) | `app/backend/src/modules/tenancy/provisioning.repo.ts` | `readDefaultPlanId` (line ~46) → becomes `readDefaultPlanVersion` |
| v1 module (admission) | `app/backend/src/modules/broadcasts/limits.ts` | lines 16-45 (`BroadcastLimitError`, `resolveEffectiveMaxBroadcastRecipients`) |
| v1 module (admission) | `app/backend/src/modules/contacts/contacts-limits.ts` | lines 38-57 (`ContactLimitReachedError`, `resolveEffectiveMaxContacts`) |
| v1 module (pacing view) | `db/migrations/0030_pacing.sql` | lines 361-440 (`effective_client_limits`, the `max_daily_sends` NULL contract) |
| v1 module (wallet) | `app/backend/src/modules/wallet/wallet.repo.ts` | lines 16-37 (`client_pricing` CROSS JOIN — why step 5 of the reset is not optional) |
| v1 module (wallet) | `app/backend/src/modules/wallet/pricing.ts` | lines 59-72 (`materialiseMaxRate`, `UnpricedKeyError`) |
| v1 module (grants precedent) | `db/migrations/0025_message_jobs_result_writer_grants.sql` | line 72 (column-scoped `GRANT UPDATE (...)` idiom to copy for `plan_versions`) |

## Dispatch plan
Three work units. **U1 runs SOLO** (migration + the four gate-enforced registries — never parallel with anything).
U2 runs after U1. U3 runs after U2 (consumes U2's resolver signature and error class). No unit in this phase
is parallel-safe with another; the send-path correctness surface (pricing re-seed, admission resolvers,
immutability trigger) is too load-bearing to risk a composition gap.

| Unit | Agent | Steps | Files (exclusive scope) | Must not touch |
|---|---|---|---|---|
| U1 | db-engineer | 1, 2 | `db/migrations/<next_free>_plans_versions_and_entitlements.sql` (list `db/migrations/` at open to confirm the next free number — expected `0076`, not to be trusted blindly), `db/src/isolation/tenant-tables.ts`, `packages/domain/src/enums/index.ts` (`PG_ENUMS` — both new enums, exact migration label order), `db/schema/tenancy.ts` (Drizzle mirror: `clients.plan_version_id` + four new tables), `db/schema/grants.snapshot.json` (regenerated), `db/tests/{enum-parity,schema-parity,grants-snapshot,isolation-suite-a}.test.ts` (extend), `db/tests/plan-migration-reset.integration.test.ts`, `db/tests/effective-client-limits.integration.test.ts`, `db/tests/plan-version-immutability.integration.test.ts` | `db/queries/claim-jobs.sql`, `db/queries/debit-send.sql`, `db/queries/reserve-pacing.sql` (read-only; the view they subselect changes shape-preservingly, the queries themselves do not) |
| U2 | implementer | 3 | `packages/domain/src/plans/{entitlements,retention}.ts`, `packages/domain/src/staff/rbac.ts` (additive `STAFF_ACTIONS`), `packages/contracts/src/{admin/plans.ts,tenant/plan.ts}`, `app/backend/src/modules/plans/{effective.resolver.ts,plans.repo.ts,index.ts}` + tests, the new `PlanEntitlementDisabledError` + its 409 mapping | `app/backend/src/modules/{broadcasts,contacts,groups,webhooks}/**` (U3 owns the call sites), `app/backend/src/modules/plans/plan-assignment.service.ts` (U3 owns the publish/assign write path) |
| U3 | implementer | 4, 5, 6, 7 | `app/backend/src/modules/plans/plan-assignment.service.ts` + `app/backend/src/modules/plans/{plan-assignment,plan-versioning}.integration.test.ts`, `app/backend/src/modules/identity/{signup.service.ts,auth.routes.ts}`, `app/backend/src/modules/tenancy/provisioning.repo.ts` (`readDefaultPlanVersion`), `app/backend/src/modules/broadcasts/limits.ts`, `app/backend/src/modules/contacts/contacts-limits.ts`, the four entitlement gate call sites under `modules/{broadcasts,contacts,groups,webhooks}/**` + their tests, `packages/domain/src/obs/metric-inventory-admin.ts` (add the two ADR 0050 §8 counters) | U2's resolver signature and error class (consumes only, never changes) |

## Ordered minimum steps
- [ ] 1. **Write the failing tests first** (all red, none skipped, none `.only`) → `db/tests/plan-migration-reset.integration.test.ts`, `db/tests/effective-client-limits.integration.test.ts`, `db/tests/plan-version-immutability.integration.test.ts`, `app/backend/src/modules/plans/effective-resolver.integration.test.ts`, `app/backend/src/modules/identity/__tests__/signup-plan.integration.test.ts` (extend existing), `app/backend/src/modules/plans/plan-default.integration.test.ts`, `app/backend/src/modules/plans/plan-safety.test.ts`, `app/backend/src/modules/plans/plan-versioning.integration.test.ts`, `app/backend/src/modules/plans/plan-assignment.integration.test.ts`, `app/backend/src/modules/broadcasts/plan-entitlement-gate.integration.test.ts` (extend with the counter case).
- [ ] 2. **Migration `<next_free>_plans_versions_and_entitlements.sql` + the four gate-enforced registries** → `db/migrations/<next_free>_plans_versions_and_entitlements.sql` (list `db/migrations/` to confirm the next free number before creating the file), `db/src/isolation/tenant-tables.ts`, `packages/domain/src/enums/index.ts`, `db/schema/tenancy.ts`, `db/schema/grants.snapshot.json`. DDL: `plan_versions` (immutable once published, `plan_versions_current_uq` partial unique index, `body_retention_months CHECK IN (6,12,24) DEFAULT 6`, column-scoped `GRANT UPDATE (status, published_at, superseded_at) ON plan_versions TO wp_app`, `BEFORE UPDATE` trigger rejecting any priced/limit/credit/retention column change once `status='published'`); `plan_entitlements` (closed enum `broadcasts, groups, contacts_import, webhooks, inbox, inbound_capture_staff_allowed`, PK `(plan_version_id, entitlement)`, no `ON DELETE CASCADE`); `client_plan_assignments` (tenant, `cpa_one_open_uq` partial unique index, `CANONICAL_AUTHORITY_KEYS` entry for its surrogate PK); `client_entitlement_overrides` (tenant, PK `(client_id, entitlement)`); `clients.plan_version_id` added. Ordered reset+reseed exactly as ADR 0050 §8 numbers it: (0) release FKs on `clients`/`client_plan_assignments`, (1) delete `client_pricing`/`client_limit_overrides`/`plan_limits`/`plans`, (2) reseed plans + v1 published versions (limits ladder 2,000/20,000/100,000, `price_list_key='default_inr'`, ADR 0044's credit/threshold figures, `body_retention_months=6`, one `plan_entitlements` row per enum value with `inbox`/`inbound_capture_staff_allowed` FALSE), (3) reseed `price_list_items` via `ON CONFLICT (price_list_key, price_key) DO UPDATE`, (4) re-point surviving clients + open one `client_plan_assignments` row each, (5) re-insert `client_pricing` per surviving client AND re-materialise `wallet_accounts.max_rate_minor`/`low_balance_threshold_minor` in the SAME transaction (not optional — ADR 0019 §11). Rebuild `effective_client_limits` as DROP+CREATE (not `CREATE OR REPLACE`) with the byte-identical `(client_id, limit_key, limit_value int)` shape, `LEFT JOIN plan_versions` + `COALESCE(pv.<col>, pl.<col>)`, `max_daily_sends` keeping its `NULL::int` plan-side source, `body_retention_months` riding as an extra `limit_key` row. Grep the diff for hard-coded seeded plan ids from the old catalogue.
- [ ] 3. **Domain + resolver** → `packages/domain/src/plans/entitlements.ts` (`PLAN_ENTITLEMENTS` closed enum export), `packages/domain/src/plans/retention.ts` (`RETENTION_MONTHS_ALLOWED = [6,12,24]`, `DEFAULT = 6`), `packages/domain/src/staff/rbac.ts` (additive `plans.read`/`plans.create`/`plans.publish`/`plans.set_default`/`clients.entitlements`), `packages/contracts/src/admin/plans.ts` + `packages/contracts/src/tenant/plan.ts` (Zod `.strict()`, money as integer-paise decimal strings, no grant fields), `app/backend/src/modules/plans/effective.resolver.ts` exporting `resolveEffectiveEntitlements(tx, clientId): Promise<EffectiveEntitlements | null>` (one query, LEFT JOINs with `expires_at` predicates, `null` = no plan → callers fail closed), `app/backend/src/modules/plans/plans.repo.ts`, the new `PlanEntitlementDisabledError` (409 `{ reason: 'plan_entitlement_disabled', entitlement }`) mapped once in the existing error-mapping layer.
- [ ] 4. **Publish/assign write path** → `app/backend/src/modules/plans/plan-assignment.service.ts`: the ONE function writing both `plan_limits` (on publish) and `clients.plan_id`/`plan_version_id` (on assign) — nothing else writes either; assigning a version writes its `price_list_key` into `client_pricing` and re-materialises `max_rate_minor`/`low_balance_threshold_minor` in the same transaction (ADR 0019 §11); `plans.set_default` as one transaction clearing the old flag and setting the new one (the existing `plans_one_default_uq` index is the arbiter — **do not** re-add the index or `assertExactlyOneDefaultPlan()`, both already ship). A successful publish increments `wp_plan_version_published_total` (registered in `packages/domain/src/obs/metric-inventory-admin.ts`).
- [ ] 5. **Signup reads the plan version** → `app/backend/src/modules/identity/signup.service.ts` (read `plan_versions.signup_credit_minor` + `price_list_key` for the default plan's current published version inside the existing transaction; keep the direct `wallet_accounts` INSERT + hand-written ledger row shape exactly, only the literal source changes; throw `NoDefaultPlanError` on no resolvable version, never a silent default), `app/backend/src/modules/identity/auth.routes.ts` (stop passing `SIGNUP_CREDIT_MINOR`/`WALLET_LOW_BALANCE_THRESHOLD_MINOR` as ctx fields — remove both from the signup path entirely, no fallback), `app/backend/src/modules/tenancy/provisioning.repo.ts` (`readDefaultPlanVersion` replacing `readDefaultPlanId`).
- [ ] 6. **Admission resolvers move to `plan_versions`** → `app/backend/src/modules/broadcasts/limits.ts` (`resolveEffectiveMaxBroadcastRecipients` reads `plan_versions` via `clients.plan_version_id`, `COALESCE(override, plan)` shape and `null`-means-no-plan contract preserved byte-for-byte), `app/backend/src/modules/contacts/contacts-limits.ts` (`resolveEffectiveMaxContacts`, same contract). The three remaining `plan_limits` direct readers (`db/queries/instance-plan-limits.sql`, `modules/internal/routes/plans.ts`, `modules/internal/routes/clients-limits.ts`) are staff/admin READ surfaces and are left unchanged in this phase.
- [ ] 7. **Four entitlement gate call sites** → one `entitlements.<key>` check in broadcast create (`broadcasts`), contacts import admission (`contacts_import`), group send (`groups`), webhook registration (`webhooks`), each throwing `PlanEntitlementDisabledError` on a disabled entitlement and incrementing `wp_plan_entitlement_denied_total{entitlement}` (registered in `packages/domain/src/obs/metric-inventory-admin.ts`). Hot paths (`db/queries/claim-jobs.sql`, `instance-plan-limits.sql`, broadcast pre-flight) are deliberately NOT routed through the resolver in this phase.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/tests/plan-migration-reset.integration.test.ts` | `every_surviving_client_has_one_client_pricing_row_and_a_nonnull_max_rate_after_reset` | after the migration, exactly one `client_pricing` row per surviving client and a non-null `wallet_accounts.max_rate_minor`; a `debit_send` succeeds for one of them |
| `db/tests/plan-migration-reset.integration.test.ts` | `reset_leaves_exactly_one_default_plan_and_one_published_version_each` | `count(*) WHERE is_default = 1`; every plan has exactly one `status='published'` version |
| `app/backend/src/modules/plans/plan-versioning.integration.test.ts` | `publishing_v2_at_a_higher_price_leaves_an_already_pinned_client_on_v1s_exact_paise_value` | publish v2 with a higher price; an existing client's resolved price stays v1's exact paise value (grandfathering) |
| `app/backend/src/modules/plans/plan-assignment.integration.test.ts` | `assigning_a_version_with_a_higher_max_rematerialises_wallet_accounts_max_rate_minor_in_the_same_txn` | assigning a version whose price list has a higher max re-materialises `wallet_accounts.max_rate_minor` in the same transaction to the exact expected value |
| `db/tests/effective-client-limits.integration.test.ts` | `view_shape_is_byte_identical_after_rebuild` | rebuilt `effective_client_limits` still returns exactly `(client_id, limit_key, limit_value)` |
| `db/tests/effective-client-limits.integration.test.ts` | `max_daily_sends_stays_null_when_unset_for_a_client_with_no_plan_version` | `reserve-pacing.sql` behaves identically for `plan_version_id IS NULL` |
| `db/tests/plan-version-immutability.integration.test.ts` | `wp_app_cannot_update_a_priced_column_on_a_published_plan_version` | privilege error on `UPDATE plan_versions SET signup_credit_minor = ...` as `wp_app` when `status='published'` |
| `db/tests/plan-version-immutability.integration.test.ts` | `the_trigger_rejects_a_priced_change_via_the_migrator_path_too` | `BEFORE UPDATE` trigger raises even under the elevated migration role |
| `db/tests/schema-assertions-plan-catalogue.test.ts` | `seeded_default_inr_prices_are_exact` | `price_list_items` for `default_inr` is exactly text 15 / media 25 / group_text 18 / group_media 30 paise — exact values, never bounds |
| `db/tests/isolation-suite-a.test.ts` | `client_plan_assignments_and_client_entitlement_overrides_are_registered_and_forced` | both new tenant tables RLS ENABLE+FORCE, cross-tenant read returns 0 rows |
| `db/tests/grants-snapshot.test.ts` | `wp_admin_app_gained_no_write_grant_from_this_migration` | zero INSERT/UPDATE/DELETE added for `wp_admin_app` on any of the four new tables |
| `db/tests/enum-parity.test.ts` | `plan_version_status_and_plan_entitlement_enums_match_pg_enums_both_directions` | `PG_ENUMS` and the DB enum labels agree, both directions |
| `app/backend/src/modules/plans/effective-resolver.integration.test.ts` | `override_beats_plan_version_beats_fail_closed` | non-expired override wins; expired override falls back to plan; no plan → `null` |
| `app/backend/src/modules/plans/effective-resolver.integration.test.ts` | `a_missing_entitlement_row_resolves_false_never_true` | fail-closed on an unwritten enum value |
| `app/backend/src/modules/plans/plan-default.integration.test.ts` | `setting_a_second_default_in_a_concurrent_txn_raises_unique_violation` | assert the constraint itself, not a sampled winner (two-tenant/concurrency rule) |
| `app/backend/src/modules/identity/__tests__/signup-plan.integration.test.ts` | `signup_credits_exactly_the_plan_versions_signup_credit_minor` | plan version `signup_credit_minor=7777` → wallet balance exactly 7777, one `signup_credit` ledger row |
| `app/backend/src/modules/identity/__tests__/signup-plan.integration.test.ts` | `a_signup_that_fails_after_the_credit_leaves_no_wallet_no_ledger_and_no_client` | replay proven by rollback, not an ext-ref arbiter — a retry allocates a new `clientId` |
| `app/backend/src/modules/plans/plan-safety.test.ts` | `no_plan_versions_column_matches_pacing_or_grant_vocabulary` | no column name matches `/pacing|warmup|daily_cap|hourly_cap|window|health|grant|recurring/`; `PLAN_ENTITLEMENTS` contains no pacing value |
| `app/backend/src/modules/broadcasts/limits.integration.test.ts` | `broadcast_ladder_still_enforces_2000_20000_100000_after_moving_to_plan_versions` | ladder values unchanged, `COALESCE(override, plan)` and `null`-means-no-plan preserved |
| `app/backend/src/modules/contacts/contacts-limits.integration.test.ts` | `contacts_admission_reads_plan_versions_with_the_same_contract` | same as above for `max_contacts` |
| `app/backend/src/modules/broadcasts/plan-entitlement-gate.integration.test.ts` | `a_disabled_broadcasts_entitlement_returns_409_plan_entitlement_disabled` | fail-closed 409 with the exact reason shape |
| `app/backend/src/modules/broadcasts/plan-entitlement-gate.integration.test.ts` | `a_disabled_entitlement_denial_increments_wp_plan_entitlement_denied_total` | counter incremented exactly once with `entitlement` label `broadcasts` |
| `app/backend/src/modules/plans/plan-assignment.integration.test.ts` | `publishing_a_version_increments_wp_plan_version_published_total_exactly_once` | counter incremented exactly once per successful publish |
| `scripts/__tests__/check-metric-inventory.test.ts` | `wp_plan_entitlement_denied_total_and_wp_plan_version_published_total_are_registered_both_directions` (extend if needed) | `check-metric-inventory` passes: inventory entries and call-site registrations agree both ways for both new counters |
| `app/backend/src/modules/plans/plan-entitlement-enum.test.ts` | `inbound_capture_staff_allowed_exists_and_resolves_false_by_default` | enum value present; resolves false; enforcement test explicitly deferred to P31 |

Mandatory-suite tests this phase makes green: none new from the blueprint's numbered tables. This phase makes ADR 0050's own gating tests green (listed above): versioning grandfathers, resolution order, fail-closed, signup-credit-from-plan, exactly-one-default, published-version-immutable, view-shape-preserved, seeded-rates-exact, assign-rematerialises-max-rate, entitlement-and-publish-metrics-registered.

## Definition of done
- [ ] Every step box above is ticked.
- [ ] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [ ] Named tests above exist and pass; no test is skipped or `.only`.
- [ ] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [ ] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [ ] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `<path>` — created
- `<path>` — changed: <one line>

## Risks / gotchas specific to this phase
- **The 300-line cap is real** — `app/backend/src/modules/plans/effective.resolver.ts` and `plan-assignment.service.ts` are new files with a real query + a real transaction each; reclaim lines from descriptive prose only, never from contract comments, before splitting into a sibling module.
- **Unit tests in `app/backend` reaching `@wp/server-kit` must import `modules/realtime/__test-support__/stub-wp-server-kit-env.js` FIRST**, or the whole suite fails to load. Real-infra tests are named `*.integration.test.ts`, never bare `*.test.ts`.
- **No test may assert on ambient state.** The concurrency test for exactly-one-default asserts the unique-violation itself, never a sampled winner across racing clients.
- **Every new copy string, including any DRAFT legal or panel copy touched incidentally in this phase, must pass `check-copy`** — this phase should not need new panel copy (that is P30a's U5), but if any string is added it goes through the scan including Hindi.
- **`wp_admin_app`'s grant snapshot must be regenerated AND still prove zero write grants on any send-path table** — this phase adds four new tables, and the regeneration step must not accidentally widen the admin role beyond SELECT.
- **The pricing page stays contact-us.** `scripts/check-copy.ts` has no price-figure clause and this phase does not add one; no price or capacity figure may reach `website/**`.
- **`client_pricing` re-seed is not optional.** Skipping step 5 of the migration's reset sequence makes every `debit_send` throw `UnpricedKeyError` while `claim-jobs.sql` still admits jobs on a stale `max_rate_minor` — a core-invariant-2 violation, not a convenience gap.
- **Do not re-add `plans_one_default_uq` or `assertExactlyOneDefaultPlan()`.** Both already ship (migration 0070, `assert-db-preconditions.ts:96-120`); re-issuing the index is a duplicate-name SQLSTATE 42P07 that aborts the whole migration.
- **`CREATE OR REPLACE VIEW` cannot add or retype columns** — the `effective_client_limits` rebuild must be DROP+CREATE, not `CREATE OR REPLACE`, or the migration silently fails to add the retention key.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P30a — plans-admin-routes-and-panels. Read plan/v2/P30a-plans-admin-routes-and-panels.md and
follow it exactly: one phase, one session. Dep P30 is done (see plan/v2/README.md). Do not start P31.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
