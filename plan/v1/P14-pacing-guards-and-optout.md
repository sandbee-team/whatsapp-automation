# P14 — pacing-guards-and-optout

**Goal (one line):** a hashed opt-out registry enforced at three points with Hindi/Hinglish keyword matching, the four content guards (duplicate fan-out, link-in-first-message, blocked words, rolling per-recipient frequency), and a `SendOrigin` enum whose only exempt members are unconstructible outside `modules/pacing/internal/` — all wired into the claim transaction so a terminal guard disposes of a job without ever consuming a pacing unit.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P13 (must be `done`)
**Blocks:** P16, P20, P23, P24

**Size warning:** this phase lands on the 9-step ceiling and two steps (7, 8) touch the hot claim loop.
If step 6 is not green by mid-session, stop after step 6 and split: steps 7-9 (pipeline wiring, the
duplicate-fan-out ack surface, the copy file) become `plan/v1/P14a-guard-pipeline-and-ack.md`, and
P16/P20 wait on P14a, not P14. Do not compress the tests to fit.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; all migrations applied; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL O2).
- `pacing_ledger`, `instance_pacing_state` (materialised effective limits incl. `warmup_tier`, sending window, timezone) and the single `pacing.reserve()` / `release()` statement exist from P13, with mandatory Safe Mode tests 1-9 green.
- `instance_recipient_contacts` exists (the single source of `is_new_conversation` and `first_inbound_at`) from P13. **If it does not, create it in step 1 and say so in the session log** — nothing else in this phase may invent a second source.
- `message_jobs` already carries `recipient_hash`, `cancel_reason`, `send_origin`, `content_fingerprint`, `content_fingerprint_counted_at`, `pacing_deny_reason`, `pacing_deferrals`, `is_new_conversation` (P03) — this phase adds **no** column to `message_jobs`.
- The claim loop, `db/queries/claim-jobs.sql` and the send-result transaction exist from P11/P12; the pacing deferral writer exists from P13.
- `KeyProvider` + the file key ring (P01) can produce a stable **pepper** for `hmac_sha256(pepper, e164)` and envelope-encrypt a display value.
- `scripts/check-send-origin.ts` exists from P00 with clause 1 declared `activatesIn: 'P14'`; `scripts/check-copy.ts` and the guard meta-assertion exist.
- ADRs 0015, 0017 accepted; 0020 (phase/session protocol) in force.

## What you are building (3-6 bullets)
- The hashed opt-out registry (`opt_outs`, never a raw phone number in an index) with client-default / instance-opt-in scope, tenant-additive keywords, and a **human-only** restore path.
- Opt-out enforcement at three independent points: API job creation (422, no row), inside the claim transaction, and pre-send inside the send transaction — a match writes `cancelled` + `cancel_reason='opt_out'`, **never** `failed`.
- The four content guards with their exact outcomes: duplicate fan-out → stays `queued` + `NEEDS_HUMAN_ACK`; link-in-first-message and blocked words → terminal `failed` for that job only; per-recipient frequency (3/24 h, 8/7 d, **per client**) → stays `queued` to window expiry.
- The guard pipeline inside the claim transaction, with the 25-disposals-per-pass inner loop, `wp_content_guard_trips_total`, and the rule that a terminal guard never reaches `pacing.reserve()`.
- `SendOrigin` as a typed enum parameter: `campaign` and `inbox_manual` explicitly **non-exempt**; `system_reply` and `opt_out_confirmation` constructible only under `modules/pacing/internal/`; `check-send-origin` clause 1 activated.
- One copy file for every guard outcome (en + hi), category-only for blocked words, run through `check-copy`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | § **Opt-out registry**; § **Content guards**; § **`SendOrigin`, and why there is no bypass**; § Deferral is not failure (the outcome table); § Panel UX and copy; § Mandatory Safe Mode suite (the amendments to tests 16/18/21/22) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | § **Groups** (the `recipient_hash` / `is_group` row); § Broadcast design → "How caps shape the ETA" (the client-level frequency line); § Inbox → reply composer (`inbox_manual` non-exempt); § Invariant compliance row **6**; § Contacts and lists → JID/LID policy |
| Design | `.memory/research/2026-08-25-v1-design-safe-mode.md` | §3.3 opt-out, §3.4 content guards, §6.2 tables, §6.4 gate interface + `DenyReason`, §6.5 enforcement point, §7 tests 16-23 |
| ADR | `.memory/decisions/0015-safe-mode-pacing-warmup-and-health.md` | decisions 4-6 (human-only transitions, opt-out + guards, typed exemptions) |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | — |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms; honest claims (**binding on every string this phase writes**) |
| Invariants | `.claude/rules/core-invariants.md` | all (2, 5, 6 bite hardest here) |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md`, `.claude/rules/api.md` | all |

## Ordered minimum steps
Migration number: use the next free 4-digit number after P13's and write the real name into the files list.

- [x] 1. **(db-engineer)** Guard tables, additive and forward-only → `db/migrations/00NN_optout_and_content_guards.sql` + `db/schema/{opt-outs,optout-confirmations,tenant-optout-keywords,tenant-blocked-words,content-fingerprints,content-fingerprint-recipients,recipient-send-buckets}.ts`. Shapes: `opt_outs` per safe-mode §6.2 with the partial unique index `(client_id, scope_key, phone_hash) WHERE restored_at IS NULL`; `optout_confirmations (client_id, scope_key, phone_hash, last_sent_at)` PK — survives a restore, so the 30-day rule cannot be reset by re-opting-out; `content_fingerprints` PK **`(client_id, local_date, fingerprint)`** (client-level, per the blueprint — *not* the design's instance-level PK) with `recipient_count`, `ack_by`, `ack_at`; `content_fingerprint_recipients` PK `(client_id, local_date, fingerprint, recipient_hash)`; `recipient_send_buckets (client_id, phone_hash, hour_bucket, count)` PK; both tenant word/keyword tables `(client_id, ...)` **additive only — no DELETE grant path for platform rows**. Every table: `client_id NOT NULL` first, index leads with `client_id`, RLS `ENABLE`+`FORCE`, `wp_app` R/W, `wp_admin_app` no write. Register all seven in `db/test/isolation-suite-a.test.ts` and refresh `db/test/role-grants.snapshot.json`.
- [x] 2. Opt-out matching, browser-pure → `packages/domain/src/optout/{normalise.ts,keywords.ts,match.ts}` + `.test.ts`. `normalise` = trim, lowercase, strip punctuation/emoji, collapse whitespace, Devanagari→Latin via a small explicit mapping table (no heavy dependency). `PLATFORM_OPTOUT_KEYWORDS` = the blueprint list (`stop`, `stopall`, `unsubscribe`, `opt out`, `optout`, `remove me`, `do not message`, `dnd`, `band karo`, `band karo message`, `mat bhejo`, `rok do`, `बंद करो`, `रोको`, `हटाओ`), frozen and not removable. `match(text, tenantKeywords)` returns the matched keyword when the normalised message **is** a keyword, or **starts with** one and is ≤ 4 tokens.
- [x] 3. Content primitives, browser-pure → `packages/domain/src/content/{normalise-body.ts,link-regex.ts,blocked-word-match.ts}` + `.test.ts`, and `packages/domain/src/pacing/deny-reason.ts` (the `DenyReason` union from safe-mode §6.4, each member tagged `terminal | defer`). `normaliseForFingerprint` = lowercase, URLs→`<url>`, digits→`#`, strip emoji, collapse whitespace, strip resolved template variables — **it returns a string; it does not hash** (`@wp/domain` may not import `node:crypto`). `LINK_RE` covers http/https, `www.`, bare `t.me/`, `wa.me/`, known shorteners and bare `host.tld/path`. Blocked-word matching is word-boundary + simple leet-normalisation and returns only a **category**, never the matched word.
- [x] 4. `OptOutRegistry` + the cancel statement → `app/backend/src/modules/pacing/optout/{registry.ts,hash.ts,restore.ts}`, `db/queries/cancel-optout-jobs.sql`. `phone_hash = hmac_sha256(pepper, e164)` (pepper from the key ring), display value envelope-encrypted; insert is idempotent via the partial unique index; scope defaults to `client`, `instance` scope is an audited opt-in. The cancel statement sets `status='cancelled', cancel_reason='opt_out', terminal_at=now()` for every `queued` job matching `(client_id, recipient_hash)` under scope **and `recipient_jid NOT LIKE '%@g.us'`** — never `failed`, never deleted, `attempts` untouched. Restore requires `actor_user_id` + a typed `restore_reason` and writes `audit_logs`; there is no API-key or system path to restore.
- [x] 5. The three enforcement points + the confirmation sender → `app/backend/src/modules/messages/enqueue.ts` (422 `RECIPIENT_OPTED_OUT`, no job row, no charge), `app/backend/src/modules/pacing/guards/optout-gate.ts` (claim-transaction re-check), `app/backend/src/modules/queue/send-transaction.ts` (pre-send last line of defence), `app/backend/src/modules/pacing/internal/system-send.ts`, `app/backend/src/modules/inbound/optout-detect.ts` (the inbound hook the P21 handler will call; a `@lid`-only sender is recorded **unattributable**, never mis-attributed to a contact). One confirmation per contact per 30 days, guarded by `optout_confirmations`, sent with `SendOrigin.OPT_OUT_CONFIRMATION`: exempt from caps/gap/cold-ratio, **still window-bound** (a 03:00 STOP defers its confirmation to window open) and the only origin the opt-out gate lets through.
- [x] 6. The four content guard evaluators → `app/backend/src/modules/pacing/content/{fingerprint.ts,link-guard.ts,blocked-words.ts,recipient-frequency.ts}` + `db/queries/{count-fingerprint-recipient.sql,recipient-frequency-window.sql}`. Duplicate fan-out counts **distinct** recipients with `INSERT ... ON CONFLICT DO NOTHING` into `content_fingerprint_recipients` and only bumps `content_fingerprints.recipient_count` when a row was actually inserted (never an unconditional increment); warn at 150, `NEEDS_HUMAN_ACK` at 500. Link guard fires only against a contact with no `first_inbound_at` and only at warm-up tiers 1-2 (warn at 3, allowed 4+). Blocked words = platform list ∪ `tenant_blocked_words`. Frequency sums `recipient_send_buckets` over true rolling 24 h / 7 d windows, **per `client_id`**, and returns `next_attempt_at` = window expiry; the bucket row is written in the send-result transaction.
- [x] 7. The guard pipeline in the claim transaction → `app/backend/src/modules/pacing/guards/pipeline.ts`, `db/queries/dispose-job.sql`, `db/queries/defer-job.sql` (extend P13's writer with `PER_RECIPIENT_FREQ` and `NEEDS_HUMAN_ACK`), `app/backend/src/roles/send-worker.ts`. Order inside one transaction: claim → guards → `pacing.reserve()` → mark dispatchable. A **terminal** guard writes the disposal (`cancelled`/`failed` + `pacing_deny_reason` + copy key) and **never calls `reserve()`**; a **defer** returns the job to `queued` with lease fields cleared, `next_attempt_at` set, `pacing_deferrals + 1` and `attempts` untouched — inside the same transaction, so no observer ever sees `processing`. Group jobs (`recipient_jid LIKE '%@g.us'`) skip the opt-out gate and the frequency guard **only**; content guards and the sending window still apply. Terminal disposals continue the inner loop for the same instance up to **25 per pass**. Register `wp_content_guard_trips_total{reason}` and `wp_optout_cancelled_jobs_total` (no `client_id`/`instance_id` label).
- [x] 8. `SendOrigin` + the guard activation + the duplicate-fan-out ack → `packages/domain/src/pacing/send-origin.ts` (union `'campaign'|'api_send'|'inbox_manual'|'system_reply'|'opt_out_confirmation'`, with `EXEMPT_ORIGINS` frozen to exactly two and `NON_EXEMPT_ORIGINS` naming `campaign` and `inbox_manual`), `scripts/check-send-origin.ts` (flip `activatesIn` off, add clause 3: the exempt set must equal exactly those two members), `app/backend/src/modules/pacing/routes/ack-fanout.ts` + `app/frontend/src/features/pacing/DuplicateFanoutBanner.tsx`. Ack is per `(client_id, local_date, fingerprint)`, requires a user actor, writes `ack_by`/`ack_at` + `audit_logs`, and **publishes a wake on `wp:{env}:wake:c:{client}:i:{instance}` for every affected instance in the same code path as the commit** (delta's normative wake rule — otherwise the acked jobs wait for the ≤42 s safety poll).
- [x] 9. Copy + guards + isolation → `packages/domain/src/copy/guard-copy.ts` + `.test.ts` (one string per `DenyReason`, en + hi, each saying what happened, what is preserved, when it resumes and what the user can do; blocked words show a **category** only), `packages/frontend/i18n` keys, `scripts/ci.ps1`/`ci.sh` (the reactivated `check-send-origin` step prints a non-zero matched-file count), and `db/test/isolation-suite-b.test.ts` (two-tenant coverage of the guard pipeline and the inbound opt-out hook).

## Dispatch plan (written at session open, 2026-09-02, per SESSION-PROTOCOL E1)

**Path corrections found at open (the expected-files list below was written before P11-P13 landed; reality wins):**
- `roles/send-worker.ts` does not exist → the claim loop is `engine/queue/send-loop.ts` + `send-loop-pacing-claim.ts#claimAndReserve` (wired by `send-loop-worker-wiring.ts`); `send-loop.ts:254` already carries the `// P14: contentGuards.evaluate() here` insertion comment.
- `modules/queue/send-transaction.ts` does not exist → pre-send = `engine/queue/dispatch.ts` (attempt transaction), send-result = `engine/queue/result.ts#resolveAck`.
- `modules/messages/enqueue.ts` does not exist → `modules/messages/messages.service.ts` / `messages.repo.ts` / `messages.routes.ts`.
- `db/test/` → `db/tests/`; the grant snapshot idiom is `db/tests/grants-snapshot*.test.ts`.
- `packages/domain/src/pacing/deny-reason.ts` already exists as `deny-reasons.ts` (P13) with every P14 member tagged — extend, never duplicate.
- The P13 deferral writer is `writeDenialToJob` inline in `send-loop-pacing-claim.ts`, not a SQL file.
- `instance_recipient_contacts` does NOT exist (prerequisite escape hatch fires): **step 1 creates it**.
- Next free migration number: **0036**.

**Units (order; ∥ = parallel):** U1 → U2 → U3 → (U4 ∥ U5) → U6 → U7
- **U1** (db-engineer, solo — migration): step 1 + create `instance_recipient_contacts`. Migration `0036_optout_and_content_guards.sql`.
- **U2** (implementer): steps 2+3 — `@wp/domain` opt-out matching, content primitives, `GuardDecision` type, `send-origin.ts` (+ test; the domain half of step 8). Browser-pure.
- **U3** (implementer): step 4 + `optout-detect.ts` — pepper KEK purpose `optout-pepper`, `hash.ts`, `OptOutRegistry`, `cancel-optout-jobs.sql`, `restore.ts`, inbound detect hook.
- **U4** (implementer): step 5 remainder — enqueue 422 + `recipient_hash` + `send_origin='api_send'` + strict-origin test 23; `guards/optout-gate.ts`; `dispatch.ts` pre-send gate; `internal/system-send.ts` + exempt-origin lines in `reserve-pacing.sql`; confirmation sender + 30-day rule; `result.ts` bucket write; three-point integration test.
- **U5** (implementer, ∥ U4 — disjoint files): step 6 — four content-guard evaluators + `count-fingerprint-recipient.sql` + `recipient-frequency-window.sql` + fingerprint/guards/frequency integration tests.
- **U6** (implementer): step 7 — `guards/pipeline.ts`, `dispose-job.sql`, `defer-job.sql`, send-loop wiring + 25-disposal inner loop, guard metrics, pipeline integration tests.
- **U7** (implementer): steps 8-remainder + 9 — `check-send-origin` activation + clause 3 + guard test, `ack-fanout` route + wake publish, `DuplicateFanoutBanner.tsx`, `guard-copy.ts` + i18n, isolation-suite-b cases, PII log test extension.

Shared contracts named for the U4 ∥ U5 wave: `GuardDecision` (U2, `@wp/domain`), `recipient_send_buckets.hour_bucket = date_trunc('hour', now())` (U1 schema comment), `DenyReason` labels (frozen, P13), registry read API `isOptedOut(tx, {clientId, instanceId, phoneHash})` (U3). U4 may not touch `modules/pacing/content/**`; U5 may not touch `engine/queue/**`, `modules/messages/**`, `modules/pacing/optout/**`, `reserve-pacing.sql`.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/domain/src/optout/match.test.ts` | `optout_keyword_matching_precision` | **test 17** — table: `STOP`, `stop.`, `band karo`, `बंद करो`, `रोको` match; `please don't stop sending updates`, `stopwatch order`, `stop by tomorrow if you can` do not |
| `packages/domain/src/optout/match.test.ts` | `a_keyword_prefixed_message_over_four_tokens_does_not_match` | 5-token message beginning `stop` returns no match |
| `packages/domain/src/optout/keywords.test.ts` | `platform_keywords_cannot_be_removed_only_added_to` | any attempt to shadow/remove a platform keyword throws; tenant list is additive |
| `app/backend/src/modules/pacing/optout/registry.integration.test.ts` | `optout_hard_blocks_at_all_three_points` | **test 16 (amended)** — (a) API create → 422, zero `message_jobs` rows, zero wallet rows; (b) an already-queued job → `cancelled`/`opt_out`; (c) a stale-cache worker is still blocked pre-send. An exempt `SYSTEM_REPLY` origin is **still** blocked |
| `app/backend/src/modules/pacing/optout/registry.integration.test.ts` | `optout_cancels_queued_jobs_and_is_idempotent` | **test 18 (amended)** — duplicate STOP → one `opt_outs` row, one confirmation ever, jobs `cancelled` with `cancel_reason='opt_out'`, **zero jobs in `failed`**, `attempts` byte-identical |
| `app/backend/src/modules/pacing/optout/registry.integration.test.ts` | `an_optout_cancel_is_excluded_from_every_health_denominator` | the cancelled jobs contribute to no rejected-send / delivery-ratio denominator |
| `app/backend/src/modules/pacing/optout/registry.integration.test.ts` | `a_contact_optout_does_not_cancel_a_group_job` | a `@g.us` job for the same instance stays `queued` (scope delta § Groups) |
| `app/backend/src/modules/pacing/optout/registry.integration.test.ts` | `duplicate_stop_sends_one_confirmation_within_thirty_days` | second STOP at day 3 sends nothing; day 31 sends one |
| `app/backend/src/modules/pacing/optout/registry.integration.test.ts` | `an_optout_confirmation_at_0300_defers_to_window_open` | `[R-3s]` — exempt from caps/gap, still window-bound |
| `app/backend/src/modules/pacing/optout/restore.test.ts` | `restore_requires_a_user_actor_and_a_typed_reason` | api-key and system actors → 403; success writes `audit_logs` |
| `app/backend/src/modules/inbound/optout-detect.test.ts` | `a_lid_only_group_sender_is_recorded_unattributable_not_misattributed` | no contact-level opt-out is written against a guessed contact; a warning row/counter is |
| `app/backend/src/modules/pacing/content/fingerprint.integration.test.ts` | `duplicate_fanout_holds_not_fails` | **test 19** — 600 identical bodies → jobs `queued` + `NEEDS_HUMAN_ACK`; after ack they send; nothing failed or deleted |
| `app/backend/src/modules/pacing/content/fingerprint.integration.test.ts` | `re_evaluating_the_same_recipient_does_not_inflate_the_distinct_count` | `[R-27w]` — 50 re-evaluations of one recipient leave `recipient_count = 1` |
| `app/backend/src/modules/pacing/content/fingerprint.integration.test.ts` | `ack_publishes_a_wake_for_every_affected_instance` | a wake is published in the ack's own commit path |
| `app/backend/src/modules/pacing/content/guards.integration.test.ts` | `blocked_word_and_first_message_link_fail_only_that_job` | **test 20** — sibling jobs in the same campaign keep sending |
| `app/backend/src/modules/pacing/content/guards.integration.test.ts` | `blocked_word_reason_never_reveals_the_matched_word_or_list` | response + copy + audit metadata contain a category only |
| `app/backend/src/modules/pacing/content/guards.integration.test.ts` | `link_in_first_message_is_blocked_at_tier_one_and_allowed_at_tier_four` | tier table drives the outcome; a contact with `first_inbound_at` is never blocked |
| `app/backend/src/modules/pacing/content/frequency.integration.test.ts` | `per_recipient_frequency_is_enforced_across_instances` | **test 21** — 4 sends to one contact from 4 instances of the same client → the 4th defers, stays `queued` |
| `app/backend/src/modules/pacing/content/frequency.integration.test.ts` | `frequency_window_is_rolling_and_survives_local_midnight` | blueprint amendment to test 21 — crossing local midnight does not reset the 24 h window |
| `app/backend/src/modules/pacing/content/frequency.integration.test.ts` | `a_group_job_skips_the_frequency_guard_but_not_the_content_guards` | `@g.us` job with a blocked word still fails; a 4th group send is not deferred by frequency |
| `app/backend/src/modules/pacing/guards/pipeline.integration.test.ts` | `deferral_never_increments_attempts_or_fails_the_job` | **test 6 (extended)** — each of `PER_RECIPIENT_FREQ`/`NEEDS_HUMAN_ACK` → `queued`, `attempts` unchanged, `pacing_deferrals + 1`, `next_attempt_at` correct to the second |
| `app/backend/src/modules/pacing/guards/pipeline.integration.test.ts` | `a_terminal_guard_never_consumes_a_pacing_unit` | `pacing_ledger.consumed_count` byte-identical after 100 opt-out and blocked-word disposals |
| `app/backend/src/modules/pacing/guards/pipeline.integration.test.ts` | `a_terminal_guard_disposes_up_to_twenty_five_jobs_in_one_pass` | 1,000 opted-out jobs drain 25 per pass, not 1 per full loop `[R-32s]` |
| `app/backend/src/modules/pacing/guards/pipeline.integration.test.ts` | `no_observer_ever_sees_a_deferred_job_in_processing` | concurrent reader across the defer transaction only ever sees `queued` |
| `packages/domain/src/pacing/send-origin.test.ts` | `campaign_and_inbox_manual_are_explicitly_non_exempt` | both are absent from `EXEMPT_ORIGINS` and present in `NON_EXEMPT_ORIGINS` |
| `app/backend/src/modules/messages/enqueue.test.ts` | `send_origin_cannot_be_supplied_by_a_client` | **test 23** — `origin`, `__systemReply` and header variants all → 400 from the `.strict()` schema |
| `app/backend/src/modules/pacing/internal/system-send.integration.test.ts` | `exempt_origins_are_still_opt_out_blocked_content_guarded_and_window_bound` | all three hold for `system_reply`; `system_count` is incremented and a `pacing_events` row is written |
| `scripts/__tests__/check-send-origin.test.ts` | `exempt_send_origin_outside_pacing_internal_turns_the_guard_red` | planting `SendOrigin.SYSTEM_REPLY` in `modules/messages/` fails the build; the exempt set must equal exactly two members |
| `packages/domain/src/copy/guard-copy.test.ts` | `guard_copy_contains_no_banned_claims` | every string checked against `BANNED_CLAIMS` incl. the Hindi/Hinglish entries |
| `packages/domain/src/copy/guard-copy.test.ts` | `every_deny_reason_has_an_en_and_hi_string` | exhaustive over the `DenyReason` union; a new member without copy fails |
| `db/test/isolation-suite-b.test.ts` | `tenant_b_stop_never_cancels_tenant_a_jobs` | two-tenant run over the guard pipeline and the inbound opt-out hook |
| `db/test/isolation-suite-a.test.ts` | `every_new_guard_table_leads_with_client_id` | the seven new tables; the exemption list is still exactly the delta's three entries |
| `app/backend/test/integration/logging/pacing-log-pii.test.ts` | `no_pii_in_pacing_logs` | **test 32 (extended)** — no E.164, JID, contact name or message body in any guard log line or metric label |

Mandatory-suite tests this phase makes green: Safe Mode suite **6 (extended), 16, 17, 18, 19, 20, 21, 23**, plus the `opt_outs` / `content_fingerprints` rows of **29** and the guard-path extension of **32**. Test **30** (`no_forbidden_mechanism_exists`) and test **22** (`tenant_can_tighten_never_loosen`, from P13) must stay green — re-run both.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (`CI GREEN — all 20 steps passed`, `EXITCODE:0`, 2026-09-02; three earlier gate attempts died at guard steps before any test ran — lint max-lines, depcruise deep-imports, sql-lint DDL false positive — each fixed at the cause).
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: CHANGES-REQUESTED → all findings fixed (F1/F2/F3) → re-review of the fixes: **APPROVED-with-notes** (notes: P21 owns the confirmation sender's production call site + post-commit e2e proof; release() hourly/plan-cap refund asymmetry recorded as a decision).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding — written answers in the session log.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list. Expected set below — correct it, do not trust it. -->
- `db/migrations/0036_optout_and_content_guards.sql` — created (U1; 7 guard tables + `instance_recipient_contacts`, which did NOT exist from P13 — created here per the prerequisite escape hatch)
- `db/schema/{opt-outs,optout-confirmations,tenant-optout-keywords,tenant-blocked-words,content-fingerprints,content-fingerprint-recipients,recipient-send-buckets,instance-recipient-contacts}.ts` — created (U1)
- `db/schema/index.ts` — changed (U1): SCHEMA_TABLES manifest + re-exports
- `db/src/schema-version.ts` — changed (U1): EXPECTED_SCHEMA_VERSION 35→36
- `db/src/isolation/tenant-tables.ts` — changed (U1): +8 coverage entries
- `db/src/isolation/canonical-authority-keys.ts` — changed (U1): opt_outs surrogate-PK entry (authority = opt_outs_lookup partial unique index)
- `scripts/check-tenant-scope.ts` — changed (U1): TENANT_TABLES literal mirror
- `db/tests/optout-content-guards-schema.test.ts` — created (U1)
- `db/queries/{count-fingerprint-recipient,recipient-frequency-window}.sql` — created (U5)
- `db/queries/dispose-job.sql` — created (U6, pending)
- `db/queries/defer-job.sql` — changed: two new deny reasons
- `db/test/isolation-suite-a.test.ts` — changed: seven new tables
- `db/test/isolation-suite-b.test.ts` — changed: guard pipeline + inbound opt-out two-tenant cases
- `db/test/role-grants.snapshot.json` — changed: regenerated
- `packages/domain/src/optout/{normalise.ts,keywords.ts,match.ts}` + `.test.ts` — created (U2)
- `packages/domain/src/content/{normalise-body.ts,link-regex.ts,blocked-word-match.ts}` + `.test.ts` — created (U2)
- `packages/domain/src/pacing/send-origin.ts` + `send-origin.test.ts`, `packages/domain/src/pacing/guard-decision.ts` — created (U2; `deny-reasons.ts` from P13 already carried every P14 member — NOT modified)
- `packages/domain/src/index.ts` — changed (U2): exports
- `packages/domain/src/copy/guard-copy.ts` + `.test.ts` — created (U7: all 17 DenyReason members, en+hi, BANNED_CLAIMS-checked, exhaustiveness-enforced)
- `app/backend/src/modules/pacing/optout/{registry.ts,hash.ts,restore.ts}` + unit tests + `registry.integration.test.ts` — created (U3)
- `app/backend/src/modules/inbound/{optout-detect.ts,metrics.ts}` + `optout-detect.test.ts` — created (U3)
- `db/queries/cancel-optout-jobs.sql` — created (U3)
- `packages/server-kit/src/config/schema.ts` — changed (U3): `optout-pepper` added to `KEK_PURPOSES` (never-rotate HMAC pepper purpose)
- `packages/server-kit/test/fixtures/key-ring.dev.json` + 10 ring-fixture test files — changed (U3): exhaustive purpose records
- `.secrets/dev.env` — changed (U3): `WP_KEK_PURPOSES` now `session,tenant-secrets,user-secrets,optout-pepper` (boot requirement)
- `app/backend/src/modules/pacing/content/{fingerprint.ts,link-guard.ts,blocked-words.ts,recipient-frequency.ts}` + `{fingerprint,guards,frequency}.integration.test.ts` — created (U5; frequency counting convention: buckets hold recorded sends, deny at `>= limit`; fingerprint counter uses one `ON CONFLICT DO UPDATE` writer — data-modifying CTE visibility gotcha documented in the SQL)
- `app/backend/src/modules/pacing/guards/optout-gate.ts` + `optout-gate.integration.test.ts` — created (U4)
- `app/backend/src/modules/pacing/guards/pipeline.ts` + `pipeline.test.ts` + `{pipeline,pipeline-disposal-loop}.integration.test.ts` — created (U6; NEEDS_HUMAN_ACK gets a documented 300s re-check hold to avoid head-of-line starvation; ack resets eligibility)
- `app/backend/src/engine/queue/{send-loop-claim-evaluation.ts,send-loop-guard-pipeline-wiring.ts}` — created (U6, max-lines split); `send-loop-pacing-claim.ts` — changed (U6): 25-disposal loop orchestrator (`MAX_DISPOSALS_PER_PASS=25`); `send-loop-worker-wiring.ts`, `engine/queue/metrics.ts` — changed (U6): `wp_content_guard_trips_total{reason}`, `wp_optout_cancelled_jobs_total`
- `db/queries/defer-job.sql` — created (U6): extracted+extended P13 inline denial write, now clears lease fields + pacing_reserved_at
- `db/migrations/0039_guard_pipeline_scheduler_grants.sql` + `db/src/schema-version.ts` (→39) + `db/schema/grants.snapshot.json` — created/changed (U6; also closes a P13 gap: wp_scheduler UPDATE (pacing_deny_reason, pacing_deferrals) was never granted)
- `app/backend/src/modules/pacing/internal/system-send.integration.test.ts`, `modules/pacing/content/frequency-group-pipeline.integration.test.ts` — created (U6); the three U5 content integration tests — extended (U6: mandatory tests 19, 20, group-skip)
- `db/src/queries.test.ts` — changed (U6): dispose/defer param-order assertions
- E3 edge tests — created: `packages/domain/src/optout/{normalise,match}-edge.test.ts`, `packages/domain/src/content/{blocked-word-match,normalise-body}-edge.test.ts`, `packages/contracts/src/pacing.test.ts`, `app/backend/src/modules/pacing/optout/{hash-edge.test.ts,cancel-optout-jobs-edge.integration.test.ts,optout-confirmation-exact-thirty-day-boundary.integration.test.ts}`
- `packages/domain/src/content/blocked-word-match.ts` — changed (E3 fix): conditional `\b`/lookaround per post-leet edge (punctuation-edged phrases were silently inert)
- C2 tests — created: `app/backend/src/engine/queue/{claim-and-reserve-guard-race,dispatch-optout-precheck-replay}-c2.integration.test.ts`, `modules/pacing/routes/ack-fanout-crash-window-c2.integration.test.ts`, `modules/pacing/optout/optout-replay-c2.integration.test.ts`, `modules/pacing/content/fingerprint-local-midnight-c2.integration.test.ts`, `modules/pacing/guards/pipeline-clock-and-retry-storm-c2.integration.test.ts`, `modules/pacing/internal/system-send-atomicity-c2.integration.test.ts`
- `db/migrations/0040_guard_pipeline_grant_fixes_and_thresholds.sql` + `db/src/schema-version.ts` (→40) + `db/schema/grants.snapshot.json` — created/changed (F1, review fixes: wp_scheduler SELECT/upsert grants for every guard statement — CRITICAL findings 1-3; pacing_profiles NOT NULL + CHECK thresholds; per_recipient_24h seed 1→3 on safe_default/steady per canon)
- F3 (re-review fixes) — changed: `engine/queue/{send-loop-fleet-wiring.ts(+.test.ts),metrics.ts,send-loop-worker-wiring.ts}` (error port + `wp_send_loop_iteration_errors_total{reason}` — the silent-catch CRITICAL), `modules/pacing/internal/system-send.ts(+.test.ts)` (ids-only failure logging), `db/seeds/pacing-profiles.sql` (per_recipient_24h 1→3 for safe_default/steady + correction header), `db/tests/pacing-schema.test.ts` (per-profile threshold pinning test)
- C5 depcruise fix (main session): `modules/pacing/index.ts` (opt-out registry/hash/restore re-exports — module public surface; internal/system-send deliberately excluded), import reroutes in `modules/messages/messages.service.ts`, `modules/inbound/optout-detect.ts`, `modules/pacing/internal/system-send.ts` (deep module imports → module indexes)
- C5 lint trims (main session): `db/src/schema-version.ts` (per-migration history prose removed — migration files are the authoritative copy; 304→18 lines), `modules/tenancy/__tests__/tenancy-routes-test-support.ts` (308→298; U4's unreported stubKeyProvider addition had breached the cap), `modules/messages/enqueue.integration.test.ts` (302→300) — comment-only edits
- F2 (review fixes 4-12, 14 + C2 note) — changed: `engine/queue/{send-loop-guard-pipeline-wiring.ts(+.test.ts),dispatch-optout-precheck.ts(+.test.ts),dispatch.ts,send-loop-claim-evaluation.ts,send-loop-pacing-claim.ts(+.test.ts)}`, `modules/pacing/content/{recipient-frequency.ts(+.test.ts),blocked-words.ts}`, `modules/inbound/optout-detect.ts(+.test.ts)` (onOptedOut port → post-commit return-value contract), `modules/pacing/internal/system-send.ts`, `modules/pacing/optout/restore.ts(+OptOutNotFoundError)`, `modules/pacing/routes/ack-fanout.ts` (noop-ack audit code), `modules/pacing/guards/pipeline.ts`, `engine/pacing/index.ts`, `modules/pacing/pacing.repo.ts`, `modules/queue/queue.repo.ts` (isExempt threading), `db/queries/{pacing-deny-reason,release-pacing,defer-job}.sql` (exempt ladder; exempt refund branch; lease guard), `packages/domain/src/content/blocked-word-match.ts` (prepared-entries), `db/tests/grants-scheduler-columns.test.ts`, `db/schema/pacing-profiles.ts`, 4 fixture-fallout test files; created: `modules/pacing/guards/pipeline-scheduler-role.integration.test.ts` (4 cases under real wp_scheduler — finding 4's structural fix)
- `app/backend/src/modules/pacing/internal/system-send.ts` + `system-send.test.ts` — created (U4; 30-day guard atomic with the durable enqueue; e2e integration test lands with U6)
- `app/backend/src/engine/queue/dispatch-optout-precheck.ts` + `.test.ts` — created (U4; pre-send last line of defence, `'cancelled_pre_send'` outcome, PRECHECK_FAILED refund after commit)
- `app/backend/src/modules/pacing/optout/{registry-optout-enforcement,optout-confirmation-thirty-day-guard,optout-confirmation-window-deferral}.integration.test.ts` — created (U4; test-16 family split across siblings for the 300-line cap)
- `db/queries/claim-jobs.sql` — changed (U4): RETURNING widened with recipient_hash, send_origin, content_fingerprint
- `db/queries/reserve-pacing.sql`, `app/backend/src/engine/pacing/index.ts`, `app/backend/src/modules/pacing/pacing.repo.ts` — changed (U4): `$is_exempt` branch — exempt origins bypass caps/gap/cold-ratio, keep the window, `system_count+1`, no `next_eligible_at` advance
- `db/queries/pacing-deny-reason.sql` — changed (U4): OUTSIDE_WINDOW branch added (genuine P13 gap — window denies previously fell through to UNKNOWN)
- `app/backend/src/engine/queue/{send-loop.ts,result.ts}` — changed (U4): DispatchInput/ResolveAckInput threading; `recipient_send_buckets` upsert in resolveAck (skipped for @g.us)
- `app/backend/src/modules/queue/queue.repo.ts` — changed (U4): ClaimedJob widened
- `app/backend/src/modules/messages/{messages.service.ts,messages.repo.ts}` + `enqueue.test.ts` — changed/created (U4): 422 RECIPIENT_OPTED_OUT, recipient_hash + typed send_origin at insert (mandatory test 23)
- 8 pre-existing integration test files + 2 shared fixtures — changed (U4): DispatchInput literals widened; bucket/pacing_events teardown deletes
- `db/migrations/0037_claim_optout_grants.sql` — created (U4, initially unreported): wp_scheduler SELECT on the three widened RETURNING columns
- `db/migrations/0038_pacing_events_system_send_kind.sql` + `db/src/schema-version.ts` (36→38) + `db/schema/pacing-events.ts` — created/changed (U4b): SYSTEM_SEND kind for exempt-send pacing_events; system-send.ts flipped from CONFIG_CHANGE
- `app/backend/src/modules/pacing/routes/{ack-fanout.ts,ack-fanout.routes.ts}` + `ack-fanout.integration.test.ts`, `modules/pacing/index.ts` — created (U7; session-policy only — no API-key path; ack resets `next_attempt_at=now()` + publishes wake per affected instance after commit); `app/backend/src/platform/http/server.ts` — changed (U7): optional `pacing` dep
- `packages/contracts/src/pacing.ts` — created (U7); `packages/contracts/src/index.ts` — changed
- `app/frontend/src/features/pacing/{api.ts,useDuplicateFanoutAcks.ts,DuplicateFanoutBanner.tsx,index.ts}` + banner test — created (U7); `packages/i18n/src/catalogues/{en.ts,hi.ts}` — changed (U7): `pacing.fanoutBanner.*`
- `scripts/guards/send-origin-exempt-shape.ts` (clause 3) + fixture + `scripts/guards/check-send-origin.test.ts` extension — created/changed (U7); `scripts/check-send-origin.ts`, `scripts/guards/registry.ts` (activatesIn removed; guard now matches 196 files) — changed (U7)
- `app/backend/src/engine/queue/guard-isolation.e2e.integration.test.ts` — created (U7): tenant_b_stop_never_cancels_tenant_a_jobs + cross-tenant blocked-word non-interference
- `app/backend/src/modules/pacing/guards/guard-pipeline-log-pii.integration.test.ts` + `__tests__/` support — created (U7): mandatory test 32 extension over the guard paths
- `app/backend/src/modules/messages/enqueue.ts` — changed: opt-out 422 + `.strict()` origin rejection
- `app/backend/src/modules/queue/send-transaction.ts` — changed: pre-send opt-out check + `recipient_send_buckets` write
- `app/backend/src/roles/send-worker.ts` — changed: guard pipeline + 25-disposal inner loop
- `app/frontend/src/features/pacing/DuplicateFanoutBanner.tsx` — created
- `scripts/check-send-origin.ts` — changed: `activatesIn` removed, clause 3 added
- `scripts/ci.ps1`, `scripts/ci.sh` — changed: reactivated guard step
- `app/backend/test/integration/logging/pacing-log-pii.test.ts` — changed: guard paths

## Risks / gotchas specific to this phase
- **`cancelled`, not `failed` — the older design text is wrong.** Safe-mode design §3.3 writes `status='failed', error_code='OPT_OUT'`; the blueprint amends this (`[R-28c]`, tests 16/18) to `cancelled` + `cancel_reason='opt_out'`. An opt-out is not the tenant's send failure and must never enter a health denominator. If a copied SQL snippet says `failed`, it is stale.
- **The duplicate-fan-out counter must never be an increment.** Guards re-evaluate on every claim attempt, so `recipient_count = recipient_count + 1` inflates a 200-recipient campaign into a `NEEDS_HUMAN_ACK` within one pass. Insert into `content_fingerprint_recipients` with `ON CONFLICT DO NOTHING` and bump the parent **only when a row was inserted** `[R-27w]`.
- **`NEEDS_HUMAN_ACK` must never auto-fail and must never strand.** Jobs stay `queued` (invariant 5). The ack path must publish the wake in its own commit path; without it the acked jobs sit until the ≤42 s safety poll and the tenant reports "ack did nothing".
- **`@wp/domain` cannot hash.** `domain-must-be-pure` blocks `node:crypto`. Fingerprinting and `phone_hash` are server-side (`modules/pacing/optout/hash.ts`); domain exports the *normalisation* only. Trying to `sha256` inside domain will turn dependency-cruiser red mid-step.
- **Enum casing.** DB labels are lowercase (`enum_parity_db_vs_domain`, test 23); the TS constant identifiers are `SYSTEM_REPLY` / `OPT_OUT_CONFIRMATION` because `check-send-origin` scans identifiers. Keep both and let the parity test compare label sets, not identifiers.
- **Group jobs are exempt from exactly two things.** `is_group` (derived from `recipient_jid LIKE '%@g.us'`, **not** a new column) removes a job from the opt-out gate and the per-recipient frequency guard only. Content guards and the sending window still apply, and the group cap already lives inside `pacing.reserve()` from P13 — do not add a second grantor here (mandatory test 22).
- **Frequency is per client, deliberately.** Splitting the same audience across a second instance must not raise how often a person can be messaged. That property is the reason the guard is client-scoped; it exists so the product never nudges a customer toward hand-rolled number rotation. Do not "optimise" it to per-instance for index reasons.
- **No removal path for platform keywords or platform blocked words.** A tenant-settable switch that loosens a limit is a forbidden mechanism (safety skill; invariant 6). Additive only, enforced in the schema grant and in the resolver, with a test.
- **Do not build a filter-tuning oracle.** The blocked-word response returns a category, never the matched word or the list. The same applies to logs, audit metadata and the panel.
- **The opt-out row outlives the contact.** Per-contact erasure (P20) soft-deletes the contact; the hashed `opt_outs` row survives forever, because deleting an opt-out is how you re-message someone who said stop. Do not add a cascade.
- **PII discipline.** `opt_outs` indexes a hash; the display value is envelope-encrypted. No phone number, JID, name or body in any log line or metric label — `wp_content_guard_trips_total` is labelled by `reason` only, never by client or instance (the four-gauge allow-list).
- **Honest copy only.** Guard strings say what happened, what is preserved and what the user can do. Nothing here may imply that guards prevent restrictions; `SAFE_MODE_DISCLAIMER` co-presence and `BANNED_CLAIMS` (including the Hinglish entries) are enforced by `check-copy`.
- **Descoped on purpose, carried forward:** the full opt-out management screen (list, search, manual add, CSV import of opt-outs, restore UI) belongs to **P20 contacts-and-import**; this phase ships the API + registry + the ack banner only. Write that line into the P20 file at C6 rather than leaving it in someone's head.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P15 — outbox-relay-and-webhooks. Read plan/v1/P15-outbox-relay-and-webhooks.md and follow it exactly:
one phase, one session. Deps P12 and P05 are done (see plan/README.md). Do not start P16.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
