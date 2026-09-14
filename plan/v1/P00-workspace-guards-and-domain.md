# P00 — workspace-guards-and-domain

**Goal (one line):** The ADR 0014 four-project tree, the pnpm workspace with TS project references, every mechanical guard wired into `scripts/ci`, and `@wp/domain` + `@wp/contracts` exist — before one line of feature code.
**Status:** todo · **Size:** L · **Session:** 1 of 1 (see Size warning)
**Depends on:** — (first phase)
**Blocks:** P01, and transitively every later phase

**Size warning.** This is an L phase with a declared split. If your session is a single 3-4 hour sitting, stop after **step 7** and open `plan/v1/P00a-domain-and-contracts.md` for **steps 8-10** (copy this file, keep steps 1-7 ticked, add the P00a row to `plan/README.md`). Steps 1-7 = tree + guards; steps 8-10 = `@wp/domain` + `check-copy` + `@wp/contracts`. `scripts/ci.ps1` must be green at the end of **either** stopping point — do not stop mid-step.

## Prerequisites (facts, not phases)
- Node 24 LTS and pnpm 10 are installed and on PATH; Docker Desktop is installed (this phase only validates the compose file, it starts no database).
- ADRs 0002, 0013, 0014, 0015, 0016, 0017, 0018, 0019, 0020 are **accepted** (founder delegated; the honest disclosures inside them stay verbatim).
- ADR 0003 holds: **there is no git in this repo and never will be.** Never run `git`/`gh`, never add a hook, workflow or push step. The "Files created or changed this session" list is the diff.
- The repo currently contains only `plan.html`, `MASTER-PLAN.md`, `CLAUDE.md`, `.gitignore`, `.claude/`, `.memory/`, `plan/` and the read-only `demo/`. **Nothing under `demo/` is ever modified, executed or imported.**
- `plan/README.md` P00 row is `todo`.

## What you are building
- The full ADR 0014 tree — `app/{frontend,backend}`, `admin/{frontend,backend}`, `website/`, `packages/*`, `db/`, `infra/`, `scripts/`, `docs/` — as a pnpm workspace with `composite: true` TS project references and **no Turborepo**.
- A **guard registry + meta-assertion**: every guard declares its globs, proves it flags a known bad fixture, and reports a non-zero matched-file count (or a declared `activatesIn` phase). A guard matching zero files is not a guard.
- The guards themselves: dependency-cruiser (incl. **both** `domain-must-be-pure` rules and `roles/api.ts ↛ provider/**`), `no-restricted-syntax` (plain `SET`, `OFFSET` pagination), key-construction lint, `check-tree`, `check-tenant-scope` + the `CROSS_TENANT_QUERIES` registry, `check-send-origin`, `check-copy`.
- `scripts/ci.ps1` + `scripts/ci.sh` driving one shared, ordered step list — the definition of done for every later phase.
- `@wp/domain` (browser-pure): `TIMING`, the job FSM, the retry classifier, the DWRR selector, `BANNED_CLAIMS`, `SAFE_MODE_DISCLAIMER`, `BROADCAST_DISCLOSURE`.
- `@wp/contracts`: the oRPC router skeleton, the error envelope and the error-code → HTTP-status table.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | "Repository & common code architecture" + "Mechanical enforcement" (the guard table and the `scripts/ci` step order) |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | "Lease + fence" — the `TIMING` object and its two ordering invariants |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | "v1 delivery phases" → **V1-P0**, incl. the sequencing note (tenant-scope and send-origin first) |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | "Testing strategy" → mandatory table (test 19 wording) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | "Broadcast design" → the honest paragraph = `BROADCAST_DISCLOSURE`, verbatim |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | "Invariant compliance" → what the guards must eventually prove; "Precedence" |
| Design | `.memory/research/2026-08-25-v1-design-repo-structure.md` | §1.1-1.3 (the tree), §2.1-2.3 (packages, dependency rules, enforcement), §3.1-3.5 |
| Master plan | `MASTER-PLAN.md` | the `SAFE_MODE_DISCLAIMER` block (~line 818) and the `BANNED_CLAIMS` requirement (~line 746, ~line 2634) |
| ADR | `.memory/decisions/0014-repo-structure-shared-packages-and-conventions.md` | all (binding rules 1-6) |
| ADR | `.memory/decisions/0002-tech-stack.md` | §1 only — Node 24, Fastify 5, oRPC, Zod v4, Drizzle, Pino, Vitest. §3/§4 are superseded by ADR 0013/0014 |
| ADR | `.memory/decisions/0003-no-git-no-vcs-linkage.md` | all |
| ADR | `.memory/decisions/0020-phase-session-protocol-and-plan-folder.md` | all |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/api.md`, `.claude/rules/queue-workers.md` | all |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | banned claims + forbidden mechanisms (feeds `BANNED_CLAIMS`) |

## Ordered minimum steps
- [x] 1. Create the workspace root and `@wp/config` → `pnpm-workspace.yaml`, `package.json` (private, `packageManager: pnpm@10`, scripts `ci|lint|typecheck|test|guards`), `.npmrc`, `VERSION`, `CHANGELOG.md`, `packages/config/{package.json,tsconfig.base.json,eslint.config.js,prettier.config.mjs,vitest.base.ts}`. **No `turbo.json`** (blueprint [R-25s]).
- [x] 2. Create the ADR 0014 tree, one real `src/index.ts` per workspace so guard globs have something to match → `app/{frontend,backend}/`, `admin/{frontend,backend}/`, `website/`, `packages/{contracts,domain,server-kit,ui,design-tokens,utils,testkit}/`, `db/{schema,migrations,queries,seeds,src}/`, `infra/{compose,deploy,nginx,observability,backup}/`, `scripts/`, `docs/`; each workspace gets `package.json` + `tsconfig.json` with `composite: true` and the references from repo-structure §2.2; plus `infra/compose/docker-compose.dev.yml` (postgres 17, redis 7, minio, mailpit) and `docs/CONVENTIONS.md`. Root `tsc -b` must pass.
- [x] 3. Build the guard harness and the CI gate → `scripts/guards/registry.ts` (each guard: `name`, `globs`, `run()`, optional `activatesIn: 'P<NN>'`), `scripts/guards/meta.test.ts`, `scripts/guards/__fixtures__/` (excluded from every scan), `scripts/ci-steps.ts` (the one ordered step list), `scripts/ci.ps1`, `scripts/ci.sh`. Order: format → lint → depcruise → domain browser build → guard meta-assertion → tenant-scope → send-origin → copy → typecheck → unit → integration → build.
- [x] 4. Add dependency-cruiser and register it → `.dependency-cruiser.cjs` with `domain-must-be-pure` (**two** rules: core builtins **and** an npm rule blocking `pg|ioredis|redis|drizzle-orm|pino|fastify|@wp/(db|server-kit)`), `no-cross-project`, `frontend-never-server`, `packages-never-apps`, `no-deep-module-import` (`activatesIn: 'P11'`), `api-never-imports-provider` (`activatesIn: 'P08'`).
- [x] 5. Add the lint-level guards → `packages/config/eslint.config.js`: `no-restricted-syntax` for plain `SET` (must be `SET LOCAL`/`set_config(...,true)`) and for `OFFSET` pagination; the key-construction rule (a raw `wp:` literal outside `**/platform/redis/**` is an error); `no-restricted-globals` for `Date.now`/`Math.random` inside `packages/domain`; `max-lines` 300.
- [x] 6. Write the tenant-scope guard → `scripts/check-tenant-scope.ts` + `scripts/registries/cross-tenant-queries.ts` (`CROSS_TENANT_QUERIES`: `file:symbol` → `{ role, reason, projectedColumns }`) + `scripts/check-tree.ts` (top-level folder allow-list = the ADR 0014 tree). Registry starts empty and the guard declares `activatesIn: 'P02'` until the first tenant table exists.
- [x] 7. Write the send-origin guard → `scripts/check-send-origin.ts`: `SYSTEM_REPLY`/`OPT_OUT_CONFIRMATION` may be referenced only under `**/modules/pacing/internal/**`, and **no DTO anywhere accepts `origin` from input** (`activatesIn: 'P14'` for the first clause, fixture-proven now).
- [x] 8. Build `@wp/domain` → `packages/domain/src/{timing.ts,job/state-machine.ts,retry/classify.ts,queue/dwrr.ts,copy/banned-claims.ts,copy/disclosures.ts,index.ts}`; `TIMING` = `leaseTtlMs 30_000 · heartbeatMs 10_000 · takeoverGraceMs 15_000 · watchdogMs 15_000 · sendTimeoutMs 45_000 · claimExpiryMs 90_000 · reaperGraceMs 30_000 · reconcileWindowMs 600_000`; unknown provider error ⇒ `PAUSE_INSTANCE`, never retry; clock and RNG injected. Wire `pnpm -F @wp/domain build:browser` (esbuild `--platform=browser --bundle`) into the CI gate.
- [x] 9. Write the copy guard → `scripts/check-copy.ts` importing `BANNED_CLAIMS` from `@wp/domain`, scanning the whole repo except `demo/`, `.memory/` and `scripts/guards/__fixtures__/`; plus the two co-presence assertions: any surface string containing "Safe Mode" ships `SAFE_MODE_DISCLAIMER`, any surface string containing "Broadcast" ships `BROADCAST_DISCLOSURE`. Both constants are **verbatim** from the sources in the Read-first table.
- [x] 10. Build `@wp/contracts` and close the gate → `packages/contracts/src/{errors.ts,envelope.ts,router.ts,index.ts}` (Zod v4, oRPC skeleton, error code → HTTP status table, no Node builtins), fill `docs/CONVENTIONS.md`, then run `scripts/ci.ps1` end to end and paste the verbatim tail.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `scripts/guards/meta.test.ts` | `every_registered_guard_matches_at_least_one_file` | each registered guard's globs match ≥ 1 real repo file, **or** it declares an `activatesIn` phase that is not yet `done` in `plan/README.md` |
| `scripts/guards/meta.test.ts` | `guard_scan_exclusions_are_exactly_demo_memory_and_fixtures` | the exclusion list cannot be widened to hide a violation |
| `scripts/guards/meta.test.ts` | `ci_ps1_and_ci_sh_run_the_same_ordered_steps` | both scripts read `scripts/ci-steps.ts`; the two gates cannot drift |
| `scripts/guards/depcruise.test.ts` | `domain_importing_pg_or_ioredis_is_rejected` | the **npm** rule fires (a `dependencyTypes:['core']` rule alone never matches an npm package) |
| `scripts/guards/depcruise.test.ts` | `api_role_importing_provider_is_rejected` | fixture form of "the API never sends directly" (invariant 1) |
| `scripts/guards/depcruise.test.ts` | `frontend_importing_server_kit_or_db_is_rejected` | fixture violation is flagged |
| `scripts/guards/depcruise.test.ts` | `app_importing_admin_is_rejected` | fixture violation is flagged |
| `scripts/guards/check-tree.test.ts` | `a_top_level_folder_outside_adr_0014_is_rejected` | SESSION-PROTOCOL C4 "no file outside the tree" becomes mechanical |
| `scripts/guards/check-tenant-scope.test.ts` | `a_tenant_table_query_without_client_id_is_rejected` | fixture query flagged (invariant 4) |
| `scripts/guards/check-tenant-scope.test.ts` | `a_cross_tenant_query_needs_a_registry_entry_with_role_and_reason` | an unregistered exemption fails; a registered one passes |
| `scripts/guards/check-send-origin.test.ts` | `system_reply_origin_outside_pacing_internal_is_rejected` | invariant 6 — no bypass surface |
| `scripts/guards/check-send-origin.test.ts` | `a_dto_accepting_origin_from_input_is_rejected` | no client-settable pacing bypass, ever |
| `scripts/guards/check-copy.test.ts` | `banned_claim_in_english_is_rejected` | "ban-proof" / "guaranteed delivery" / "instant bulk" flagged |
| `scripts/guards/check-copy.test.ts` | `banned_claim_in_hinglish_is_rejected` | "ban nahi hoga", "block nahi hoga", "100% safe" flagged |
| `scripts/guards/check-copy.test.ts` | `safe_mode_string_without_the_disclaimer_is_rejected` | co-presence assertion |
| `scripts/guards/check-copy.test.ts` | `broadcast_string_without_the_disclosure_is_rejected` | `BROADCAST_DISCLOSURE` co-presence assertion |
| `packages/domain/src/timing.test.ts` | `timing_ordering_invariants_hold` | `sendTimeoutMs < claimExpiryMs − reaperGraceMs` and `takeoverGraceMs + leaseTtlMs > watchdogMs` |
| `packages/domain/src/job/state-machine.test.ts` | `job_fsm_rejects_every_undeclared_transition` | only the declared edges exist |
| `packages/domain/src/job/state-machine.test.ts` | `a_terminal_job_never_transitions_again` | invariant 5 in FSM form |
| `packages/domain/src/retry/classify.test.ts` | `an_unknown_provider_error_classifies_as_pause_never_retry` | invariant 2, fail-safe |
| `packages/domain/src/queue/dwrr.test.ts` | `high_flood_does_not_starve_low` | pure-selector half of mandatory test 19: a continuous HIGH stream still yields a NORMAL/LOW throughput floor |
| `packages/domain/tests/purity.test.ts` | `domain_bundles_for_a_browser_target_with_no_node_builtins` | esbuild browser bundle succeeds; shared logic is real, not aspirational |
| `packages/contracts/tests/envelope.test.ts` | `every_error_code_maps_to_exactly_one_http_status` | one error table, no duplicates |
| `packages/contracts/tests/envelope.test.ts` | `the_error_envelope_shape_is_stable` | snapshot of the envelope contract |

Mandatory-suite tests this phase makes green: **none** — the blueprint's gating suite starts at P03. This phase makes the **unit-level half of test 19** (`high_flood_does_not_starve_low`) green in `@wp/domain`; its integration form lands in P11/P13.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green. (13 guards, 16 test files / 104 tests, 12/12 steps.)
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] **Every guard reports a non-zero matched-file count, or a declared `activatesIn` phase** — printed by the meta-assertion step and included in the pasted output.
- [x] `reviewer` verdict recorded: **APPROVED-with-notes** (initial CHANGES-REQUIRED verdict — 2 CRITICAL + 5 MAJOR + 11 minor — fully remediated same session; re-review verified both CRITICALs closed; notes 1/2/4/6 fixed in session, notes 3/5 + findings 10/17 carried forward below).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- expected set; confirm and extend during the session — the reviewer reviews exactly this list -->
- `pnpm-workspace.yaml`, `package.json`, `.npmrc`, `VERSION`, `CHANGELOG.md` — created
- `.prettierignore`, `tsconfig.json` (root solution file), `pnpm-lock.yaml` — created (step 1 additions: prettier must not walk demo/.memory/plan; root `tsc -b` needs a solution file)
- `packages/config/{package.json,tsconfig.base.json,eslint.config.js,prettier.config.mjs,vitest.base.ts}` — created; plus `packages/config/tsconfig.json` (composite build config)
- NOTE (env): system has Node 22/pnpm 9; repo self-pins via `.npmrc` `use-node-version=24.19.0` + `manage-package-manager-versions=true` and `packageManager: pnpm@10.34.5`. Root script `ci` must be run as `pnpm run ci` (bare `pnpm ci` is a reserved pnpm subcommand).
- `app/backend/`, `app/frontend/`, `admin/backend/`, `admin/frontend/`, `website/` — created: `package.json` + `tsconfig.json` + `src/index.ts` each
- `packages/{contracts,domain,server-kit,ui,design-tokens,utils,testkit}/` — created: same three files each
- `db/{schema,migrations,queries,seeds,src}/` — created (placeholders only; no DDL this phase)
- `infra/compose/docker-compose.dev.yml` — created
- `docs/CONVENTIONS.md` — created
- `.dependency-cruiser.cjs` — created
- `scripts/ci-steps.ts`, `scripts/ci.ps1`, `scripts/ci.sh` — created; plus `scripts/guards/meta-assert.ts`, `scripts/tsconfig.json` (standalone, noEmit), root `vitest.config.ts` — created
- `scripts/guards/registry.ts`, `scripts/guards/meta.test.ts`, `scripts/guards/__fixtures__/**` — created
- `scripts/guards/{depcruise,check-tree,check-tenant-scope,check-send-origin,check-copy}.test.ts` — created
- `scripts/{check-tenant-scope.ts,check-send-origin.ts,check-copy.ts,check-tree.ts}` — created
- `scripts/registries/cross-tenant-queries.ts` — created (empty registry, `activatesIn: 'P02'`)
- `scripts/guards/scan-config.ts` — created (debugger fix: leaf module for shared scan constants; breaks registry↔check-* import cycle); `scripts/guards/cli-smoke.test.ts` — created (regression: every guard CLI spawns as its own entry module); `.dependency-cruiser.cjs` gained `no-circular-scripts`
- `packages/domain/src/{timing.ts,job/state-machine.ts,retry/classify.ts,queue/dwrr.ts,copy/banned-claims.ts,copy/disclosures.ts,index.ts}` + their `.test.ts` — created
- `packages/domain/tests/purity.test.ts` — created
- `packages/contracts/src/{errors.ts,envelope.ts,router.ts,index.ts}`, `packages/contracts/tests/envelope.test.ts` (+ `__snapshots__/`) — created (@orpc/contract 1.15.0 + zod 4.4.3; real oRPC contract API)
- `packages/domain/src/ports.ts` — created (Clock/Rng injection ports); `packages/domain/package.json` — esbuild devDep, `build:browser`, `main: ./src/index.ts`, @types/node
- Review-fix additions: `scripts/check-sql-lint.ts` + `scripts/guards/check-sql-lint.test.ts` + `__fixtures__/sql/**` (guard `sql-lint`, activatesIn P02); `__fixtures__/depcruise/**/uses-{server-kit,db}-bare.ts`; `__fixtures__/copy/banned-curly.md`; `__fixtures__/eslint/{lowercase-set-offset,wp-key-concatenation}.ts`; `__fixtures__/send-origin/{system-reply-computed-property,dto-extend-origin}.ts`; `scripts/ci-steps.test.ts`
- Review-fix changes: `.dependency-cruiser.cjs` (bare-specifier alternatives on all boundary rules; no-circular-scripts); every workspace `package.json` `main` → `./src/index.ts` (pinned by test `every_workspace_main_points_at_src`); root `package.json` `"type": "module"` + `typecheck` = `tsc -b && tsc -p scripts/tsconfig.json --noEmit`; domain/contracts tsconfigs include tests/; check-copy smart-quote normalization + TEXT_EXTENSIONS +sql/txt/hbs/csv; check-send-origin exempt clause scans the broad tree; DWRR weight validation (RangeError); classify hard-pause short-circuit (restricted/unknown non-overridable); CROSS_TENANT_QUERIES frozen; compose ports bound to 127.0.0.1; docs/CONVENTIONS.md filled §6.1-6.7
- Deleted: `_debug_lint.mjs` (subagent debris, caught by check-tree on its first live run)
- `plan/README.md` — changed: P00 row → `done` (at C6)
- `.memory/progress/master-plan.md` — changed: rewritten once to drop the duplicated V1-P0..P10 checkbox list and point phase status at `plan/README.md` (ADR 0020 §2)

## Risks / gotchas specific to this phase
- **The zero-file trap is the whole point of the phase.** Several guards (`no-deep-module-import`, `api-never-imports-provider`, `check-tenant-scope`, the pacing clause of `check-send-origin`) have nothing real to match yet. Do **not** create fake source files to satisfy them, and do **not** silently let them pass: give each an `activatesIn: 'P<NN>'` entry plus a fixture test that proves it flags a known violation today.
- **`domain-must-be-pure` needs two rules.** A `dependencyTypes:['core']` rule can never match an npm package (blueprint [R-43]); without the second npm rule, importing `pg` into `@wp/domain` passes CI.
- **`check-copy` fixtures contain banned claims by design.** They must be in the exclusion list, and the exclusion list itself is asserted (`guard_scan_exclusions_are_exactly_demo_memory_and_fixtures`) so nobody later widens it to hide a real violation.
- **Honest-claims boundary.** The only Safe Mode / Broadcast strings created this phase are `SAFE_MODE_DISCLAIMER` and `BROADCAST_DISCLOSURE`, copied verbatim from the sources named above. Write no capacity, throughput, price or "cannot be banned" wording anywhere — every capacity figure in the repo is DERIVED until Gate A (P10) and Gate B (P26), and none may reach a tenant-facing surface before Gate C.
- **Two gates, one list.** `ci.ps1` is the gate on this Windows machine; `ci.sh` exists for the deploy box. Both must read `scripts/ci-steps.ts` — hand-maintained twins drift within two phases and the drift is invisible.
- **TS project references:** `composite: true` everywhere and `pnpm typecheck` = `tsc -b` at the **root**. Per-package `tsc` hides missing references until a much later phase.
- **Deliberately NOT in this phase, carried forward in writing:** the `require-tenant-ctx` eslint rule (needs `TenantContext` → **P01**), the role-grant snapshot test and isolation suite A (need the schema → **P02**), and the `no_forbidden_mechanism_exists` static scan (needs the send/health surfaces → **P16**). If a step is descoped for any other reason, write it here and into the next phase's file — not into someone's head.
- **No git, no CI service, no hooks.** `scripts/ci.ps1` run by a human is the only gate. Do not add `.github/`, a pre-commit hook, or any push-based step.

## Carried forward (descoped/deferred in writing — session close 2026-08-26)
- **→ P01:** reviewer finding 10 — give `check-tree` its own named CI step when the step list is next revised (today it rides the `tenant-scope` step and reports under that name).
- **→ P02:** reviewer finding 17 — upgrade `check-tenant-scope`'s heuristic from per-string-literal to per-SQL-statement (a multi-statement template with one scoped and one unscoped statement passes today); fill `TENANT_TABLES` (tripwire test `tenant_tables_must_be_filled_once_db_schema_exists` fails the build if `db/schema/**/*.{ts,sql}` gains files while the list is empty); `sql-lint` guard activates.
- **→ pre-deploy (P0x):** reviewer note 3 — every workspace `main` is `./src/index.ts` (tsx-runnable, depcruise-resolvable); before shipping a runnable artifact, switch to an `exports` condition map (development → src, import → dist) and re-verify depcruise resolution (test `every_workspace_main_points_at_src` will need the same update).
- **→ P14:** reviewer note 5 — the exempt-origin clause of check-send-origin scans the five source trees and does not strip `/* */` comments; the exempt-origin constants (`SYSTEM_REPLY`, `OPT_OUT_CONFIRMATION`) must live ONLY under `app/backend/src/modules/pacing/internal/` — never in `@wp/domain`/`@wp/contracts` — or the guard fires on their declaration site. This is deliberate strictness, not a guard bug.
- **Accepted limitations (test-documented, do not "fix" silently):** string-concatenation can evade the banned-claims text scan and the `wp:`-key ESLint literal rule (both asserted as accepted limitations in the test suites); DWRR weights validated at construction but only `DEFAULT_BAND_WEIGHTS` exists until a config path arrives.
- **Env note:** machine PATH has Node 22/pnpm 9; the repo self-pins Node 24.19.0 + pnpm 10.34.5 via `.npmrc` (`use-node-version`, `manage-package-manager-versions`) + `packageManager`; `ci.ps1`/`ci.sh` preflight-assert both. First install on a new box needs outbound access to nodejs.org. Bare `pnpm ci` is reserved by pnpm — use `pnpm run ci` or `scripts/ci.ps1`.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P01 — server-kit-and-crypto. Read plan/v1/P01-server-kit-and-crypto.md and follow it exactly:
one phase, one session. Deps P00 are done (see plan/README.md). Do not start P02.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
