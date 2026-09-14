# P17 — notifications-and-instance-card

**Goal (one line):** one `notify()` call, made inside the business transaction that caused it, produces exactly one in-app notification, one email and one customer webhook per real event — deduped at the database — and the panel gains an instance card that tells the truth (health score + "why?" drawer, queue depth, oldest queued age, next-send countdown, `needs_user_action`, parked state).
**Status:** done (2026-09-03) · **Size:** M · **Session:** 1 of 1
**Depends on:** P16, P15 (must be `done`) — transitively P05 (SSE), P13 (pacing state), P12 (unresolved sends)
**Blocks:** P19 (wallet low/empty banners + emails reuse `notify()`), P23 (broadcast ack + progress notifications), P25 (alerts/runbook)

**Size warning:** this phase lands exactly on the 10-step ceiling. If step 6 is not green by mid-session,
stop after step 6 and split: steps 7-10 (instance card read model, "why?" drawer, panel components,
acceptance test) become `plan/v1/P17a-instance-card.md`, added as a row in `plan/README.md`. P18 does not
depend on either half; **P19 depends on P17a**, because the low-balance banner lands on this card.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 + mailpit up via `infra/compose/docker-compose.dev.yml`; migrations applied; `scripts/ci.ps1` green on the tree as you found it (SESSION-PROTOCOL O2).
- P15 shipped: the `outbox` table, `ROLE=relay`, coalesced SSE fan-out **from the outbox**, and `webhook_endpoints`/`webhook_deliveries` with the SSRF guard, HMAC signing (`X-WP-Signature`, `X-WP-Event-Id`) and auto-disable after 20 failures. This phase writes outbox rows; it does **not** build a second publisher.
- P16 shipped: the health evaluator, bands with hysteresis/dwell, `instance_pacing_state.last_evidence` + `health_band`, `pacing_events` (incl. `hard_signal_pause`), `needs_user_action` / `user_action_reason` on `whatsapp_instances`, and human-only resume.
- P13 shipped: `instance_pacing_state` with materialised effective limits, warm-up tier/day, sending window and the pacing module's next-eligible timestamp. P14 shipped `PACING_COPY`.
- A transactional email sender already exists from P04 (signup verification; mailpit in dev). **Reuse it — do not create a second sender.** If P04 named it differently from the path in step 4, use P04's path.
- P05 shipped `GET /v1/events`, the strict ids-only realtime contract union and the frontend event→query-key invalidation map.
- ADRs 0010, 0015, 0017, 0020 accepted (0010 still reads `Status: proposed`; its SSE/outbox content is the canon this phase implements — do not re-decide the transport, do not edit an ADR header silently).

## What you are building (3-6 bullets)
- The `notifications` table: **non-partitioned**, `client_id NOT NULL`, RLS FORCE, with `UNIQUE (client_id, dedupe_key)` as the single dedupe authority (invariant 3 — no in-memory Set anywhere).
- `notify()`: **one statement**, called with the caller's transaction handle, that inserts the notification `ON CONFLICT DO NOTHING` and, **only when that insert returns a row**, writes the outbox rows for SSE + email + webhook. A conflict fans out nothing. That single fact is what makes a reconnect storm produce one email.
- The kind registry in `@wp/domain`: kind → severity, channels, mandatory flag, and the dedupe-key builder that keys on the **transition identity** (pause/event id), not on wall-clock alone.
- Channel dispatchers driven by the relay: email to the workspace's owner/admins (with a per-client hourly email cap that never suppresses in-app or webhook), webhook via P15's dispatcher, SSE `notification.created` (ids only).
- The in-app notification API (keyset list, unread count, mark-read) and the six mandatory call sites wired into their existing business transactions.
- The instance card read model + "why?" drawer endpoint + the panel components, including the verbatim parked-number copy and the honest "scored vs evidence-only" signal labelling.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | **Real-time & notifications** (event table + the mandatory-notification list); **Panel UX and copy** (the exact card contents); **Signal-driven health** (score, bands, `[R-27s]` shipping order); § Worker fleet `[R-37]` (`INFRA_UNAVAILABLE`) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | **Normative `desired_state` semantics** — the *verbatim* parked-number copy and its honest caveat; **Observability (one rule, not two)** — ids only, four-gauge label allow-list |
| ADR | `.memory/decisions/0010-realtime-and-notifications.md` | all (SSE, ids-only payloads, outbox, in-house webhooks, Resend/mailpit) |
| ADR | `.memory/decisions/0015-safe-mode-pacing-warmup-and-health.md` | `SAFE_MODE_DISCLAIMER` co-presence rule |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | one workspace, several numbers — the card is per number, the notification centre is per workspace |
| Design | `.memory/research/2026-08-25-v1-design-safe-mode.md` | §5 Panel UX and exact copy (card ASCII, "why?" drawer, `PACING_COPY`) |
| Design | `.memory/research/2026-08-25-v1-design-data-and-security.md` | §6.4 webhook signing/retry/auto-disable; audit-metadata allow-list |
| Invariants | `.claude/rules/core-invariants.md` | all (2, 3, 4, 5 bite here) |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | honest claims — every string this phase writes |
| Path rules | `.claude/rules/database.md`, `.claude/rules/api.md` | all |
| Protocol | `plan/SESSION-PROTOCOL.md` | O1-O3, E1-E3, C1-C7 |

## Dispatch plan (written at session open 2026-09-03, per SESSION-PROTOCOL E1)

Units (one dispatch each; waves in order, parallel only where marked):
- **U1** (db-engineer, alone — contains the migration): step 1 → `db/migrations/0048_notifications.sql` + isolation suite A + enum-parity registration. Also ALTERs `outbox_events_fanout_subset` to `ARRAY['sse','webhook','email']` (email is a new relay channel this phase adds).
- **U2** (implementer, alone — every later unit consumes its contracts): step 2 → `@wp/domain` kinds/dedupe-key/copy, `@wp/contracts` notifications + instance-card + dashboard-summary + realtime union member, `coalesceKeyFor`/`REALTIME_PAYLOAD_KEYS` extension, `scripts/__tests__/check-copy.test.ts`.
- **Wave 3 (parallel ×3, disjoint scopes):**
  - **U3** (implementer): steps 3-4 → `db/queries/notify-fanout.sql`, `modules/notifications/notify.ts`, relay email leg + dispatch/{email,webhook,sse}, metrics.
  - **U4** (implementer): steps 7-8 → instance card read model + "why?" drawer + `GET /v1/dashboard/summary` (carried P05 item; the frontend stub in `features/dashboard/api.ts` names P17).
  - **U5** (ui-implementer): step 9 → panel features/notifications + features/instances card/drawer/banners + SSE invalidation map + i18n en/hi.
- **U6** (implementer, after U3): steps 5-6 → the six mandatory call sites + cron `PacingEvaluatorPublish` wiring (carried P13a item: `cron-wiring.ts:30` "P17 wires this") + in-app notifications API.
- **U7** (implementer, after U6): step 10 → reconnect-storm acceptance test.

Tree-reality notes (per phase gotcha "follow the tree and note it"):
- `app/backend/tests/` does NOT exist. Integration tests are colocated `src/**/*.integration.test.ts` (only pattern `app/backend/vitest.config.ts` claims). All `tests/integration/...` paths in this file map to `app/backend/src/modules/<area>/*.integration.test.ts`; isolation suite B and security/redaction tests follow their existing suites' real locations.
- `PACING_COPY` lives in `packages/domain/src/copy/pacing-copy.ts` (camelCase keys), not `modules/pacing/copy.ts`.

## Ordered minimum steps
- [x] 1. **Migration** (dispatch `db-engineer`) → `db/migrations/00NN_notifications.sql` (next free number): enum `notification_kind` (`instance_paused`, `instance_logged_out`, `reconnect_budget_exhausted`, `duplicate_fanout_ack_required`, `unresolved_send`, `plan_cap_reached`, `infra_unavailable`, `warmup_tier_changed`) + `notification_severity` (`info|warning|critical`); table `notifications (id uuid PK, client_id uuid NOT NULL, instance_id uuid NULL, kind, severity, dedupe_key text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', requires_user_action bool NOT NULL DEFAULT false, created_at, read_at, read_by_user_id, resolved_at)`, **non-partitioned**, `CONSTRAINT notifications_dedupe_uq UNIQUE (client_id, dedupe_key)`, partial index `(client_id, created_at DESC, id DESC) WHERE read_at IS NULL`, RLS `ENABLE`+`FORCE`; register in isolation suite A and in the enum-parity list → `db/isolation/*`, `packages/domain/src/enums/*`.
- [x] 2. **Kind registry + copy + contracts, before any handler** → `packages/domain/src/notifications/kinds.ts` (kind → `{severity, channels, mandatory, dedupeScope}`; **every kind in the blueprint's mandatory list is `mandatory: true` and has no suppression path**), `packages/domain/src/notifications/dedupe-key.ts` (`sha256(kind ‖ instanceId ‖ transitionId ‖ bucket)`), `packages/domain/src/copy/notifications.ts`, `packages/domain/src/copy/instance-card.ts` (**the parked string verbatim from the scope delta**, plus `INFRA_UNAVAILABLE`, reusing `PACING_COPY` for pause reasons), `packages/contracts/src/notifications.ts`, `packages/contracts/src/instance-card.ts`; extend the realtime union with `notification.created {notificationId, kind, severity, instanceId?}` → `packages/contracts/src/app/realtime.ts`; extend `scripts/check-copy.ts` to cover both new copy files (non-zero matched-file count).
- [x] 3. **`notify()` — one statement** → `db/queries/notify-fanout.sql` + `app/backend/src/modules/notifications/notify.ts`: `WITH n AS (INSERT INTO notifications … ON CONFLICT ON CONSTRAINT notifications_dedupe_uq DO NOTHING RETURNING …) INSERT INTO outbox (…) SELECT … FROM n CROSS JOIN unnest($channels) …` (match P15's actual `outbox` columns). Signature `notify(tx, ctx, {kind, instanceId?, transitionId, payload})` — **it takes the caller's transaction; there is no auto-commit path**. Returns `{created: true, id} | {created: false, reason: 'deduped'}`. Metrics `wp_notifications_total{kind,channel}`, `wp_notify_deduped_total{kind}` (no `client_id`/`instance_id` labels) → `app/backend/src/platform/metrics.ts`.
- [x] 4. **Channel dispatchers, relay-side** → `app/backend/src/modules/notifications/dispatch/{email.ts,webhook.ts,sse.ts}` + `index.ts`. Email: recipients = `memberships` with role `owner|admin` and a verified email; subject/body from the copy file; **per-client cap 20 emails/hour** with a tail line pointing at the panel and `wp_notification_emails_suppressed_total{kind}` — the cap **never** applies to in-app or webhook. Webhook: hand the notification to P15's dispatcher with `X-WP-Event-Id = notifications.id` so a receiver can dedupe too. SSE: publish `notification.created`, ids only.
- [x] 5. **Wire the mandatory call sites**, each inside its existing business transaction, each passing the transition id that makes the key stable → health pause + `hard_signal_pause` and `logged_out` (`app/backend/src/modules/health/evaluator.ts`), reconnect budget exhausted + `INFRA_UNAVAILABLE` (`app/backend/src/engine/fleet/*`, `app/backend/src/provider/baileys/reconnect.ts`), duplicate-fan-out ack (`app/backend/src/modules/pacing/content-guards.ts`), unresolved send / `blocked_needs_review` (`app/backend/src/modules/queue/reconciler.ts`), plan cap reached (`app/backend/src/modules/pacing/reserve.ts`).
- [x] 6. **In-app API** → `app/backend/src/modules/notifications/{notifications.routes.ts,notifications.repo.ts,notifications.service.ts}`: `GET /v1/notifications` (**keyset** on `(created_at, id)`, no `OFFSET`, `unread=true` filter), `GET /v1/notifications/unread-count`, `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`; explicit auth policy + scope on every route; tenant scope from the session only.
- [x] 7. **Instance card read model** → `db/queries/instance-card.sql` + `app/backend/src/modules/instances/card.service.ts` + `card.routes.ts` (`GET /v1/instances/:id/card`): `link_state`/`health_state`/`desired_state`, `needs_user_action` + reason, health score + band, warm-up tier/day, today's sent vs `eff_daily_cap`, new conversations vs cap, sending window, last send, **queue depth counted with a `LIMIT 10001` bounded subquery** (render `10,000+` above it), **oldest queued age** from a `MIN(created_at)` index probe, and `nextSendEarliestAt` read from the pacing module (`pacing.nextEligibleAt()`) — the card **never** re-implements gap arithmetic. Cache the two queue numbers in Redis for 5 s per instance (rebuildable); register the query in `CROSS_TENANT_QUERIES` only if it is genuinely cross-tenant (it is not — it must carry `client_id`).
- [x] 8. **"Why?" drawer endpoint** → `app/backend/src/modules/health/why.service.ts` + route `GET /v1/instances/:id/health/why`: for **all twelve** signals return `{signal, measuredValue, window, evidenceCount, scored: boolean, pointsCost, exemptReason?}` from `instance_pacing_state.last_evidence` plus the last N `pacing_events` for the timeline. Signals that are evidence-only in v1 (blueprint `[R-27s]`) are returned with `scored: false` and a copy key that says so — never a fabricated points cost.
- [x] 9. **Panel** → `app/frontend/src/features/instances/{api.ts,keys.ts,components/instance-card.tsx,components/why-drawer.tsx,components/parked-banner.tsx,components/needs-action-banner.tsx}` and `app/frontend/src/features/notifications/{api.ts,keys.ts,components/notification-bell.tsx,components/notification-banner.tsx}`; countdown ticks client-side from `nextSendEarliestAt` with a server-time skew correction and renders "not sending" (not a countdown) whenever the instance is paused/parked; add `notification.created` and `instance.health_changed` to the SSE invalidation map in `app/frontend/src/lib/sse.ts`; all strings via `@wp/i18n` in `en` + `hi`.
- [x] 10. **Acceptance + full run** → `app/backend/tests/integration/notifications/reconnect-storm.test.ts` (the phase demo: 40 disconnect/reconnect cycles + one pause ⇒ 1 notification row, 1 email in mailpit, 1 webhook delivery, 1 SSE frame), then run `scripts/ci.ps1` and paste the verbatim tail into the session log.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/tests/integration/notifications/notify.test.ts` | `a_pause_produces_exactly_one_notification_one_email_row_and_one_webhook_row` | 1 `notifications` row, 3 outbox rows (sse/email/webhook), 1 mailpit message, 1 `webhook_deliveries` row |
| `app/backend/tests/integration/notifications/reconnect-storm.test.ts` | `forty_reconnects_and_one_pause_still_send_exactly_one_email` | **the phase demo** — counts are 1/1/1/1; `wp_notify_deduped_total{kind="instance_paused"}` = 39 |
| *(amended at session, 2026-09-03)* `app/backend/src/modules/notifications/reconnect-storm.integration.test.ts` | same case + `a_notify_race_with_one_transition_id_inserts_once_and_dedupes_the_rest` | As landed, a real 40× disconnect storm is absorbed by P16's conditional-UPDATE pause idempotency BEFORE notify() — calls 2-40 return `paused:false`, so the storm case asserts 1/1/1/1 + 39 no-ops + deduped delta 0; the notify()-level `ON CONFLICT` authority (the 1-insert/39-dedupe conservation) is proven by a separate 40-way CONCURRENT notify() race with one transitionId. Making the pause path call notify() unconditionally was rejected: it would require reading the prior pacing_events id on the no-op path (the "read before insert" this file's own gotcha forbids) and would regress P16's reviewed idempotency. Reviewer to adjudicate at C1. |
| `app/backend/tests/integration/notifications/notify.test.ts` | `a_deduped_notify_writes_zero_outbox_rows` | conflict path: outbox count unchanged, no email, no webhook |
| `app/backend/tests/integration/notifications/notify.test.ts` | `a_rolled_back_business_transaction_leaves_no_notification_and_no_outbox_row` | invariant: fan-out is transactional with the cause |
| `app/backend/tests/integration/notifications/notify.test.ts` | `a_resolved_then_repeated_pause_notifies_again` | new `transitionId` ⇒ new key ⇒ a second notification (dedupe must not silence a real second event) |
| `app/backend/src/modules/notifications/notify.test.ts` | `notify_requires_a_transaction_handle` | calling without a tx throws; there is no auto-commit overload |
| `packages/domain/test/notification-kinds.test.ts` | `every_mandatory_blueprint_kind_is_registered_and_not_suppressible` | the six mandatory kinds present, `mandatory: true`, no channel-off path |
| `packages/domain/test/dedupe-key.test.ts` | `the_key_is_stable_per_transition_and_differs_across_instances` | property test over ids; two instances never collide |
| `app/backend/src/modules/notifications/dispatch/email.test.ts` | `the_hourly_email_cap_never_suppresses_in_app_or_webhook` | 30 distinct kinds in an hour ⇒ 20 emails, 30 notifications, 30 webhook rows, counter incremented |
| `app/backend/src/modules/notifications/dispatch/email.test.ts` | `the_pause_email_contains_the_canonical_copy_and_no_recipient_pii` | body equals the copy key output; no recipient phone/JID/message body anywhere |
| `app/backend/tests/integration/notifications/api.test.ts` | `the_notification_list_is_keyset_paginated_and_tenant_scoped` | no `OFFSET` in the SQL; tenant B's rows never appear for tenant A |
| `app/backend/tests/isolation/suite-b-notifications.test.ts` | `two_tenants_pausing_at_once_never_cross_notify` | suite B gains the notify/dispatch background path |
| `app/backend/tests/security/notification-redaction.test.ts` | `no_phone_jid_or_body_appears_in_a_payload_log_line_or_metric_label` | log-grep over a seeded two-tenant run incl. `payload` jsonb |
| `app/backend/tests/integration/instances/card.test.ts` | `queue_depth_is_bounded_and_reports_ten_thousand_plus` | 10,500 queued jobs ⇒ `{queueDepth: 10000, queueDepthCapped: true}`; query plan uses the partial index |
| `app/backend/tests/integration/instances/card.test.ts` | `oldest_queued_age_matches_the_oldest_queued_job` | seeded ages; value within 1 s |
| `app/backend/tests/integration/instances/card.test.ts` | `a_paused_instance_reports_no_countdown_and_a_needs_user_action_reason` | `nextSendEarliestAt: null`, reason surfaced, queued count unchanged |
| `app/backend/tests/integration/instances/card.test.ts` | `a_parked_instance_renders_the_verbatim_parked_copy` | string equals the scope-delta text character-for-character |
| `app/backend/src/modules/health/why.test.ts` | `all_twelve_signals_are_returned_and_unscored_ones_say_so` | 12 entries; the evidence-only ones have `scored: false` and `pointsCost: 0` |
| `app/backend/src/modules/health/why.test.ts` | `an_unmeasured_signal_is_not_reported_as_unhealthy` | zero evidence ⇒ "not enough data yet", never a penalty |
| `app/frontend/src/features/instances/__tests__/instance-card.test.tsx` | `the_countdown_stops_and_reads_not_sending_when_paused` | renders in `en` + `hi`; no ticking timer while paused |
| `app/frontend/src/features/notifications/__tests__/bell.test.tsx` | `a_notification_created_event_invalidates_only_the_notification_keys` | hint-then-refetch; no instance query touched |
| `scripts/__tests__/check-copy.test.ts` | `a_safe_mode_string_without_the_disclaimer_fails` | co-presence guard now also scans the two new copy files, with a non-zero matched-file count |

Mandatory-suite tests this phase makes green: **none** of the numbered send-path tests 1-23 (tests **21** and **23** must stay green — the new table is non-partitioned and the new enum is in the parity list). It extends **isolation suite B** (notify/dispatch as a background path), the **log-grep/PII** suite, and the **copy** suite (Safe Mode design test **31**, `copy_contains_no_banned_claims` + `SAFE_MODE_DISCLAIMER` co-presence). Safe Mode design test **10** (`hard_restriction_signal_pauses_immediately`) gains its "notification + webhook emitted" half here.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (gate attempt 7, 2026-09-03 18:59: `CI GREEN — all 25 steps passed`, integration 350 files / 1279 tests; see `.memory/sessions/2026-09-03-P17-notifications-and-instance-card.md`).
- [x] Named tests above exist and pass; no test is skipped or `.only` (all 22 phase-table case names verified present, exactly one file each; zero `.only`/`.skip`/`todo`).
- [x] `reviewer` verdict recorded: **APPROVED** — trail: C1 `fix first` (2 CRITICAL: SMTP inside relay tx; `unresolved_send` never wired · 3 WARNING · 1 SUGGESTION) → fix round → re-review `fix first` (CRIT-1 relocated into the wiring's own tx; PII in err.message; pre-filter bound mismatch) → round 2 → `APPROVED` → post-review amendment (production api never wired the four P17 route groups; debugger round) → `APPROVED`. All 8 documented deviations adjudicated acceptable.
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding (answers in the session log).
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `db/migrations/0048_notifications.sql` — created (U1): enums, notifications table, RLS FORCE, dedupe UNIQUE, unread partial + list index, grants, outbox fanout constraint widened with 'email'
- `db/src/isolation/tenant-tables.ts` — changed (U1): notifications registered in suite A coverage
- `db/src/isolation/canonical-authority-keys.ts` — changed (U1): notifications authority = dedupe UNIQUE, PK is a row handle
- `scripts/check-tenant-scope.ts` — changed (U1): notifications added to mirrored TENANT_TABLES
- `packages/domain/src/enums/index.ts` — changed (U1): NOTIFICATION_KINDS + NOTIFICATION_SEVERITIES const arrays + PG_ENUMS entries
- `db/src/schema-version.ts` — changed (U1): EXPECTED_SCHEMA_VERSION 47 → 48
- `db/tests/wp-relay-role.test.ts` — changed (U1): pinned wp_relay surface 4 → 5 tables (notifications SELECT), new exact-grant test
- `db/schema/grants.snapshot.json` — regenerated (U1)
- `packages/domain/src/notifications/kinds.ts` — created (U2): NOTIFICATION_KIND_REGISTRY, six mandatory kinds locked, deeply frozen
- `packages/domain/src/notifications/dedupe-key.ts` — created (U2): pure `notificationDedupeKeyInput` (sha256 wrapper lives backend-side, domain purity rule)
- `packages/domain/src/copy/notifications.ts` — created (U2): NOTIFICATION_COPY (email subject/body + in-app titles), reuses PACING_COPY / INFRA_UNAVAILABLE_COPY
- `packages/domain/src/copy/instance-card.ts` — created (U2): parked string verbatim, notSending, signalNotScored, signalNotEnoughData
- `packages/domain/src/pacing/health-signal-names.ts` — created (U2): HEALTH_SIGNAL_NAMES (12, from P16 signal registry)
- `packages/domain/test/notification-kinds.test.ts` — created (U2)
- `packages/domain/test/dedupe-key.test.ts` — created (U2)
- `packages/domain/src/copy/notifications.test.ts` — created (U2)
- `packages/domain/src/copy/instance-card.test.ts` — created (U2)
- `packages/domain/src/index.ts` — changed (U2): barrel exports
- `packages/domain/src/realtime/coalesce.ts` — changed (U2): notification.created coalesce key derivation (+test)
- `packages/domain/src/realtime/assert-ids-only.ts` — changed (U2): notification.created payload key allow-list (+test)
- `packages/contracts/src/notifications.ts` — created (U2, +test): keyset list / unread-count / mark-read / read-all contracts
- `packages/contracts/src/instance-card.ts` — created (U2, +test): card + health/why contracts
- `packages/contracts/src/app/dashboard.ts` — created (U2, +test): GET /v1/dashboard/summary contract
- `packages/contracts/src/app/realtime.ts` — changed (U2): notification.created 8th union member
- `packages/contracts/tests/realtime-events.test.ts` — changed (U2)
- `packages/contracts/tests/webhooks.test.ts` — changed (U2): WEBHOOK_EVENT_TYPES gains notification.created
- `packages/contracts/src/index.ts`, `packages/contracts/src/router.ts` — changed (U2): wiring
- `scripts/guards/check-copy.test.ts` — changed (U2): disclaimer co-presence + matched-file-count cases
- `app/frontend/src/lib/sse-invalidation-map.ts` — changed (U2): typed placeholder for notification.created (U5 replaces with real keys)
- `db/migrations/0049_notification_dispatch_support.sql` — created (0049 unit): wp_notification_email_recipients + wp_notification_instance_label SECURITY DEFINER fns (EXECUTE wp_relay only), message_jobs_queued_created_idx partial index
- `db/src/schema-version.ts` — changed (0049): EXPECTED_SCHEMA_VERSION 48 → 49
- `db/tests/wp-relay-role.test.ts` — changed (0049): pins EXECUTE grants on the two new functions
- `db/src/isolation/canonical-authority-keys.ts` — changed (0049): message_jobs_queued_created_idx registered
- `db/schema/grants.snapshot.json` — regenerated (0049)
- `app/frontend/src/features/notifications/{keys.ts,api.ts,index.ts}` — created (U5)
- `app/frontend/src/features/notifications/components/{notification-bell.tsx,notification-banner.tsx}` — created (U5)
- `app/frontend/src/features/notifications/__tests__/bell.test.tsx` — created (U5)
- `app/frontend/src/features/instances/components/{instance-card.tsx,why-drawer.tsx,parked-banner.tsx,needs-action-banner.tsx}` — created (U5)
- `app/frontend/src/features/instances/__tests__/{instance-card.test.tsx,parked-banner-copy-parity.test.tsx}` — created (U5)
- `packages/i18n/test/catalogue-copy-parity.test.ts` — created (U5): en drift-guard vs @wp/domain constants
- `app/frontend/src/features/instances/{api.ts,keys.ts,index.ts}` — changed (U5): card/healthWhy fetchers + keys
- `app/frontend/src/features/dashboard/api.ts` — changed (U5): real apiFetch, staleTime 15s
- `app/frontend/src/features/dashboard/__tests__/empty-dashboard.test.tsx` — changed (U5): fetch stub post-swap
- `app/frontend/src/lib/sse-invalidation-map.ts` — changed (U5): real notification.created keys; health_changed also invalidates card key
- `app/frontend/src/lib/{sse.test.ts,sse-batch.test.ts}` — changed (U5): key-count assertions updated
- `app/frontend/src/components/app-shell.tsx` — changed (U5): NotificationBell mounted
- `packages/i18n/src/catalogues/{en.ts,hi.ts}` — changed (U5): notifications.*, instances.card/whyDrawer/needsAction.* keys, en+hi
- `db/queries/{instance-card.sql,instance-card-queue-depth.sql,instance-card-oldest-queued.sql,instance-card-usage.sql,dashboard-summary.sql}` — created (U4)
- `app/backend/src/modules/instances/{card.service.ts,card.routes.ts,card.integration.test.ts,__tests__/card-test-fixtures.ts}` — created (U4)
- `app/backend/src/modules/pacing/health/{why.service.ts,why.routes.ts,why.integration.test.ts}` — created (U4)
- `app/backend/src/modules/dashboard/{summary.service.ts,summary.routes.ts,summary.integration.test.ts,index.ts}` — created (U4)
- `app/backend/src/modules/instances/index.ts`, `app/backend/src/modules/pacing/index.ts` — changed (U4): export lines only
- `scripts/guards/check-copy.test.ts` — changed (main session): doc comment reworded — it carried the literal pacing-feature name without the disclaimer, which failed the repo-level check-copy run (guard-vs-own-test-file trap); guard now 1329 files / 0 violations
- `db/queries/notify-fanout.sql` — created (U3): one-statement CTE insert (notifications + per-channel outbox fan-out)
- `app/backend/src/modules/notifications/{notify.ts,notify.test.ts,notify.integration.test.ts,index.ts}` — created (U3)
- `app/backend/src/modules/notifications/dispatch/{sse.ts,webhook.ts,email.ts,email.integration.test.ts,index.ts}` — created (U3)
- `app/backend/src/modules/notifications/__tests__/notifications-test-support.ts` — created (U3)
- `app/backend/src/modules/events/{relay-loop-email-wiring.ts}` + `app/backend/src/roles/relay-email-wiring.ts` — created (U3, max-lines split siblings)
- `app/backend/src/modules/events/emit.ts` (+emit.test.ts) — changed (U3): fanout widened with 'email'
- `app/backend/src/modules/events/relay-loop.ts`, `app/backend/src/modules/events/index.ts`, `app/backend/src/roles/relay.ts` — changed (U3): email leg wired
- `app/backend/src/platform/mailer.ts` — changed (U3): sendNotificationEmail on the existing Mailer port (no second transport)
- `app/backend/src/platform/metrics/notification-metrics.ts` — created (U3): wp_notifications_total{kind,channel}, wp_notify_deduped_total{kind}, wp_notification_emails_suppressed_total{kind}
- `packages/server-kit/src/obs/metric-policy.ts` — changed (U3): kind/channel added to ALLOWED_LABELS (P16 precedent, cited P17)
- `app/backend/src/modules/notifications/{notifications.repo.ts,notifications.service.ts,notifications.routes.ts}` — created (U6): keyset list/count/read/read-all, policy `session` + explicit scopes
- `app/backend/src/modules/notifications/{notifications-api.integration.test.ts,isolation-suite-b-notifications.integration.test.ts,notification-redaction.integration.test.ts}` — created (U6)
- `app/backend/src/engine/pacing/warmup-evaluator-apply.ts` — created (U6): max-lines split; evaluateOneInstance + warmup_tier_changed notify
- `app/backend/src/engine/cron/cron-wiring.integration.test.ts` — created (U6)
- `app/backend/src/modules/pacing/health/hard-signal-pause.ts` — changed (U6): instance_paused notify, transitionId = pacing_events row id, transition branch only
- `app/backend/src/modules/instances/service.ts` — changed (U6): reconnect_budget_exhausted + instance_logged_out notify, transitionId = lease fence
- `app/backend/src/engine/fleet/discovery-escalation.ts` — changed (U6): infra_unavailable notify, transitionId = audit row id (RETURNING id added)
- `app/backend/src/engine/queue/send-loop-claim-evaluation.ts` — changed (U6): duplicate_fanout_ack_required notify, transitionId = fingerprint+localDate
- `app/backend/src/engine/pacing/index.ts` — changed (U6): plan_cap_reached notify on PLAN_CAP deny, instance-day bucket
- `app/backend/src/engine/pacing/warmup-evaluator.ts` — changed (U6): split to sweep loop, imports sibling
- `app/backend/src/engine/cron/cron-wiring.ts` — changed (U6): buildOutboxPacingPublish replaces NOOP_PACING_PUBLISH (carried P13a item closed)
- `app/backend/src/platform/http/server.ts` — changed (U6): notifications routes registered
- `app/backend/src/modules/notifications/index.ts` — changed (U6): barrel
- 6 existing call-site test files extended (U6): hard-signal-pause-idempotency, instance-transitions.logged-out-purge, runner-reconnect, discovery-escalation, pipeline, reserve-plan-cap integration tests
- 9 cleanup helpers/fixtures — changed (U6): notifications FK deletes added (instances-test-helpers, store-fixtures, discovery-integration-test-support, queue-send-tenant-fixture, pacing-test-helpers, notifications-test-support, + 3 fleet test afterEach blocks)
- `app/backend/src/engine/pacing/warmup-no-path-skip.integration.test.ts` — changed (debugger): guard walk narrowed to *InputSchema exports + non-zero-match assertion (was over-matching the new read-only card schema; original mutation-input invariant preserved)
- `app/backend/src/modules/pacing/internal/system-send.integration.test.ts` — changed (debugger): two-clock drift fixed — OUTSIDE_WINDOW fixture row retired by id after its assertion (new flaky-class variant, lesson filed)
- `.memory/lessons/2026-09-03-two-clock-drift-and-guard-scope.md` — created (debugger); MEMORY.md index line appended
- `app/backend/src/modules/notifications/reconnect-storm.integration.test.ts` — created (U7, amended criteria): 40× real fast-lane 403 storm ⇒ 1/1/1/1 + 39 pause-layer no-ops (deduped delta 0); 40-way concurrent notify() race ⇒ 1 created + 39 deduped (delta 39), real mailpit + local HTTPS receiver + capturing SSE port
- `app/backend/src/modules/events/relay-loop-email-crash.test.ts` — created (C2): pins the email-leg tick-poisoning bug (fix round flips it to assert isolation)
- `app/backend/src/modules/notifications/notify-payload-size-boundary.integration.test.ts` — created (C2): 2048-byte CHECK boundary + pause-rollback layering pin
- `app/backend/src/modules/notifications/notifications-api-edge-cases.integration.test.ts` — created (C2): cursor-tie pagination, garbage cursor, read-all vs later insert, typed errors
- `app/backend/src/modules/notifications/dispatch/email-zero-recipients.integration.test.ts` — created (C2): zero-recipient clean skip
- `app/backend/src/engine/pacing/reserve-plan-cap.integration.test.ts` — changed (C2): midnight instance-day bucket test added
- `app/backend/src/modules/notifications/notifications-api.integration.test.ts`, `dispatch/email.integration.test.ts`, `__tests__/notifications-test-support.ts` — changed (C2): shared seedNotification helper + 300-line-cap sibling splits
- `db/migrations/0050_queued_probe_index_client_scope.sql` — created (fix round, C1-W3): index re-created client_id-leading; IOS proven, no heap re-check
- `db/src/schema-version.ts` — changed (0050): 49 → 50
- `db/src/isolation/canonical-authority-keys.ts` — changed (0050): obsolete instance_id-leading exemption removed
- `db/queries/instance-card-oldest-queued.sql` — changed (0050): header comment → message_jobs_queued_probe_idx
- `app/backend/src/modules/instances/__tests__/card-test-fixtures.ts`, `card.integration.test.ts` — changed (0050): index-name references updated
- `app/backend/src/modules/events/{relay-loop.ts,relay-loop-email-wiring.ts,index.ts}` + `relay-loop-role.ts` (new) — changed/created (fix F1): email dispatch moved post-commit, per-row isolation, withRelayRole extracted for line cap
- `app/backend/src/roles/relay-email-wiring.ts` — changed (F1): own connection, BEGIN/SET LOCAL ROLE wp_relay/COMMIT
- `app/backend/src/modules/notifications/dispatch/email.ts` — changed (F1/F4): per-row try/catch + failure metric, honest at-most-once header, CAP_WINDOW_SECONDS unified
- `app/backend/src/modules/notifications/dispatch/email-per-row-isolation.integration.test.ts` — created (F1)
- `app/backend/src/modules/events/relay-loop-email-crash.test.ts` — changed (F1): flipped to assert isolation + no-resend
- `app/backend/src/platform/metrics/notification-metrics.ts` — changed (F1): wp_notification_email_failures_total{kind}
- `app/backend/src/modules/queue/reconciler.ts` (+reconciler.integration.test.ts, reconciler-unresolved-send-notify.integration.test.ts new) — changed (F2+correction): unresolved_send wired INSIDE the caller's tx on the transition branch, guarded by SAVEPOINT unresolved_send_notify (bare try/catch leaves a PG tx aborted — COMMIT silently rolls back; caught by a real FK-violation test)
- `app/backend/src/modules/pacing/health/hard-signal-pause.ts` — changed (F5 correction): same SAVEPOINT idiom (instance_paused_notify) replacing the bare try/catch guard
- `app/backend/src/modules/instances/card.service.ts` — changed (F3): serverNow excluded from 5s cache, fresh per request (+cache-hit test)
- `app/backend/src/modules/notifications/notify.ts` (+notify.test.ts) — changed (F5): typed NOTIFY_PAYLOAD_TOO_LARGE pre-SQL validation
- `app/backend/src/modules/pacing/health/hard-signal-pause.ts` — changed (F5): notify wrapped swallow-and-log; pause always commits
- `app/backend/src/modules/notifications/notify-payload-size-boundary.integration.test.ts` — changed (F5): flipped to assert fixed layering
- `app/backend/src/modules/notifications/reconnect-storm.integration.test.ts` — changed (F6): filter type predicate fixed, typecheck clean
- `app/backend/src/modules/notifications/dispatch/email.ts` — changed (round 2): split resolve(client,rows)/send(resolved) — SMTP holds NO DB connection; failure log static + {client_id,instance_id,error_class} only
- `app/backend/src/roles/relay-email-wiring.ts` — changed (round 2): tx scoped to resolve only, client released before send; mailer injectable
- `app/backend/src/roles/relay-email-wiring-transaction-shape.test.ts` — created (round 2): recording fake pool through the REAL wiring proves sendMail strictly after COMMIT+release
- `app/backend/src/modules/notifications/notify.ts` — changed (round 2): pre-filter bound 1536 + honest comment (DB CHECK authority, SAVEPOINT backstop)
- `app/backend/src/modules/notifications/notify-payload-size-boundary.integration.test.ts` — changed (round 2): distinguishing case (passes JS pre-filter, trips pg_column_size CHECK; SAVEPOINT caller still commits)
- `app/backend/src/modules/notifications/dispatch/{email.integration.test.ts,email-zero-recipients.integration.test.ts,email-per-row-isolation.integration.test.ts}` — changed (round 2): resolve/send split
- `app/backend/src/modules/notifications/notifications.repo.ts` — changed (main session, gate attempt 1 red): tenant predicate hoisted into the SQL literal so check-tenant-scope sees it statically (predicate was always present in the joined conditions; guard-visibility fix, no behavior change)
- `scripts/check-sql-lint.ts` — changed (main session, gate attempt 2 red): OFFSET scan now masks opaque spans (comments/strings/dollar bodies) per the guard's own SET-check doctrine — migration 0048's "no OFFSET" index comment was a false positive; executable OFFSET still flagged
- `scripts/guards/check-sql-lint.test.ts` + `scripts/guards/__fixtures__/sql/{clean-offset-in-comment.sql,bad-offset-with-comment-mention.sql}` — changed/created (main session): two cases pin the masking (comment mention clean; executable clause still flagged at the right line)
- `app/backend/src/modules/notifications/dispatch/relay-email-fanout.ts` (+`relay-email-fanout-transaction-shape.test.ts`) — created (main session, gate attempt 2): MOVED from `src/roles/relay-email-wiring*.ts` — check-role-boot rightly treats every roles/ file as an entrypoint; wiring lives with its module. Old files deleted; `dispatch/index.ts` exports it; `roles/relay.ts` + `reconnect-storm` imports and doc mentions updated
- `app/backend/src/roles/{relay-email-wiring.ts,relay-email-wiring-transaction-shape.test.ts}` — DELETED (moved above)
- `app/backend/src/engine/queue/send-loop-pacing-deferral-metrics.ts`, `app/backend/src/engine/pacing/warmup-edge.integration.test.ts` — DELETED (P13a carried cleanup item closed; both were documented no-op leftovers, zero imports verified)
- `app/backend/src/modules/notifications/dispatch/email.ts` — changed (main session, gate attempt 3 red): at-most-once doc comment reworded to avoid check-copy's banned-claim token (the comment was explaining we make no such promise; the guard scans raw text and rightly bans the token anywhere)
- `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — changed (debugger, gate attempt 4 red): `notify:email:hourly` cap-key shape modeled in suite C's key grammar (P13a LEASE_KEY_GRAMMAR precedent)
- `app/backend/src/modules/notifications/reconnect-storm.integration.test.ts` — changed (debugger): scoped cleanup of cap keys + pacing_events/instance_pacing_state rows its fixtures mint
- `app/backend/src/engine/queue/__tests__/queue-send-tenant-fixture.ts`, `engine/pacing/__tests__/pacing-test-helpers.ts`, `modules/instances/__tests__/instances-test-helpers.ts`, `engine/fleet/__tests__/discovery-integration-test-support.ts`, `provider/baileys/auth-state/__tests__/store-fixtures.ts` — changed (debugger): cleanup helpers gain the outbox/cap-key deletes the new P17 emit paths made necessary (P16 enabler-variant, recurred on schedule)
- `app/backend/src/engine/fleet/{fleet-c2-slow-redis,fleet-discovery-race-e3-edge,fleet-c2-cross-tenant-and-shed}.integration.test.ts` — changed (debugger): fixture cleanup for the newly-emitting paths
- `app/backend/src/engine/fleet/fleet-connect-bucket-e3-edge.integration.test.ts` — changed (debugger): the long-carried WATCH flake fixed deterministically (master-plan item: "fix in the next fleet-touching phase" — that was P17)
- `app/backend/src/roles/api.ts` — changed (debugger, last write before its rate-limit kill; tsc green, gate validates): exact delta unreviewed, flagged for the session log
- `app/backend/src/platform/http/server.ts` — changed (main session, post-review finding): card/healthWhy/dashboard added as optional BuildAppDeps + registrations (notifications idiom)
- `app/backend/src/roles/relay-cleanup-and-qr.integration.test.ts` — changed (main session, gate attempt 6 red): bounded-sweep exactness test now sweeps the table to exhaustion before seeding — its "exactly 1 remains" math silently assumed zero foreign eligible rows; 27 published notification.created rows minted against db/seeds/queue-explain-fixture.sql's PERMANENT clients (which no suite may delete) ate the budget first. Root-enabler item in master-plan gains this new leak vector.
- `app/backend/src/roles/api.ts` — changed (main session, post-review finding): production api now passes notifications/card/healthWhy/dashboard deps — ALL FOUR P17 API surfaces were dep-gated but never wired in production (tests build their own app; the P12 "panel exists but no endpoint" class, caught at close)

## Risks / gotchas specific to this phase
- **Dedupe must be the unique index, not code.** A `Set` in the evaluator, a Redis `SETNX`, or "check then insert" all lose the race that a reconnect storm is made of. The only authority is `notifications_dedupe_uq` on a **non-partitioned** table, and the outbox rows must be written from the `RETURNING` of that insert. If you find yourself reading the table before inserting, stop.
- **Dedupe keyed on time alone silences real events.** Key on the transition identity (the pause/`pacing_events` id, the reconnect-budget-exhaustion id). A time bucket is only correct for genuinely repeating conditions (e.g. a daily low-balance reminder in P19). Test `a_resolved_then_repeated_pause_notifies_again` exists precisely to catch an over-eager key.
- **`notify()` outside the transaction is a lost or duplicated alert.** Called after commit, a crash loses it; called in its own transaction, a rollback of the cause leaves a lie in the panel. It takes the caller's `tx` and nothing else. Never call an SMTP or HTTP client inside that transaction — the relay does the I/O.
- **A per-instance storm is deduped; a per-workspace storm is not.** 30 numbers flapping produce 30 legitimate, differently-keyed notifications. That is why the email dispatcher has an hourly cap and the panel does not. Do not "fix" it by suppressing in-app or webhook — the tenant's own automation depends on the webhook.
- **PII boundary, stated precisely.** The `payload` jsonb, every log line, every metric label and every audit metadata value carry **ids, enums and counts only** — no phone number, JID, contact name or message body. The *email body* may name the instance the way the tenant labelled it (their own number, sent to their own verified address); nothing else. The redaction test greps the payload column too.
- **The card must not become a table scan per render.** `count(*)` over every `message_jobs` partition per open card is how the panel takes the database down at 1,000 instances. Bounded `LIMIT 10001` subquery + a 5 s Redis cache, and read the plan in the test.
- **The countdown is a floor, not a promise.** It is the earliest the next send may start under pacing; it is not an ETA and no copy may call it one. When paused, parked, or wallet-empty (P19), render the state, not a ticking number — a countdown on a paused number is a lie the tenant will act on.
- **Honest health copy.** Nine of the twelve signals are evidence-only in v1 (`[R-27s]`). The drawer says so. Never render an untuned weight as a measured cost, and never render a bare score without its reasons. "Not enough data yet" is a correct answer.
- **Copy traps.** No "ban-proof", "won't get blocked", "100% safe", "ban nahi hoga", "instant", "guaranteed delivery" — English or Hindi. Any string containing "Safe Mode" must ship with `SAFE_MODE_DISCLAIMER` co-present or `check-copy` fails (and it should). The parked-number string is **verbatim** from the scope delta, including the caveat that messages sent while parked may not appear after reconnecting — do not smooth it into a reassurance; WhatsApp's server-side buffer is undocumented and we will not imply otherwise.
- **A notification is never a resume path.** The banner offers a human action (reconnect, acknowledge, top up); it must never offer or trigger an automatic resume out of a restriction, and no dispatcher may write `health_state`. Invariants 2 and 6, and the `no_forbidden_mechanism_exists` scan must stay green.
- **Use the integration-test root that already exists.** P04 wrote `app/backend/tests/…`; do not create a second root. If the tree says `test/`, follow the tree and note it.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P18 — wallet-ledger-and-pricing. Read plan/v1/P18-wallet-ledger-and-pricing.md and follow it exactly:
one phase, one session. Deps P12 and P02 are done (see plan/README.md). Do not start P19.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
