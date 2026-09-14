# P30a — plans-admin-routes-and-panels

**Goal (one line):** Staff can CRUD the plan catalogue (create, publish, set default, assign, override entitlements) entirely through the existing `/internal/v1` + `admin/backend` mutation-proxy idiom, tenants see a read-only plan/usage page, and the retention legal copy exists as an approval-gated draft, not a publish.
**Status:** todo (blocked: founder approval of ADR 0050) · **Size:** S · **Session:** 1 of 1
**Depends on:** P28, P19, P29a, P30 (must be `done`)
**Blocks:** the v2 messaging-depth phases P34+ (ADR 0052, in design; P31-P33 retired)

> **Amendment 2026-09-11 evening (ADR 0051):** the inbox is removed from v2, so there is no inbox consumer of the
> retention attribute. Plan attributes STAY (founder: "jo plan wala bola tha wo to admin panel me karna hi hai"); the
> retention attribute applies to message jobs, send attempts and delivery events (published defaults 13 months / 90 days),
> the enforcement job in P30a closes launch-checklist row 17, and the legal draft step describes those tables, not bodies
> or media. Next phase after P30a: P34 (messaging depth).

## Prerequisites (facts, not phases)
- ADR 0050's Status line reads `accepted` in `.memory/decisions/0050-plans-entitlements-and-admin-managed-pricing.md` (this phase must not start before that line reads `accepted`).
- Postgres 17 + Redis up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean on a fresh volume.
- Schema version is **76** at open (P30's migration `0076_plans_versions_and_entitlements.sql` applied) — verify by listing `db/migrations/` and reading `db/src/schema-version.ts`.
- The quick gate (`pnpm run typecheck && pnpm run guards:meta`) is green on the tree as found (SESSION-PROTOCOL O2).
- P30's resolver (`resolveEffectiveEntitlements`), `plan-assignment.service.ts` and the four entitlement gate call sites are landed and green.
- The dev-data reset is agreed by the founder, 2026-09-11 (ADR 0050 "Founder answers" §2) — same precondition as P30, still true.
- **O3: the design is already decided** in ADR 0050 and its design doc §5-§7, §10. Do not run `/feature`; go straight to E1.

## What you are building (3-6 bullets)
- `/internal/v1` route extensions: plan list/create/version/publish/set-default, client plan assignment (with the superadmin `clients.pricing` escalation when the resolved price list changes), client entitlement overrides.
- `admin/backend` routes + mutation specs reusing the P28 `mutation-proxy` + `staff_audit_log` idiom verbatim — no new money action, no new audit mechanism.
- `admin/frontend`: a plans list/editor/version-history screen and a client detail **Plan** tab (assignment history, entitlement overrides, a LINK to the existing wallet-tab credit control — never a duplicate).
- A read-only tenant **Plan & usage** settings page (new `app/frontend/src/features/settings/` directory) — no grant/next-credit line, no upgrade button.
- The retention legal copy DRAFT in `terms.mdx`/`privacy.mdx` (6/12/24 months, amending the now-false "not yet tenant-configurable" sentence), run through `check-copy` and reported as drafted-and-unpublished, never shipped.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| ADR | `.memory/decisions/0050-plans-entitlements-and-admin-managed-pricing.md` | §5-§8 (staff operations, tenant panel surface, migrations note), Founder answers §3 (legal copy) |
| Design doc | `.memory/research/2026-09-11-plans-pricing-admin-design.md` | §5 (routes), §6 (screens, incl. the check-copy constraint), §9 (U4/U5 file scopes), §10 (legal draft, verbatim steps) |
| ADR | `.memory/decisions/0046-inbox-scope-and-retention.md` | §5 (retention consumer, permanence/PITR sentence requirement) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | §9 (manual top-up + minimal staff credit — why no new credit path is built here) |
| Invariants | `.claude/rules/core-invariants.md` | all — **4** (tenant isolation) and **6** (no evasion / no banned claim) especially |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md`, `.claude/rules/api.md` | all |
| v1 precedent (mutation-proxy) | `plan/v1/P28-admin-internal-api-and-panel.md` | steps 4, 6, 7 (the `withStaffMutation` + `platformRead` idiom to copy verbatim) |
| v1 precedent (rbac) | `packages/domain/src/staff/rbac.ts` | `OPS_ACTIONS`/superadmin split — why plan-assignment-changing-price needs `clients.pricing` too |
| v1 module (existing route) | `app/backend/src/modules/internal/routes/clients.ts` | lines 203-236 (today's plan-assign route; only updates `plan_id`, no price-list side effect yet) |
| v1 module (existing route) | `app/backend/src/modules/internal/routes/plans.ts` | line 52 (existing read-only `/internal/v1/plans`, to extend) |
| v1 module (registries) | `admin/backend/src/platform/registered-reads.ts` | the closed allow-list pattern; its lockstep sibling `scripts/registries/cross-tenant-queries-p28-admin*.ts` |
| v1 module (wallet tab) | `admin/frontend/src/features/clients/components/wallet-tab.tsx` | the existing audited credit control to LINK to, never duplicate |
| v1 module (copy guard) | `scripts/guards/scan-config.ts` | lines 47-56 (`SCAN_GLOBS` includes `app/**`/`admin/**`) |
| v1 module (copy guard) | `scripts/check-copy.ts` | lines 26-40, 64-70 (`BROADCAST_DISCLOSURE`/`GROUP_RISK_DISCLOSURE` constants required verbatim wherever "Broadcast"/"Groups" appear capitalised) |
| Legal copy (current) | `website/content/legal/terms.mdx` | line 20 (13-month retention row), line 29 (the sentence to amend) |
| Legal copy (current) | `website/content/legal/privacy.mdx` | lines 22-33 (Retention table — no false sentence to fix here) |

## Dispatch plan
Three work units. U-internal and U-admin touch disjoint backend surfaces but U-admin's mutation specs
consume U-internal's route contracts, so U-admin runs after U-internal; U5 (frontend + legal) is disjoint
from both backend units in file scope and may run in PARALLEL with U-internal, but must start after
U-admin's contracts land if it needs the finalised route shapes — in practice run U-internal then
{U-admin, U5} in parallel (no migration in this phase, so U-admin/U5 parallelism is safe).

| Unit | Agent | Steps | Files (exclusive scope) | Must not touch |
|---|---|---|---|---|
| U-internal | implementer | 1 (backend slice), 2 | `app/backend/src/modules/internal/routes/plans.ts` (extend), `app/backend/src/modules/plans/plan.routes.ts` + route tests (`app/backend/src/modules/internal/routes/plans.integration.test.ts`) | `admin/backend/**`, `admin/frontend/**`, `app/frontend/**`, `website/**` |
| U-admin | implementer | 1 (admin slice), 3 | `admin/backend/src/modules/plans/**`, `admin/backend/src/platform/registered-reads.ts` + `scripts/registries/cross-tenant-queries-p28-admin*.ts` (lockstep pair) + `admin/backend/src/modules/plans/{plans-mutations,plans.read}.integration.test.ts` | `app/backend/**` (consumes U-internal's route contracts only, never redefines them), `admin/frontend/**`, `app/frontend/**`, `website/**` |
| U5 | ui-implementer | 4, 5, 6 | `admin/frontend/src/features/plans/**`, `admin/frontend/src/features/clients/components/plan-tab.tsx`, `admin/frontend/src/features/clients/__tests__/plan-tab.test.tsx`, `app/frontend/src/features/settings/plan-page.tsx` (new directory), `website/content/legal/{terms,privacy}.mdx` (DRAFT ONLY), `website/tests/legal.test.ts` (extend), `scripts/__tests__/i18n-banned-claims.test.ts` (extend) | `app/backend/**`, `admin/backend/**` (consumes U-internal's and U-admin's contracts only, never redefines them) |

## Ordered minimum steps
- [ ] 1. **Write the failing tests first** (all red, none skipped, none `.only`) → `admin/backend/src/modules/plans/plans-mutations.integration.test.ts`, `app/backend/src/modules/internal/routes/plans.integration.test.ts`, `admin/backend/src/modules/plans/plans.read.integration.test.ts`, `admin/frontend/src/features/plans/__tests__/plan-editor.test.tsx`, `app/frontend/src/features/settings/__tests__/plan-page.test.tsx`.
- [ ] 2. **`/internal/v1` route extensions** → `app/backend/src/modules/internal/routes/plans.ts` (extend the existing read-only route with `POST plans`, `POST plans/:planId/versions`, `POST plans/:planId/versions/:versionId/publish`, `POST plans/:planId/default`), `app/backend/src/modules/plans/plan.routes.ts` (tenant `GET /v1/plan`), extend `PUT /internal/v1/clients/:clientId/plan` to take `planVersionId` and require the superadmin `clients.pricing` action in addition to `clients.plan` whenever the assignment changes the resolved `price_list_key` (an ops-only token must be rejected in that case; a token holding both succeeds); add `PUT /internal/v1/clients/:clientId/entitlements`.
- [ ] 3. **`admin/backend` mutation specs + reads** → `admin/backend/src/modules/plans/**` (`GET /admin/v1/plans` → `plans.read`; `POST /admin/v1/plans` → `plans.create`; `POST /admin/v1/plans/:id/versions` → `plans.create`; `POST /admin/v1/plans/:id/versions/:vid/publish` → `plans.publish`; `POST /admin/v1/plans/:id/default` → `plans.set_default`, superadmin; `PUT /admin/v1/clients/:id/plan` → `clients.plan` (+`clients.pricing` conditionally); `PUT /admin/v1/clients/:id/entitlements` → `clients.entitlements`) via `mutation-proxy` (reason 3-500 chars, mandatory `Idempotency-Key`), each producing one `staff_audit_log` row; register every new cross-tenant read in `registered-reads.ts` + its lockstep `scripts/registries/cross-tenant-queries-p28-admin*.ts` sibling.
- [ ] 4. **`admin/frontend` plans screens** → `admin/frontend/src/features/plans/{api.ts,keys.ts,components/{plans-list.tsx,plan-editor.tsx,version-history.tsx}}` (list: key, name, current version, is_default, client count, a "make default" action guarded by `plans.set_default`; editor: limits, a `price_list_key` SELECT over the fixed catalogue, signup credit, low-balance threshold, retention dropdown 6/12/24, entitlement checkboxes; publish as a separate confirmed action with a reason field). Avoid capitalised "Broadcast"/"Groups" in entitlement labels, or ship the `BROADCAST_DISCLOSURE`/`GROUP_RISK_DISCLOSURE` constants verbatim in the same file — `check-copy` fails the unit otherwise.
- [ ] 5. **Client Plan tab + tenant settings page** → `admin/frontend/src/features/clients/components/plan-tab.tsx` (current version, assignment history, entitlement overrides, a LINK to the existing `wallet-tab.tsx` credit control — not a duplicated widget), `app/frontend/src/features/settings/plan-page.tsx` (new feature directory: plan name, limits with current usage, the four prices, retention months, wallet balance — no grant/next-credit line, no upgrade button).
- [ ] 6. **Legal retention copy DRAFT + report, not publish** → `website/content/legal/terms.mdx` (add the bodies/media 6-months-default-12-or-24-on-plans-that-include-it row + the permanence/PITR sentence ADR 0046 §5 requires; amend or remove line 29's now-false "not yet tenant-configurable" sentence), `website/content/legal/privacy.mdx` (add the same retention row; no existing false sentence to fix there). Extend `website/tests/legal.test.ts` with `terms_mdx_no_longer_claims_retention_is_not_tenant_configurable` and extend `scripts/__tests__/i18n-banned-claims.test.ts` to cover the draft, then run both and `scripts/check-copy.ts` against the draft and report them green, stating plainly this proves only "no banned claim" — it does NOT prove the site figure matches the seeded `body_retention_months` (that clause is P31's, not built here). The session report must state the copy is drafted and unpublished; publishing happens only after the founder approves, outside this session.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/modules/internal/routes/plans.integration.test.ts` | `an_ops_token_assigning_a_plan_version_with_a_different_price_list_is_rejected` | 403 without `clients.pricing`; succeeds with both actions |
| `app/backend/src/modules/internal/routes/plans.integration.test.ts` | `an_assignment_between_versions_sharing_a_price_list_stays_ops_only` | ops-only token succeeds when `price_list_key` is unchanged |
| `app/backend/src/modules/internal/routes/plans.integration.test.ts` | `set_default_clears_the_old_flag_and_sets_the_new_one_in_one_transaction` | exactly one `is_default=true` row before and after; concurrent second call raises the existing unique-violation, not a new check |
| `admin/backend/src/modules/plans/plans-mutations.integration.test.ts` | `every_plan_mutation_writes_exactly_one_staff_audit_log_row_with_its_idempotency_key_as_the_replay_authority` | replay of the same `Idempotency-Key` returns the first result, one audit row |
| `admin/backend/src/modules/plans/plans-mutations.integration.test.ts` | `publishing_a_version_with_a_price_list_missing_a_price_key_fails_and_writes_nothing` | validation before any write; no partial version |
| `admin/backend/src/modules/plans/plans.read.integration.test.ts` | `admin_plan_reads_are_registered_in_both_registered_reads_and_the_cross_tenant_registry` | source scan: every new query appears in both lockstep files |
| `admin/backend/src/modules/plans/plans.read.integration.test.ts` | `admin_backend_gains_no_write_grant_from_this_phase` | `wp_admin_app` grant snapshot unchanged by this phase (P30 already proved this; this test guards regression) |
| `admin/frontend/src/features/plans/__tests__/plan-editor.test.tsx` | `entitlement_labels_avoid_capitalised_broadcast_and_groups_or_carry_the_disclosure_constants` | `check-copy` passes on the rendered file |
| `admin/frontend/src/features/plans/__tests__/plan-editor.test.tsx` | `publish_is_a_separate_confirmed_action_requiring_a_reason` | the publish button is disabled with an empty reason, same pattern as P28's mutating controls |
| `admin/frontend/src/features/clients/__tests__/plan-tab.test.tsx` | `the_plan_tab_links_to_the_existing_wallet_credit_control_and_does_not_duplicate_it` | no second "add credit" form rendered; a link/button routes to `wallet-tab.tsx`'s control |
| `app/frontend/src/features/settings/__tests__/plan-page.test.tsx` | `the_tenant_plan_page_shows_no_grant_or_next_credit_line_and_no_upgrade_button` | absence assertions on the rendered page |
| `scripts/__tests__/i18n-banned-claims.test.ts` | `the_draft_retention_copy_passes_check_copy_in_both_locales` (extend) | `check-copy`/banned-claims scan green over the draft `terms.mdx`/`privacy.mdx`, en + hi where applicable |
| `website/tests/legal.test.ts` | `terms_mdx_no_longer_claims_retention_is_not_tenant_configurable` (extend) | line 29's sentence is amended or removed in the draft |

Mandatory-suite tests this phase makes green: none new from the blueprint's numbered tables. This phase closes ADR 0050's staff-operations and tenant-panel-surface sections.

## Definition of done
- [ ] Every step box above is ticked.
- [ ] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [ ] Named tests above exist and pass; no test is skipped or `.only`.
- [ ] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [ ] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [ ] The session report states plainly the legal copy is drafted and NOT published.
- [ ] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `<path>` — created
- `<path>` — changed: <one line>

## Risks / gotchas specific to this phase
- **The 300-line cap is real** in `admin/backend/src/modules/plans/**` and the plan editor component; reclaim lines from descriptive prose only, never from contract/behaviour comments.
- **Unit tests in `app/backend`/`admin/backend` reaching `@wp/server-kit` must import the stub-env module FIRST**; real-infra tests are `*.integration.test.ts`, never bare `*.test.ts`.
- **No test may assert on ambient state** — the set-default concurrency test asserts the unique-violation itself, never a sampled winner.
- **Every new copy string, including the DRAFT legal rows, must pass `check-copy`** in both `en`/`hi` panel surfaces; the plan editor's entitlement checkboxes are the specific trap named in ADR 0050 §7 — capitalised "Broadcast"/"Groups" without the disclosure constants turns the unit red on its first run.
- **`wp_admin_app`'s grant snapshot must still prove zero send-path write grants after this phase** — no route added here may request a write grant; if a mutation "needs" one, it belongs on `wp_app` via `/internal/v1`, never on the admin pool.
- **The pricing page stays contact-us.** No price or capacity figure may reach `website/**`; the legal draft touches only the retention row and the amended sentence, nothing else on the pricing surface.
- **Do not build a second credit path.** The Plan tab links to the existing `wallet-tab.tsx` control; inventing a "plan grant" button or a new money route here contradicts ADR 0050 §4 directly.
- **The `check-copy` retention clause is NOT built in this phase.** Running `check-copy` against the draft proves only "no banned claim" — it cannot prove the site figure matches the seeded `body_retention_months`. Say so explicitly in the session report; the clause is P31's to build.
- **Publishing the legal draft is outside this session.** The founder must approve before `terms.mdx`/`privacy.mdx` ship; this phase's definition of done is the draft + green `check-copy`, not a publish action.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P31 — inbox-schema-and-inbound-capture. Read plan/v2/P31-inbox-schema-and-inbound-capture.md
and follow it exactly: one phase, one session. Deps P21, P23a, P30 (and P30a) are done (see
plan/v2/README.md). Do not start P32.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
P31's preconditions must record: the retention consumer reads resolveEffectiveEntitlements().bodyRetentionMonths
(P30), the check-copy retention clause is new guard work owed by this phase (P30a Consequences), and the
founder's approval of the legal retention draft (P30a) before body retention ships.
```
