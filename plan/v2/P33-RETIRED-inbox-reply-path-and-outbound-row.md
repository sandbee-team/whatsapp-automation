# P33 — inbox-reply-path-and-outbound-row

> **RETIRED 2026-09-11 (founder, ADR 0051):** *"V2 me inbox ke alawa all thing hame karna hai, inbox add hi nahi karna
> hai."* / *"hame real chat yaha show karni hi nahi hai."* The inbox product is not part of v2. This file is kept for the
> record (memory protocol: never delete); its number is never reused; do not start it. Former slug: `P33-inbox-reply-path-and-outbound-row`.


**Goal (one line):** a reply typed in the panel thread becomes an ordinary durable job that obeys the
instance's configured sending window, cap, gap, opt-out and wallet exactly like every other send, appears
in the thread as `queued` and only ticks to `sent`, and the send-result/echo race is fixed so exactly one
`message_wa_ids` row, one `messages` row and one wallet debit exist regardless of arrival order.
**Status:** retired (2026-09-11, ADR 0051 - inbox removed from v2) · **Size:** M · **Session:** 1 of 1
**Depends on:** P32 (must be `done`)
**Blocks:** P34, P35 (both currently outline rows; cut when this phase closes, per the three-at-a-time rule)

> **V2-P3 mapping (ADR 0043).** This file implements the third third of the V2-P3 outline row (reply path).
> After this phase the inbox product is coherent end-to-end for text; media (P34) and retention (P35) are
> explicitly out and both default OFF so nothing here is blocked on them.

## Prerequisites (facts, not phases)
- Postgres **17** + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean; quick gate
  `pnpm run typecheck && pnpm run guards:meta` green on the tree as found (SESSION-PROTOCOL **O2**).
- **P32 landed:** chat list + thread read routes, `chat.updated`/`message.received` SSE, the panel thread UI
  (read-only), unread counters, the dead-letter chip. **P31 landed:** `chats`/`messages`/`media_assets`
  schema, the inbound capture transaction under `wp_scheduler`.
- Migrations stay at schema version **78** — **this phase adds no migration.**
- **ADR 0043 and ADR 0046 are both founder-accepted.**
- **This is a MONEY SURFACE** (core invariant list item 3/5, ADR 0019). The existing wallet debit-at-`sent`
  path, `wallet_charge_guards`, and the retry matrix are reused unchanged — no new money path is invented.
- `engine/queue/result.ts:158-169`'s `message_wa_ids (direction='out')` insert has **no `ON CONFLICT`
  clause** today and sits inside the wallet-lock transaction — this is a **latent production bug** that this
  phase must fix FIRST, before building the reply path on top of it (ADR 0046 §3a).
- **P31's migration 0077 granted `wp_scheduler` INSERT on `messages` and column-scoped UPDATE on `chats`
  INCLUDING `last_outbound_at`** (ADR 0046 §2 table) — verify at O2; a gap there is a P31 defect fixed by
  `/decide`, not a migration added here (this phase stays migration-free, see below).
- ADR 0003 holds: no git, ever. "Files created or changed" is the diff.

## What you are building
- **The prerequisite bug fix**: `result.ts`'s `message_wa_ids` insert becomes `ON CONFLICT (client_id,
  instance_id, direction, wa_msg_id) DO UPDATE SET message_id = EXCLUDED.message_id, message_created_at =
  EXCLUDED.message_created_at WHERE message_wa_ids.message_id IS NULL` — an echo arriving before the ack must
  no longer roll back the wallet debit and the `status='sent'` update.
- **The send-result transaction gains ownership of `messages (direction='out')`**: after the wallet writes,
  it appends `messages` + `chats.last_outbound_at` (statement order `message_wa_ids → messages → chats`,
  per P23a's established append idiom). `echo-capture.ts` changes to an **update-only** path when a
  `messages` row already exists for the id — it never creates one.
- **The reply route**: `POST /v1/chats/:chatId/reply` (agent+ role) — reuses the existing messages-enqueue
  service, `priority='high'`, `send_origin='inbox_manual'`, `is_new_conversation=false`, mandatory
  `Idempotency-Key`. No new guard, no new exemption: the instance's **configured** sending window (never a
  literal), cap, gap, opt-out (422 on an opted-out contact) and wallet (empty/frozen ⇒ stays queued) all apply.
- **The reply composer UI**: `features/inbox/components/reply-composer.tsx` with a window notice that
  interpolates the instance's resolved `eff_window_start_local`/`eff_window_end_local` — never a literal
  time (the ADR's corrected finding: a hardcoded "09:00" would be wrong for every non-default profile).
- **The both-orderings concurrency test**: exactly one `message_wa_ids` row, one `messages` row and one
  wallet debit whether the echo or the send-result ack arrives first.
- **The inbox isolation-suite-B extension** covering the reply/send path and the edge/concurrency pass.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| ADR (opening order) | `.memory/decisions/0043-v2-opening-order-and-phase-numbering.md` | all |
| ADR (data model) | `.memory/decisions/0046-inbox-product-data-model-and-message-lifecycle.md` | §3, §3a (the echo-race fix, read this FIRST), §8 |
| Design doc | `.memory/research/2026-09-11-v2-inbox-design.md` | §3 (lifecycle), §8 (P33 dispatch plan) |
| Phase file | `plan/v2/P32-inbox-read-api-realtime-and-thread-ui.md` | "Files created or changed" (exact route/contract shapes landed) |
| ADR (money) | `.memory/decisions/0019-wallet-and-per-message-metering.md` | debit fires once at `sent`, keyed on `send_attempts.id` — no new money path |
| Invariants | `.claude/rules/core-invariants.md` | all, esp. 1 (durable-first), 3 (idempotency), 6 (no evasion — no window exemption without a written yes) |
| Path rules | `.claude/rules/database.md`, `.claude/rules/api.md` | all |
| v1 module (fix target) | `app/backend/src/engine/queue/result.ts` | lines ~158-169, the `message_wa_ids` insert this phase makes idempotent |
| v1 module (update path) | `app/backend/src/modules/queue/echo-capture.ts` | becomes update-only when a `messages` row exists |
| Precedent (effective window resolution) | `packages/domain/src/pacing/resolve-effective.ts` | narrowest-wins intersection across plan/client/instance |
| Precedent (enqueue reuse) | P23a's broadcast composer's use of the messages enqueue service | the pattern this phase's reply route copies, not reinvents |

## Dispatch plan (written at cut time, per SESSION-PROTOCOL E1)

**Units (order; ‖ = parallel):** U1 (solo, money surface — must land first) → U2 (serial after U1) → U3
(serial after U2) → U4 (serial, extends U1-U3's surface).

- **U1** (implementer, solo — money + the prerequisite bug fix, never parallel with anything touching
  `result.ts`/`echo-capture.ts`): steps 2, 3, 4, 5. Files: `engine/queue/result.ts` (changed),
  `modules/queue/echo-capture.ts` (changed), `engine/queue/result-echo-race.integration.test.ts`.
- **U2** (implementer, serial after U1 — depends on the fixed `result.ts` write path existing): steps 6, 7.
  Files: `app/backend/src/modules/inbox/routes.ts` (changed: + reply route),
  `packages/contracts/src/app/inbox.ts` (changed: write half appended to P32's read half),
  `app/backend/test/integration/inbox/reply.integration.test.ts`,
  `app/backend/src/modules/inbox/reply-idempotency.integration.test.ts`.
- **U3** (ui-implementer, serial after U2 — needs the reply route's real response shape): steps 8, 9. Files:
  `app/frontend/src/features/inbox/components/reply-composer.tsx` + `.test.tsx`,
  `app/frontend/src/routes/_authed/inbox.$chatId.tsx` (changed: composer wired in).
- **U4** (implementer, serial — extends the isolation-suite-B file U1-U3 exercised): step 10. Files:
  `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts` (extended, not replaced —
  coordinate with P31/P32's existing cases in the same file).

**Shared contracts named up front:** the reply route's request/response shape
(`replyBody`/`jobResponse` per the design doc's route table) is fixed by U2 before U3 writes the composer
against it. The fixed `message_wa_ids` conflict clause and the `messages`-ownership rule (send-result owns
creation, echo-capture only updates) are fixed by U1 and must not be re-touched by U2/U3/U4. After U1 lands,
run `pnpm vitest run app/backend/src/engine/queue app/backend/src/modules/queue` once before starting U2 —
this is a money/idempotency surface and a regression here is not caught by U2/U3's own test scopes.

## Ordered minimum steps
- [ ] 1. Write the failing tests first (all red, none skipped) → `app/backend/src/engine/queue/result-echo-race.integration.test.ts`,
      `app/backend/src/modules/inbox/routes.test.ts` (reply cases), `app/backend/test/integration/inbox/reply.integration.test.ts`.
- [ ] 2. **The prerequisite fix, alone, before anything else in this phase** — `engine/queue/result.ts`'s
      `message_wa_ids` insert gains the `ON CONFLICT ... WHERE message_wa_ids.message_id IS NULL` clause;
      add a regression test proving an echo-before-ack no longer rolls back the debit.
- [ ] 3. `result.ts` (changed) — after the wallet writes, append `messages (direction='out', status='sent')`
      + `chats.last_outbound_at` update, in the established statement order.
- [ ] 4. `modules/queue/echo-capture.ts` (changed) — take the **update** path (fills `content_hash`,
      `observed_at` only) when a `messages` row already exists for the `wa_msg_id`; never creates one.
- [ ] 5. The both-orderings concurrency test: one `message_wa_ids` row, one `messages` row, one wallet debit
      — echo-first and send-result-first, both proven.
- [ ] 6. The reply route: `POST /v1/chats/:chatId/reply` → validates, reuses the enqueue service, mandatory
      `Idempotency-Key`, no new guard exemption → `modules/inbox/routes.ts` (changed), contract addition to
      `packages/contracts/src/app/inbox.ts` (changed: write half appended to P32's read half).
- [ ] 7. Guard tests: a reply outside the configured window queues rather than sends; a reply to an
      opted-out contact is 422; a reply against an empty wallet stays queued, nothing failed/deleted.
- [ ] 8. `features/inbox/components/reply-composer.tsx` — text input, send button, window notice
      interpolating the resolved window, pending-state rendering (queued clock icon → ticks on receipt).
- [ ] 9. Wire the composer into `/_authed/inbox/$chatId` (P32's thread route); `pending tail` continues to
      read from `message_jobs`, never optimistically upgrades to sent.
- [ ] 10. The inbox isolation-suite-B extension (reply/send path) + the edge/concurrency pass (test-engineer
      territory, but the phase's own named cases go here first).

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/engine/queue/result-echo-race.integration.test.ts` | `an_echo_arriving_before_the_ack_no_longer_rolls_back_the_wallet_debit` | regression proof for the prerequisite fix |
| `app/backend/src/engine/queue/result-echo-race.integration.test.ts` | `an_echo_arriving_BEFORE_the_ack_still_leaves_one_wa_id_row_one_messages_row_and_one_wallet_debit` | both orderings, exact counts |
| `app/backend/src/engine/queue/result-echo-race.integration.test.ts` | `send_result_first_ordering_is_unchanged_from_today` | regression: the non-race path still works |
| `app/backend/src/modules/inbox/routes.test.ts` | `a_reply_creates_a_durable_job_and_never_touches_a_socket` | durable-first, invariant 1 |
| `app/backend/test/integration/inbox/reply.integration.test.ts` | `a_reply_outside_the_instances_configured_window_is_queued_not_sent` | window read from `instance_pacing_state`, not a constant |
| `app/backend/test/integration/inbox/reply.integration.test.ts` | `a_reply_to_an_opted_out_contact_is_rejected_with_422_not_a_silent_send` | opt-out gate applies, no exemption |
| `app/backend/test/integration/inbox/reply.integration.test.ts` | `a_reply_against_an_empty_wallet_stays_queued_nothing_failed_or_deleted` | wallet gate, invariant 5 |
| `app/backend/test/integration/inbox/reply.integration.test.ts` | `a_paused_instance_keeps_its_queued_reply_and_its_chat_rows_untouched` | pause preserves work |
| `app/backend/src/modules/inbox/routes.test.ts` | `an_inbox_reply_is_not_exempt_from_window_cap_gap_or_optout` | no evasion, invariant 6 |
| `app/frontend/src/features/inbox/components/reply-composer.test.tsx` | `the_composer_notice_renders_the_instances_effective_window_not_a_literal` | interpolated value, never "09:00" |
| `app/frontend/src/features/inbox/components/reply-composer.test.tsx` | `no_unsent_reply_ever_renders_as_sent` | pending tail vs sent state |
| `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts` (extended) | `a_reply_enqueued_under_tenant_a_is_never_visible_to_tenant_b` | two-tenant reply-path proof |
| `app/backend/src/modules/inbox/reply-idempotency.integration.test.ts` | `a_replayed_reply_request_with_the_same_idempotency_key_returns_the_original_job` | no duplicate enqueue on retry |

Mandatory-suite tests this phase makes green: **none new from the blueprint's numbered tables.** Closes
ADR 0046 §3a's prerequisite bug. Extends isolation suite B (reply/send path).

**Demonstrable outcome:** a reply typed in the panel becomes a durable job that obeys the instance's
configured window, cap, gap, opt-out and wallet; it appears in the thread as `queued` and only ticks at `sent`.

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
- **The prerequisite fix (step 2) must land and be proven BEFORE step 3 builds on it.** Building the
  outbound `messages` write on top of the still-buggy `message_wa_ids` insert reproduces the exact race the
  ADR found — sequence, do not parallelize, steps 2→3→4→5.
- **No new money path.** The debit still fires once at `sent`, keyed on `send_attempts.id`
  (`wallet_charge_guards`); a reply is priced `text`/`media` (or `group_text`/`group_media`) exactly like
  any other send. Any change to when/how money moves here is out of scope and a `/decide`.
- **No window exemption.** Founder open question 3 (may a reply to a conversation with a recent inbound
  message skip the sending window?) is unanswered; the stated default is **no exemption**. Do not build one
  "for convenience" — a loosening ships only on a written yes, per core invariant 6.
- **The window notice must interpolate, never hardcode.** The ADR's own first draft hardcoded "09:00" and
  was wrong against the shipped 08:00-20:00 seed; the composer test exists specifically to catch this class
  of regression again.
- **Echo-capture becomes update-only for `messages`.** If it still creates a `messages` row on some code
  path, both orderings can produce two `messages` rows for one wa_msg_id — the concurrency test's whole
  point is to catch exactly that.
- **`message_wa_ids.inbox_message_id` under a NOT-NULL-once-set discipline is the real uniqueness authority**
  for "exactly one outbound body row" — a partial unique index on `messages` cannot serve (a partitioned
  table's unique constraint must include `created_at`, which is not the identity).
- **This closes the last of P31-P33's mandatory infrastructure for the inbox's text path.** P34 (media) and
  P35 (retention) stay outline rows and are NOT started here even if time remains in the session — cutting
  them is a separate planner dispatch after this phase's C6.
- **Test file placement / PowerShell gate rules**: same as P31/P32 — stub-env import first for unit tests
  reaching `@wp/server-kit`; `powershell -File scripts/gate.ps1` is the only gate entrypoint.
- **No ambient-state assertions** in the concurrency test — assert the exact row/debit counts under an
  injected ordering, never a sampled race outcome.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
P31-P33 close the V2-P3 inbox product's first three sessions (write path / read path / reply path).
P34 (inbox-media-pipeline-and-object-store-extension) and P35
(inbox-retention-erasure-and-isolation-suites) are still OUTLINE ROWS in plan/v2/README.md — cut them with
the planner only after this phase's C6, per the three-at-a-time rule (plan/README.md folder rules).
Do not start P34 or P35 in this session.
```
