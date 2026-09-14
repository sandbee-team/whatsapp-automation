# P35 — templates-personalisation-scheduling-and-resend

**Goal (one line):** Saved message templates, per-campaign default variable values, server-side single-send personalisation, two additive plan entitlements, cron-promoted scheduled broadcasts, a charged test-send and resend-to-failed-as-a-new-campaign all exist on top of P34's media pipeline and its `media_messages` entitlement.
**Status:** todo (blocked: founder approval of ADR 0052; P30a done)
**Size:** M · **Session:** 1 of 1
**Depends on:** P34, P30a (must be `done`)
**Blocks:** P36

## Prerequisites (facts, not phases)
- ADR 0052 accepted (founder). ADR 0050/0051 accepted; P30a done so entitlements and prices come from plan versions.
- Postgres 17 + Redis up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean on a fresh volume; quick gate `pnpm run typecheck && pnpm run guards:meta` green on the tree as found (SESSION-PROTOCOL O2).
- `db/migrations/` is **listed at session open** and the next free 4-digit number is taken — do not assume a number; P34 will have consumed at least two.
- P34 landed: the closed message-kind payload contracts, `media_assets` (incl. `last_used_at` stamped at dispatch), the object-store `'media'` kind, the exhaustive transport switch, the template-derived `content_fingerprint` writer, the kind-aware `extractBody` in both guard sites, and the `media_messages` plan entitlement (gating `POST /v1/media` already, since P34 §8) — this phase does **not** re-add it.
- `plan_entitlement` is a closed additive enum (ADR 0050 §2); this phase adds the remaining **two** values (`message_templates`, `scheduled_sends`) in their own migration, never in the same transaction as anything that reads them.

## What you are building (3-6 bullets)
- `message_templates` module ("Saved messages"): CRUD, workspace-scoped, count-limited by `plan_versions.max_message_templates` (seeded 25), templates are **copied, not referenced** into a campaign/single-send at use time.
- Single-send screen parity: the same kind picker and variable engine as broadcast, with server-side variable resolution from the recipient's own `contacts` row (no caller-supplied `variables` map — struck on safety grounds).
- Per-campaign default variable values (`campaigns.default_var_values`) applied inside `freezeVars` before the skip decision, so a blank `{{name}}` falls back instead of silently dropping the contact.
- Two additive `plan_entitlement` values (`message_templates`, `scheduled_sends`; `media_messages` already landed in P34) across two sequential migrations (enum values only, then the limit column + seed rows), respecting `plan_versions`' immutable-once-published trigger.
- Scheduled-broadcast promotion: a cron loop promotes `scheduled → snapshotting` at `scheduled_at`, snapshotting the audience at **promotion** time, not create time.
- Resend-to-failed as a brand-new campaign over the failed subset (never a re-queue of terminal jobs) plus a per-recipient CSV export.
- Test-send: `POST /v1/broadcasts/:id/test-send` dispatches one ordinary durable job with `send_origin='test'`, recipient forced to `selfJid()`, charged at the normal rate, rate-limited to 5 per campaign per hour (ADR 0052 §5.1).

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Design doc | `.memory/research/2026-09-11-messaging-depth-and-simple-broadcast-design.md` | §6, §8, §10 (P35 unit table) |
| ADR | `.memory/decisions/0052-messaging-depth-and-simple-broadcast.md` | §3, §4, §5.2, §5.3, §8 |
| ADR | `.memory/decisions/0050-plans-entitlements-and-admin-managed-pricing.md` | §1 (immutability trigger), §2, §3 |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | broadcast engine invariants (unchanged) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | debit-at-ack, no refund without a charge |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md`, `.claude/rules/api.md` | all |
| v1 module (vars) | `packages/domain/src/broadcast/vars.ts` | `freezeVars`/`renderVars`/`missingVarSkipReason` |
| v1 module (snapshot) | `app/backend/src/modules/broadcasts/{snapshot.repo,snapshot.worker}.ts` | audience snapshot mechanics |
| v1 module (lifecycle) | `app/backend/src/modules/broadcasts/lifecycle.service.ts` | state transitions this phase extends |
| v1 module (cron) | `app/backend/src/engine/cron/cron-wiring-broadcasts.ts`, `engine/cron/single-flight.ts` | the loop idiom to copy |
| v1 module (messages) | `app/backend/src/modules/messages/messages.service.ts` | single-send path this phase widens |
| P34 phase file | `plan/v2/P34-message-kinds-and-media-pipeline.md` | Files created or changed (what actually landed) |

## Dispatch plan
5 units. U1a and U1b are migrations, run alone, sequentially. U2 and U3 run in parallel (disjoint scopes: templates module / messages-service + vars). U4 and U5 run after U1b, in parallel with each other.

| Unit | Agent | File scope | Parallel |
|---|---|---|---|
| U1a MIGRATION enum values only | db-engineer | `db/migrations/00NN_plan_entitlement_messaging_values.sql` (the two `ALTER TYPE plan_entitlement ADD VALUE` — `message_templates`, `scheduled_sends` — and nothing else; `media_messages` already landed in P34), `packages/domain/src/plans/*` enum mirror | none |
| U1b MIGRATION limit column + seed rows | db-engineer | `db/migrations/00NN_plan_entitlements_messaging_seed.sql` (`max_message_templates int NOT NULL DEFAULT 25`, the `plan_entitlements` seed rows per existing version for `message_templates`/`scheduled_sends`, the published-version trigger's protected-column list), `db/schema/grants.snapshot.json`, the four registries | none, after U1a |
| U2 templates module | implementer | `app/backend/src/modules/message-templates/**`, `packages/contracts/src/app/message-templates.ts` | ‖ U3 |
| U3 single-send parity + server-side vars | implementer | `app/backend/src/modules/messages/{messages.service,messages.routes}.ts` (split a sibling if it crosses 300 lines), caption-vars + `default_var_values` wiring in `modules/broadcasts/snapshot*.ts` and `packages/domain/src/broadcast/vars.ts` | ‖ U2 |
| U4 scheduling promotion | implementer | `modules/broadcasts/schedule.sweep.ts`, `lifecycle.service.ts`, `engine/cron/cron-wiring-broadcasts.ts`, `engine/cron/single-flight.ts` | after U1b |
| U5 resend-failed + export + media retention + test-send | implementer | `modules/broadcasts/{resend-failed,export,test-send}.ts`, `modules/media/media-retention.ts` (row-driven, injected clock + `batchLimit` + injected `listClientIds`, `NOT EXISTS (message_templates ...)` exclusion), `broadcasts.routes.ts` (incl. `POST /v1/broadcasts/:id/test-send`) | after U1b |

## Ordered minimum steps
- [ ] 1. List `db/migrations/` and confirm the next free number; add the two `ALTER TYPE plan_entitlement ADD VALUE` statements (`message_templates`, `scheduled_sends`) and nothing else → `db/migrations/00NN_plan_entitlement_messaging_values.sql`.
- [ ] 2. Add `max_message_templates` column + backfill + `plan_entitlements` seed rows for `message_templates`/`scheduled_sends` (ON for every existing version) + the protected-column list on the immutability trigger + regenerated grants snapshot → `db/migrations/00NN_plan_entitlements_messaging_seed.sql`.
- [ ] 3. `message_templates` CRUD module: create/list/patch/delete, unique-per-client name (case-insensitive), template copied (not referenced) into a campaign/single-send at use time → `app/backend/src/modules/message-templates/**`.
- [ ] 4. Single-send server-side variable resolution against the recipient's own `contacts` row (no caller-supplied `variables` map); an unresolvable token is `400`, and a recipient with no contact row can only send a token-free body → `messages.service.ts`.
- [ ] 5. `campaigns.default_var_values` applied inside `freezeVars` before the skip decision; skip retained only where no default is configured → `packages/domain/src/broadcast/vars.ts`, snapshot wiring.
- [ ] 6. Scheduling: cron loop promotes `scheduled → snapshotting` at `scheduled_at`; snapshot taken at promotion, not create; single-flight locked → `modules/broadcasts/schedule.sweep.ts`, `lifecycle.service.ts`.
- [ ] 7. Resend-to-failed: `POST /v1/broadcasts/:id/resend-failed` creates a new campaign over the source's `failed` subset with `parent_campaign_id`, fresh idempotency key, fresh pre-flight — zero terminal jobs re-queued → `modules/broadcasts/resend-failed.ts`.
- [ ] 8. Export: `GET /v1/broadcasts/:id/export` streams a per-recipient CSV through the existing contacts-export idiom → `modules/broadcasts/export.ts`.
- [ ] 9. Media retention sweeper: 90-day sweep off `last_used_at`, row-driven and bounded per client (injected clock, `batchLimit`, injected `listClientIds`), excluding template-referenced assets → `modules/media/media-retention.ts`.
- [ ] 10. Test-send: `POST /v1/broadcasts/:id/test-send` enqueues one ordinary durable job with `send_origin='test'`, recipient forced to `selfJid()` (no input field), charged at the normal rate, rate-limited to 5 per campaign per hour → `modules/broadcasts/test-send.ts`, `broadcasts.routes.ts`.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/tests/plan-entitlements-messaging.test.ts` | `seeding_an_ON_entitlement_on_a_published_version_changes_no_price_or_limit` | backfill widens only; no priced column changes |
| `app/backend/src/modules/message-templates/message-templates.integration.test.ts` | `a_template_name_is_unique_per_client_case_insensitively` | unique index enforcement |
| `app/backend/src/modules/message-templates/message-templates.integration.test.ts` | `editing_a_template_does_not_change_an_in_flight_campaign` | freeze-on-copy: template edit after use leaves the historical campaign body unchanged |
| `app/backend/src/modules/message-templates/message-templates.integration.test.ts` | `a_disabled_message_templates_entitlement_returns_409_and_creates_no_template` | `PlanEntitlementDisabledError` → 409, zero template rows (the `media_messages` version of this test is P34's) |
| `app/backend/src/modules/messages/messages.service.integration.test.ts` | `a_caption_renders_its_variables_and_a_missing_var_skips_the_recipient` | single-send caption/body variable resolution parity |
| `app/backend/src/modules/messages/messages.service.integration.test.ts` | `a_single_send_with_an_unresolvable_token_is_400_and_creates_no_job` | 400 returned, zero `message_jobs` rows; sibling case: a recipient with no contact row accepts only a token-free body |
| `app/backend/src/modules/broadcasts/vars.integration.test.ts` | `a_contact_with_a_blank_name_receives_the_default_instead_of_being_skipped` | `default_var_values` fallback applied before skip |
| `app/backend/src/modules/broadcasts/vars.integration.test.ts` | `a_token_with_no_default_still_skips_the_recipient` | fail-closed behaviour preserved for undefaulted tokens |
| `packages/domain/src/broadcast/vars.test.ts` | `caller_supplied_variables_cannot_split_the_fanout_fingerprint` | no caller-supplied value can vary the stored fingerprint |
| `app/backend/src/modules/broadcasts/schedule.sweep.integration.test.ts` | `a_scheduled_campaign_snapshots_at_promotion_not_at_create` | audience membership evaluated at promotion time |
| `app/backend/src/modules/broadcasts/schedule.sweep.integration.test.ts` | `a_scheduled_campaign_into_a_closed_window_waits_and_loses_nothing` | window respected, no job loss, no failure |
| `app/backend/src/modules/broadcasts/schedule.sweep.integration.test.ts` | `a_campaign_scheduled_into_a_closed_window_claims_nothing_and_loses_nothing` | zero claims during the closed window, zero stranded rows |
| `app/backend/src/modules/broadcasts/resend-failed.integration.test.ts` | `resend_to_failed_creates_a_new_campaign_and_requeues_no_terminal_job` | new campaign row, `parent_campaign_id` set, zero re-queued terminal jobs |
| `app/backend/src/modules/media/media-retention.integration.test.ts` | `a_media_asset_referenced_by_a_template_is_never_purged` | `NOT EXISTS (message_templates ...)` exclusion holds |
| `app/backend/src/modules/media/media-retention.integration.test.ts` | `a_purged_media_asset_fails_terminal_and_never_sends_a_fallback` | dispatch of a purged asset fails terminal `invalid_payload` |
| `app/backend/src/modules/broadcasts/test-send.integration.test.ts` | `a_test_send_is_charged_and_obeys_the_window_and_cap` | charged normal rate, subject to window/cap |
| `app/backend/src/modules/broadcasts/test-send.integration.test.ts` | `a_test_send_to_any_number_other_than_the_instances_own_is_rejected` | only `selfJid()` is a legal recipient |

Mandatory-suite tests this phase makes green: none from the v1 numbered tables (a v2 phase); the ADR 0052 §9 named test list is this phase's own gate for the items not covered by P34.

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
- **`max-lines: 300` is real** — `messages.service.ts` is named for a possible sibling split up front; check with `wc -l` before reporting green.
- **Every `app/backend` unit test whose import chain reaches `@wp/server-kit` must import the stub-env module first**, or the whole suite fails to load.
- **No ambient-state assertions** — the cron promotion timing and retention sweep batching must be driven by an injected clock, never a wall-clock margin.
- **`ALTER TYPE ... ADD VALUE` never shares a transaction with a statement reading the new value** — U1a is enum values only; U1b runs strictly after it.
- **`plan_versions` is immutable once published** — the new `max_message_templates` column must land in the trigger's protected-column list and the grants snapshot must show it absent from `wp_app`'s update column list.
- **Resend-to-failed is never a re-queue of terminal jobs** — a terminal failure is never retried; re-queuing it would resurrect exactly the retry-after-restriction behaviour the safety rules forbid.
- **`check-copy` on every new copy string** including the resend confirm dialog, test-send note and schedule-window warning; no banned claim ("ban-proof", "instant bulk", restriction-avoidance).
- **Media never in logs** — the retention sweeper's log lines carry ids and counts only, never a filename or MIME string.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P36 — the-simple-composer. Read plan/v2/P36-the-simple-composer.md and follow it exactly:
one phase, one session. Deps P35 are done (see plan/v2/README.md). Do not start a later phase.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
