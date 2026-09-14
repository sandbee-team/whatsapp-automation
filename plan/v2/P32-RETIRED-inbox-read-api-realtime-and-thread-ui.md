# P32 — inbox-read-api-realtime-and-thread-ui

> **RETIRED 2026-09-11 (founder, ADR 0051):** *"V2 me inbox ke alawa all thing hame karna hai, inbox add hi nahi karna
> hai."* / *"hame real chat yaha show karni hi nahi hai."* The inbox product is not part of v2. This file is kept for the
> record (memory protocol: never delete); its number is never reused; do not start it. Former slug: `P32-inbox-read-api-realtime-and-thread-ui`.


**Goal (one line):** a tenant with viewer+ role can see their conversation list and a chat thread live in
the panel — chat list + thread read routes, `chat.updated`/`message.received` SSE events, unread badges that
clear on read, and a read-only dead-letter chip — with no migration and no reply capability yet.
**Status:** retired (2026-09-11, ADR 0051 - inbox removed from v2) · **Size:** M · **Session:** 1 of 1
**Depends on:** P31 (must be `done`)
**Blocks:** P33

> **V2-P3 mapping (ADR 0043).** This file implements the second third of the V2-P3 outline row (read path
> only). Reply/send stays P33.

## Prerequisites (facts, not phases)
- Postgres **17** + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean; quick gate
  `pnpm run typecheck && pnpm run guards:meta` green on the tree as found (SESSION-PROTOCOL **O2**).
- **P31 landed:** `chats`, `messages`, `media_assets`, `chat_read_state`, the inbound capture transaction
  writing real rows under `wp_scheduler`, the partition-maintenance loop, isolation suite A/B coverage.
- Migrations stay at schema version **78** — **this phase adds no migration.** If a step here seems to need
  a schema change, it is out of scope; check with `db-engineer` before writing SQL.
- **ADR 0043 and ADR 0046 are both founder-accepted** (same precondition as P31; if P31 closed, this already
  holds unless the founder's acceptance was phase-scoped — confirm at O2).
- The realtime SSE bridge (`packages/contracts/src/app/realtime.ts`, ADR 0028) and
  `app/frontend/src/lib/sse-invalidation-map.ts` exist and are the extension points — P17/P23a's idiom, not
  a new mechanism.
- `packages/contracts/src/app/webhooks.ts` derives `WEBHOOK_EVENT_TYPES` as `REALTIME_EVENT_TYPES` minus
  `WEBHOOK_EXCLUDED_EVENT_TYPES` — naming a new realtime event type without excluding it makes it
  tenant-webhook-subscribable by default (ADR 0046 §4).
- ADR 0003 holds: no git, ever. "Files created or changed" is the diff.

## What you are building
- **Chat list + thread read routes**: `GET /v1/chats` (keyset on `(last_message_at, id)` DESC), `GET
  /v1/chats/:chatId`, `GET /v1/chats/:chatId/messages` (keyset on `(created_at, id)` DESC + pending tail from
  `message_jobs`), `POST /v1/chats/:chatId/read` (agent+, writes `chat_read_state`, zeroes `unread_count`),
  `GET /v1/inbound-dead-letters` (viewer+, read-only, keyset).
- **Two new realtime event types**: `chat.updated` and `message.received`, both with a mandatory non-null
  `coalesce_key = 'chat:<chatId>'`, both added to `WEBHOOK_EXCLUDED_EVENT_TYPES` (not a public webhook
  surface yet), payloads ids/counts only (≤1024 bytes), wired through the existing outbox → relay → SSE path.
- **Panel routes**: `/_authed/inbox` (conversation list, unread badges, instance filter, dead-letter chip),
  `/_authed/inbox/$chatId` (thread view, pending tail, contact sidebar reusing the P20 contact detail panel).
  No reply composer yet (P33).
- **The `metadata_only`-impersonation guard**: a staff impersonation session scoped `metadata_only` must not
  be able to read `messages.body` through the thread route — an explicit test, not an assumption.
- **`inboxKeys`** TanStack Query factory + `sse-invalidation-map.ts` entries mapping `chat.updated` →
  `[inboxKeys.list(), inboxKeys.thread(chatId), inboxKeys.unread()]` and `message.received` →
  `[inboxKeys.thread(chatId)]`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| ADR (opening order) | `.memory/decisions/0043-v2-opening-order-and-phase-numbering.md` | all |
| ADR (data model) | `.memory/decisions/0046-inbox-product-data-model-and-message-lifecycle.md` | §4 (realtime), §8 (isolation), §10 (authorization) |
| Design doc | `.memory/research/2026-09-11-v2-inbox-design.md` | §4 (routes), §5 (panel routes), §8 (P32 dispatch plan) |
| Phase file | `plan/v2/P31-inbox-schema-and-inbound-capture.md` | "Files created or changed" (exact schema shape landed) |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/api.md` | all |
| Precedent (SSE invalidation) | `app/frontend/src/lib/sse-invalidation-map.ts`, P23a's `campaign.progress` entry | the exact idiom to copy |
| Precedent (auth model) | ADR 0028; any existing route's `policy: 'session'` usage | there is no scope vocabulary — min membership role only |
| Precedent (keyset envelope) | any P20/P23a list route | `{data:{items}, meta:{requestId, nextCursor?}}`, no OFFSET ever |

## Dispatch plan (written at cut time, per SESSION-PROTOCOL E1)

**Units (order; ‖ = parallel):** (U1 ‖ U2) → U3 (serial after U1+U2) → U4 (serial).

- **U1** (implementer, parallel with U2 — disjoint files): steps 2, 3. Files:
  `app/backend/src/modules/inbox/{routes,routes-support,unread}.ts` + tests,
  `packages/contracts/src/app/inbox.ts` (NEW — read half) + its export in
  `packages/contracts/src/app/index.ts`,
  `app/backend/test/integration/inbox/thread.integration.test.ts`.
- **U2** (implementer, parallel with U1 — disjoint files): steps 4, 5. Files:
  `packages/contracts/src/app/{realtime,webhooks}.ts` + tests,
  `app/backend/src/modules/inbox/capture.ts` (changed: adds the `message.received` emit call site alongside
  P31's already-shipped `chat.updated` emit, same position/coalesce_key — do not restructure its transaction).
- **U3** (ui-implementer, serial after U1+U2 — needs both contracts and the two SSE event types to exist):
  steps 6, 7, 8. Files: `app/frontend/src/features/inbox/{api,keys}.ts`,
  `components/{conversation-list,thread,message-bubble,contact-sidebar,unread-badge,dead-letter-chip}.tsx`,
  `routes/_authed/inbox.tsx`, `routes/_authed/inbox.$chatId.tsx`, `lib/sse-invalidation-map.ts`, `lib/sse.test.ts`.
- **U4** (implementer + ui-implementer, serial): steps 9, 10. Files:
  `app/backend/test/integration/inbox/thread.integration.test.ts` (impersonation case added),
  `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts` (extended),
  `app/frontend/src/components/app-shell.tsx` (nav link), `packages/i18n/src/catalogues/{en-inbox,hi-inbox}.ts`
  (new siblings, following the `en-broadcasts.ts` idiom), `scripts/guards/check-copy.test.ts` (+1 case),
  the panel-proof test.

**Shared contracts named up front:** the `inboxKeys` factory shape (`list()`, `thread(chatId)`, `unread()`)
is fixed by U3 before U4 touches the invalidation map further. `chat.updated`/`message.received` payload
shape (ids/counts only) is fixed by U2 and consumed unchanged by U3. Route response envelopes
(`{data:{items}, meta:{requestId, nextCursor?}}`) are fixed by U1 and consumed unchanged by U3's `api.ts`.
After U1+U2 land, run
`pnpm vitest run app/backend/src/modules/inbox packages/contracts/src/app` once before starting U3.

## Ordered minimum steps
- [ ] 1. Write the failing tests first (all red, none skipped) → `app/backend/src/modules/inbox/routes.test.ts`,
      `app/backend/test/integration/inbox/thread.integration.test.ts`,
      `app/frontend/src/features/inbox/__tests__/{conversation-list,thread}.test.tsx`.
- [ ] 2. `modules/inbox/{routes,routes-support,unread}.ts` — chat list, chat detail, thread (keyset + pending
      tail from `message_jobs`), mark-read, dead-letter list routes; every route `policy: 'session'` + min
      membership role per ADR 0046 §10.
- [ ] 3. `packages/contracts/src/app/inbox.ts` (NEW — read half) + its export in
      `packages/contracts/src/app/index.ts` — `.strict()` zod contracts for all five routes.
- [ ] 4. `packages/contracts/src/app/realtime.ts` + `webhooks.ts` (changed) — `chat.updated` and
      `message.received` event types, both with mandatory `coalesce_key`, both added to
      `WEBHOOK_EXCLUDED_EVENT_TYPES`.
- [ ] 5. Add the `message.received` emit alongside P31's already-shipped `chat.updated` emit in `capture.ts` —
      same position in the statement order, same `coalesce_key = 'chat:<chatId>'`, ids/counts only. The rest
      of P31's transaction statement order is frozen (see Risks).
- [ ] 6. `app/frontend/src/features/inbox/{api.ts,keys.ts}` + `lib/sse-invalidation-map.ts` (changed) — fetch
      functions, `inboxKeys` factory, the two new invalidation-map entries + `lib/sse.test.ts` (changed).
- [ ] 7. `app/frontend/src/features/inbox/components/{conversation-list,unread-badge,dead-letter-chip}.tsx` +
      `routes/_authed/inbox.tsx` — keyset-paginated list, instance filter, unread badges, dead-letter chip.
- [ ] 8. `app/frontend/src/features/inbox/components/{thread,message-bubble,contact-sidebar}.tsx` +
      `routes/_authed/inbox.$chatId.tsx` — thread view (virtualised if the UI kit supports it, plain list
      otherwise), pending tail rendering, contact sidebar reusing P20's contact detail panel.
- [ ] 9. The `metadata_only`-impersonation test + panel wiring (nav link, i18n en+hi, `check-copy` pass).
- [ ] 10. Panel proof: an injected `message.received` event invalidates `inboxKeys.thread(chatId)` and the
      thread re-renders the new message; the unread badge clears on mark-read → component test or Playwright
      journey.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/modules/inbox/routes.test.ts` | `chat_list_uses_keyset_pagination_never_offset` | cursor shape, no OFFSET in the generated SQL |
| `app/backend/src/modules/inbox/routes.test.ts` | `an_inbox_reply_route_does_not_exist_yet` | mechanical guard that P32 ships no write/send route |
| `app/backend/test/integration/inbox/thread.integration.test.ts` | `a_metadata_only_impersonation_session_cannot_read_message_body` | body field absent/null under that impersonation scope |
| `app/backend/test/integration/inbox/thread.integration.test.ts` | `the_thread_route_includes_the_pending_tail_from_message_jobs` | a not-yet-sent job renders `queued`, never `sent` |
| `app/backend/src/modules/inbox/unread.test.ts` | `unread_is_a_counter_and_no_query_counts_rows_in_messages` | source scan + EXPLAIN — no `COUNT(*)` over `messages` |
| `app/backend/src/modules/inbox/routes.test.ts` | `mark_read_zeroes_unread_count_and_writes_chat_read_state` | both effects in one statement/transaction |
| `packages/contracts/src/app/realtime.test.ts` (changed) | `chat_updated_and_message_received_always_carry_a_non_null_coalesce_key` | schema-level guarantee, mirrors the outbox CHECK |
| `packages/contracts/src/app/webhooks.test.ts` (changed) | `the_two_new_inbox_events_are_excluded_from_the_public_webhook_surface` | `WEBHOOK_EVENT_TYPES` does not contain either |
| `app/frontend/src/lib/sse.test.ts` (changed) | `chat_updated_invalidates_the_list_thread_and_unread_keys` | exact `inboxKeys` shapes, not a superset |
| `app/frontend/src/features/inbox/__tests__/conversation-list.test.tsx` | `an_unread_badge_clears_after_marking_read` | UI reflects the counter, not a re-derived scan |
| `app/frontend/src/features/inbox/__tests__/thread.test.tsx` | `no_unsent_message_ever_renders_as_sent` | pending tail vs sent messages render distinctly |
| `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts` (extended from P31) | `tenant_Bs_chat_list_never_leaks_into_tenant_As_response` | two-tenant read-path proof |
| `scripts/guards/check-copy.test.ts` | `inbox_panel_copy_states_receipts_are_a_lower_bound_honestly` | en + hi, no overclaim |

Mandatory-suite tests this phase makes green: **none new from the blueprint's numbered tables.** Extends
isolation suite B (read path) and the SSE invalidation-map test suite.

**Demonstrable outcome (founder-facing demo narrative; never a test assertion):** a real inbound message
appears in the panel thread within seconds over SSE, with an unread badge that clears on read; a
`metadata_only` impersonation session sees the thread but never a body.

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
- **No migration in this phase.** If a route seems to need a new column or index, stop — that is a P31
  omission to fix via `/decide`, not a P32 addition (this phase never carries a migration in parallel with
  anything, and adding one here breaks the write-path/read-path split line).
- **`coalesce_key` is not optional.** Migration 0041's CHECK aborts the whole capture transaction (P31's
  code) if an SSE-fanned event has a null `coalesce_key` — this phase's contract-level test
  (`chat_updated_and_message_received_always_carry_a_non_null_coalesce_key`) exists precisely to catch a
  regression here before it reaches P31's already-shipped transaction.
- **Naming a realtime event type is a public commitment unless excluded.** Both new types go into
  `WEBHOOK_EXCLUDED_EVENT_TYPES` in the SAME change that adds them to `REALTIME_EVENT_TYPES` — never as a
  follow-up.
- **`capture.ts`'s statement order beyond the new emit is frozen — P31 owns it.** P31 already ships the
  `chat.updated` emit and declared the rest of its transaction's statement order the contract its own U4
  tests assert against. This phase adds ONLY the `message.received` emit, at the same position, same
  `coalesce_key`; it must not restructure anything else in that transaction.
- **`packages/contracts/src/app/inbox.ts` is created here, not in P31.** The design doc §8 originally placed
  the write half of this file in P31; the phase files instead split it read half (here) / write half (P33) —
  P31 ships no route and never touches this file.
- **Unread must stay a counter.** Any temptation to "just count unread messages" during the panel proof is
  the exact query that does not survive 1,000 clients over a partitioned `messages` parent.
- **The `metadata_only` impersonation gap is a real, un-covered surface today** (ADR 0046 §10 calls it out
  explicitly) — do not treat the test as boilerplate; it is closing a genuine gap.
- **300-line cap**: `routes.ts` is a likely candidate; split routes-support first, never trim contract
  comments.
- **Test file placement**: any new `app/backend` unit test reaching `@wp/server-kit` imports the stub-env
  file first; real-infra tests are `*.integration.test.ts`.
- **No ambient-state assertions** in the SSE timing test — assert on the invalidation map's exact key
  shapes and injected events, never on wall-clock delivery latency.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P33 — inbox-reply-path-and-outbound-row. Read plan/v2/P33-inbox-reply-path-and-outbound-row.md
and follow it exactly: one phase, one session. Dep P32 is done (see plan/v2/README.md).
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
