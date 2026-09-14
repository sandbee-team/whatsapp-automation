# P22 — inbox-conversations-and-reply

**Goal (one line):** the workspace can open a WhatsApp number's conversations in the panel — a keyset-paginated chat list, a keyset-paginated thread that also contains **our own** sends, a bounded 90-day search, a contact sidebar — and can reply, where "reply" means one durable `message_jobs` row with `priority='high'` and `send_origin='inbox_manual'` that obeys pacing, the sending window, opt-out and the wallet gate exactly like every other send.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P21, P05 (must be `done`) — transitively P11/P12 (send path + echo), P13/P14 (pacing, window, opt-out), P19 (wallet gate), P20 (contacts)
**Blocks:** P23 (the broadcast composer reuses this composer's pre-flight and copy), P24 (group threads render through this UI)

**Size warning:** this phase sits on the 10-step ceiling. If step 6 is not green by mid-session, stop after
step 6 and split: steps 7-10 (pending tail, reply endpoint, panel, e2e) become `plan/v1/P22a-inbox-panel-and-reply.md`,
added as a row in `plan/README.md`. **P23 then depends on P22a, not P22** — the demonstrable outcome
(a reply becomes a durable job) lives in the second half.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; migrations applied; `scripts/ci.ps1` green on the tree as you found it (SESSION-PROTOCOL O2).
- P21 shipped: `chats`, partitioned `messages`, the extended `message_wa_ids` (PK `(client_id, instance_id, direction, wa_msg_id)`), `inbound_dead_letters`, the inbound transaction, unread counters, the per-instance inbound admission bucket, the `chat.updated` outbox event and the monthly partition-maintenance job for `messages`.
- P20 shipped client-scoped `contacts`, tags, the JID/LID normalisation module and the opt-out mirror.
- P11-P14 shipped: `POST /v1/messages` with mandatory `Idempotency-Key`, `message_job_refs` idempotency, `pacing.reserve()`, `pacing.nextEligibleAt()`, the sending window, the opt-out gate (422 at API creation) and `check-send-origin`.
- P19 shipped the two wallet predicates **inside the claim** and the low/empty/frozen copy.
- **Open question 3 is answered: NO.** An inbox reply is **not** exempt from the sending window in v1. Build no exemption path; the composer tells the user *before* they commit when the message will go out. (`.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md`, open questions.)
- ADRs 0014, 0015, 0017, 0019, 0020 accepted.

## What you are building (3-6 bullets)
- **Read model, keyset only:** conversation list (`last_message_at, id` DESC), thread (`created_at, id` DESC, paging backwards into history), unread + mark-read, contact sidebar. No `OFFSET` anywhere; every query carries `client_id`.
- **Bounded search:** `websearch_to_tsquery` over the **four most recent `messages` partitions only**, hard-bound to `created_at >= now() - interval '90 days'`, with the index lifecycle attached to P21's partition-maintenance job, plus a chat/contact name+number search. The UI states the 90-day limit.
- **Our own sends in the thread:** the send-result transaction gains the outbound `messages` row + `chats` update (append-only at the end of the existing transaction, in the inbound handler's lock order), and the `fromMe` echo takes an **update** path instead of inserting a duplicate.
- **A durable pending tail:** queued/processing jobs for the chat are rendered from `message_jobs` with a clock, so a queued reply survives a page reload and **nothing renders as sent before `status='sent'`**.
- **Reply as an ordinary job:** `POST /v1/chats/:chatId/reply` → the existing enqueue service with `priority='high'`, `send_origin='inbox_manual'`, `is_new_conversation=false`, mandatory `Idempotency-Key`. `roles/api.ts` still cannot import `provider/**`.
- **The inbox panel:** list + thread + composer + contact sidebar + search, all copy through `@wp/i18n` (en/hi) and `check-copy`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | **Inbox** — reply-composer rules (HIGH is ordering, not exemption; optimistic clock; window copy), *"Our own outbound messages appear in the thread"* (the send-result write + echo update path), and **Conversations and messages** — the `chats`/`messages` DDL and the **search window** decision (per-partition FTS, newest 4 partitions, 90 days) |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | **`SendOrigin`, and why there is no bypass**; **Durable queue** (`message_jobs` columns + index list); **Panel UX and copy** |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | §3 Inbox (`roles/api.ts ↛ provider/**`; one uniqueness authority; workspace-level unread) |
| ADR | `.memory/decisions/0014-repo-structure-and-projects.md` | project boundaries — **`roles/api.ts` may not import `provider/**`**, no deep module imports, no cross-project import |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | a reply is charged like any send: nothing at enqueue, one debit at `sent`, empty wallet stops the **claim** and preserves the job |
| ADR | `.memory/decisions/0015-safe-mode-pacing-warmup-and-health.md` | window/gap/caps apply to `inbox_manual`; `SAFE_MODE_DISCLAIMER` co-presence |
| Phase | `plan/v1/P21-inbox-inbound.md` | the inbound transaction's statement order and the `chat.updated` outbox payload — match them, do not re-invent |
| Phase | `plan/v1/P11-send-path-mvp.md` | `enqueue` service/repo signatures and `engine/queue/result.ts` — this phase extends both |
| Invariants | `.claude/rules/core-invariants.md` | all (1, 4, 5 bite hardest here) |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | honest claims — every string this phase writes |
| Path rules | `.claude/rules/database.md`, `.claude/rules/api.md`, `.claude/rules/queue-*.md` | all |
| Protocol | `plan/SESSION-PROTOCOL.md` | O1-O3, E1-E3, C1-C7 |

## Ordered minimum steps
Migration numbers continue from whatever P21 ended at; write the real names into the files list.

- [ ] 1. **Write the failing tests first** (all red, none skipped, none `.only`) → `packages/contracts/src/inbox.test.ts`, `app/backend/test/integration/inbox/conversations.test.ts`, `app/backend/test/integration/inbox/thread.test.ts`, `app/backend/test/integration/inbox/search.test.ts`, `app/backend/test/integration/inbox/reply.test.ts`, `app/backend/src/engine/queue/result-inbox.integration.test.ts`, `app/frontend/src/features/inbox/__tests__/{thread.test.tsx,conversation-list.test.tsx,reply-composer.test.tsx}`.
- [ ] 2. **Contracts + copy, before any handler** → `packages/contracts/src/inbox.ts` (`ChatListQuery` with an opaque keyset `cursor` and **no `offset`**; `ThreadQuery`; `SearchQuery` with `q` ≤ 128 chars; `ReplyRequest` = `{body ≤ 4096, quotedWaMsgId?}` — `.strict()`, **no `origin`, no `priority`, no `skipPacing`, no `sendAt` field**; `ReplyResponse = {publicId, status:'queued', willSendAfter: string|null, reason: 'window'|'pacing'|'wallet_empty'|null}`), register in `packages/contracts/src/index.ts`; `packages/domain/src/copy/inbox-copy.ts` (search-window notice, `WILL_SEND_AT_WINDOW_OPEN`, queued/clock label, wallet-paused reply notice reusing P19's key, the workspace-level-unread note) added to `scripts/check-copy.ts` (must report a non-zero matched-file count).
- [ ] 3. **Migration — indexes only, no new table** (dispatch `db-engineer`) → `db/migrations/00NN_inbox_read_model.sql`: `chats_list_idx (client_id, instance_id, last_message_at DESC, id DESC)`, partial `chats_unread_idx (client_id, instance_id) WHERE unread_count > 0`, `message_jobs_pending_thread_idx (client_id, instance_id, recipient_jid, created_at DESC, id DESC) WHERE status IN ('queued','processing','blocked_needs_review')`, and a `messages_fts_partition(partition_name)` DDL helper that creates `CREATE INDEX CONCURRENTLY … USING gin (to_tsvector('simple', body))` **per partition**; extend P21's partition-maintenance job to create the index on the newest partition and drop it from any partition older than the 4th → `app/backend/src/platform/db/partitions.ts` (changed). No FTS index on the partitioned parent, ever.
- [ ] 4. **Conversation list + unread + sidebar** → `db/queries/inbox-conversations.sql`, `app/backend/src/modules/inbox/inbox.repo.ts`, `inbox.service.ts`, `inbox.routes.ts` (`GET /v1/instances/:id/chats` keyset, filters `unread|archived|kind`; `GET /v1/chats/:chatId`; `POST /v1/chats/:chatId/read` → `unread_count=0` + one `chat.updated` outbox row; `GET /v1/chats/:chatId/contact` = contact + tags + opt-out state + `first_inbound_at`/`last_inbound_at` from `instance_recipient_contacts`), registered in `app/backend/src/roles/api.ts`. Explicit auth policy + scope on every route; tenant scope from the session only, never from a query param.
- [ ] 5. **Thread read model** → `db/queries/inbox-thread.sql` + repo/service methods: `GET /v1/chats/:chatId/messages`, keyset `(created_at, id) < cursor` DESC over `messages_thread_idx`, `LIMIT ≤ 50`, returning `{id, direction, body, msgType, mediaAssetId, status, sentAt, deliveredAt, readAt, messageJobPublicId, quotedWaMsgId}`. Media served only through P21's authenticated signed-URL path — never a raw storage key.
- [ ] 6. **Outbound row in the send result + echo update path** → `app/backend/src/engine/queue/result.ts` (changed): inside the **existing** send-result transaction, after the wallet/campaign writes, `INSERT INTO message_wa_ids … direction='out'` (already there) → resolve-or-create `chats` (`INSERT … ON CONFLICT (client_id, instance_id, jid) DO UPDATE`) → `INSERT INTO messages (direction='out', is_from_me=true, message_job_public_id, status='sent', sent_at)` → `UPDATE chats SET last_message_at/last_message_preview/last_message_direction/last_outbound_at` (**never** `unread_count`) → `chat.updated` outbox row. Then `app/backend/src/modules/inbox/echo.ts` (changed, P12/P21's handler): a `fromMe` echo whose `wa_msg_id` already exists takes an **UPDATE** path (delivery/read timestamps on the existing row); a genuinely unknown id still inserts with `inbox_message_id NULL` for the reconciler. Statement order is documented at the top of `result.ts` and mirrors the inbound transaction (`message_wa_ids → messages → chats`) — see gotchas.
- [ ] 7. **Durable pending tail** → `db/queries/inbox-pending-tail.sql` + service: on the **newest page only** (`cursor === null`), append jobs from `message_jobs WHERE client_id AND instance_id AND recipient_jid = chat.jid AND status IN ('queued','processing','blocked_needs_review') ORDER BY created_at DESC LIMIT 50`, mapped to `{publicId, direction:'out', body, status:'queued'|'sending'|'needs_review', createdAt}`. A pending item **never** carries `sentAt`, `deliveredAt` or a tick.
- [ ] 8. **Reply endpoint** → `app/backend/src/modules/inbox/reply.service.ts` + route `POST /v1/chats/:chatId/reply`: mandatory `Idempotency-Key` (400 without), resolve chat → instance + recipient JID, then call **P11's existing** `messages.service.enqueue()` with `priority='high'`, `send_origin='inbox_manual'`, `is_new_conversation=false`. No new insert path, no transport import. Compute `willSendAfter` for the response from `pacing.nextEligibleAt(instanceId)` + the sending window + the wallet state — **read-only, and never re-implemented arithmetic**. Opt-out returns 422 with no job and no charge; a `logged_out`/`unlinked` instance returns P11's `409 INSTANCE_UNLINKED`.
- [ ] 9. **Bounded search + panel** → `db/queries/inbox-search.sql` + `app/backend/src/modules/inbox/search.repo.ts` + `GET /v1/instances/:id/inbox/search` (message search: `websearch_to_tsquery('simple', $q)` with `created_at >= now() - interval '90 days'`, `LIMIT 50`, always also `client_id = $ctx`; chat search: name/E.164 prefix over `chats`+`contacts`), then `app/frontend/src/features/inbox/{api.ts,keys.ts,components/conversation-list.tsx,components/thread.tsx,components/message-bubble.tsx,components/reply-composer.tsx,components/contact-sidebar.tsx,components/search-bar.tsx}` and `app/frontend/src/routes/_authed/inbox.tsx` + `inbox.$chatId.tsx`; add `chat.updated` / `message.created` to the SSE invalidation map in `app/frontend/src/lib/sse.ts` (ids only, hint-then-refetch). Composer mints one uuidv7 `Idempotency-Key` per submission and reuses it on every retry; it shows `willSendAfter` **before** the user commits.
- [ ] 10. **Acceptance + full run** → `app/backend/test/integration/inbox/reply-e2e.test.ts` (panel reply → durable job → fake transport ack → the same message visible in the thread as `sent`, with pacing, window and opt-out all applied), then run `scripts/ci.ps1` and paste the verbatim tail into the session log.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/contracts/src/inbox.test.ts` | `the_reply_schema_is_strict_and_has_no_origin_or_pacing_field` | `origin`, `priority`, `skipPacing`, `sendAt` all rejected by `.strict()` |
| `app/backend/test/integration/inbox/conversations.test.ts` | `the_conversation_list_is_keyset_paginated_and_contains_no_offset` | page 2 via cursor; SQL text has no `OFFSET`; stable under a concurrent insert |
| `app/backend/test/integration/inbox/conversations.test.ts` | `a_second_tenant_never_appears_in_the_conversation_list_or_search` | two-tenant seed; zero cross-tenant rows under RLS FORCE |
| `app/backend/test/integration/inbox/conversations.test.ts` | `marking_a_chat_read_zeroes_unread_and_writes_one_chat_updated_row` | `unread_count=0`, exactly one outbox row, idempotent on repeat |
| `app/backend/test/integration/inbox/thread.test.ts` | `an_outbound_queued_send_appears_in_the_conversation_thread` | **scope-delta named test** — a sent job has a `messages` row with `direction='out'` in the thread |
| `app/backend/test/integration/inbox/thread.test.ts` | `a_queued_reply_is_visible_after_a_reload_and_never_renders_as_sent` | pending tail from `message_jobs`; `status='queued'`, `sentAt` null, no tick |
| `app/backend/test/integration/inbox/thread.test.ts` | `the_thread_pages_backwards_by_keyset_across_a_partition_boundary` | messages seeded either side of a month boundary; no duplicate, no gap |
| `app/backend/src/engine/queue/result-inbox.integration.test.ts` | `the_send_result_transaction_writes_the_outbound_row_and_never_bumps_unread` | one `messages` row, `chats.unread_count` unchanged, `last_outbound_at` set |
| `app/backend/src/engine/queue/result-inbox.integration.test.ts` | `an_echo_for_an_existing_outbound_id_updates_it_instead_of_inserting_a_duplicate` | exactly one row; `delivered_at` populated |
| `app/backend/src/engine/queue/result-inbox.integration.test.ts` | `an_echo_for_an_unresolved_attempt_is_recorded_not_dropped` | **scope-delta named test** — insert with `inbox_message_id NULL`, reconciler still matches |
| `app/backend/src/engine/queue/result-inbox.integration.test.ts` | `a_rolled_back_send_result_leaves_no_message_row_and_no_chat_update` | the inbox write is transactional with the result, not after it |
| `app/backend/test/integration/inbox/reply.test.ts` | `a_panel_reply_creates_one_high_priority_job_with_send_origin_inbox_manual` | one `message_jobs` row: `priority='high'`, `send_origin='inbox_manual'`, `is_new_conversation=false` |
| `app/backend/test/integration/inbox/reply.test.ts` | `a_reply_without_an_idempotency_key_is_rejected_and_creates_no_job` | 400; zero rows |
| `app/backend/test/integration/inbox/reply.test.ts` | `a_replayed_idempotency_key_returns_the_same_public_id_and_creates_no_second_job` | `message_job_refs` conflict path; row count 1 |
| `app/backend/test/integration/inbox/reply.test.ts` | `high_priority_does_not_skip_the_pacing_gap` | two replies back to back: the second is deferred by the gap, not sent early |
| `app/backend/test/integration/inbox/reply.test.ts` | `a_reply_outside_the_sending_window_is_queued_and_the_response_says_when_it_will_send` | job queued (not failed), `willSendAfter` = window open, `reason='window'`; **no exemption exists** |
| `app/backend/test/integration/inbox/reply.test.ts` | `a_reply_to_an_opted_out_contact_is_rejected_422_with_no_job_and_no_charge` | zero `message_jobs`, zero wallet ledger rows |
| `app/backend/test/integration/inbox/reply.test.ts` | `a_reply_on_an_empty_wallet_is_queued_and_preserved_not_failed` | job stays `queued`, `reason='wallet_empty'`, nothing deleted (invariant 5) |
| `app/backend/test/integration/inbox/search.test.ts` | `search_is_bounded_to_ninety_days_and_the_response_states_the_limit` | a 100-day-old message is absent; `windowDays: 90` in the payload |
| `app/backend/test/integration/inbox/search.test.ts` | `search_only_touches_the_four_indexed_partitions` | `EXPLAIN` shows the older partitions pruned; no seq scan on the parent |
| `app/backend/test/integration/inbox/search.test.ts` | `hostile_search_input_never_throws_and_never_injects` | `websearch_to_tsquery` handles `"a" OR 1=1 --`, `''`, 128-char and unicode input |
| `app/backend/test/integration/inbox/reply-e2e.test.ts` | `a_panel_reply_is_delivered_and_appears_in_the_thread_as_sent` | **the phase demo**, fake transport; one job, one debit, one thread row |
| `app/backend/test/isolation/suite-b-inbox-read.test.ts` | `two_tenants_reading_and_searching_at_once_never_cross_read` | suite B gains the inbox read path |
| `scripts/guards/depcruise.test.ts` | `api_role_importing_provider_is_rejected` | still red on a planted `provider/**` import from the new inbox module (ADR 0014) |
| `app/frontend/src/features/inbox/__tests__/thread.test.tsx` | `a_queued_message_shows_a_clock_and_no_tick` | renders en + hi; no tick until `status='sent'` |
| `app/frontend/src/features/inbox/__tests__/reply-composer.test.tsx` | `the_composer_states_the_send_time_before_the_user_commits` | `willSendAfter` copy rendered pre-submit; no "instant"/"guaranteed" string |
| `app/frontend/src/features/inbox/__tests__/conversation-list.test.tsx` | `a_chat_updated_event_invalidates_only_the_inbox_keys` | hint-then-refetch; no instance/wallet query touched |
| `scripts/__tests__/check-copy.test.ts` | `inbox_copy_contains_no_banned_claims_in_en_or_hi` | new copy file scanned, non-zero matched-file count |

Mandatory-suite tests this phase makes green: **none of the numbered send-path tests 1-23** — this phase adds no send path. Tests **21** (`exactly_one_table_carries_a_reserve_counter`), **22** (`no_config_patch_raises_a_limit`) and **23** (enum parity) must stay green, and the `check-send-origin` guard must keep `inbox_manual` in the **non-exempt** set. It extends **isolation suite B** (inbox read path) and the **copy** suite.

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
- **The composer must not grow a socket.** The only output of a reply is a `message_jobs` row. If a step tempts you to "just send it now because a human is waiting", that is invariant 1 and ADR 0014's `roles/api.ts ↛ provider/**`; the depcruise test exists to stop it. HIGH priority wins the DWRR band — it does not skip the gap, the window, opt-out, the content guards or the wallet gate.
- **Deadlock between the inbound transaction and the send result.** Both now write `chats`. Use one relative order in both — `message_wa_ids → messages → chats` — appended at the **end** of the send-result transaction after `message_jobs → send_attempts → wallet_accounts → campaign_counters`, and write that order as a comment in `result.ts` and in the queue path rule. A busy 1:1 chat receiving inbound while we send to it is the exact case that deadlocks if the orders disagree.
- **Never `unread_count++` on an outbound row.** Our own send in the thread must not mark the customer's chat unread; the test asserts it. Equally, `last_message_preview` on an outbound row must be the rendered body, never the raw payload jsonb.
- **Optimistic UI is not durable state.** A local "sending…" bubble disappears on reload; the pending tail from `message_jobs` is the durable answer. Do not render an optimistic bubble *and* the pending row (duplicate) — key the optimistic entry on the `Idempotency-Key` and drop it once the server echoes the `publicId`.
- **Never render an unsent message as sent.** Status comes from the row: pending tail ⇒ clock, `messages.status='sent'` ⇒ one tick, `delivered_at` ⇒ two, `read_at` ⇒ read. No client-side optimism upgrades a tick.
- **The pending tail only belongs on the newest page.** Appending it to every page duplicates it during scrollback; gate on `cursor === null` and bound it at 50.
- **FTS on the partitioned parent will look like it works and then eat the disk.** A `STORED` `body_tsv` + parent GIN index is built and maintained over 24 partitions for a 90-day UI, and child indexes cannot be dropped while the parent index exists. Per-partition, newest 4, created/dropped by the partition job. Build them `CONCURRENTLY` and outside a transaction, or the migration will lock a live table.
- **`to_tsquery` throws on user input; `websearch_to_tsquery` does not.** Use `websearch_to_tsquery('simple', $1)` — `'simple'`, because the corpus is Hindi/Hinglish/English mixed and an English stemmer silently mangles it. Never build the query string by concatenation.
- **Search is a tenant read path, not a cross-tenant one.** It must carry `client_id` and must not be added to `CROSS_TENANT_QUERIES`. It also must not read `message_jobs.payload` — search the rendered `messages.body` only.
- **Every send now writes a `messages` row**, including campaign sends in P23. That is deliberate (the thread must be truthful) and it is the main storage line item; `M9` measures bytes/day. Message retention is still an **open founder question** (24 months default) — do not silently decide it here; the retention job is P25's.
- **Workspace-level unread is a known hole, not a bug.** Per-user unread/read state is deferred to v2 (ADR 0017). One person marking a chat read clears it for everyone; the copy must say "read by your workspace", not "read by you". Do not invent a per-user table in this phase.
- **Copy traps.** No "instant reply", "guaranteed delivery", "ban-proof", "100% safe", or the Hindi equivalents. The window message states a fact ("Will send at 09:00 — your sending window"), never an apology-plus-workaround, and no string may hint that the window can be turned off. Any string containing "Safe Mode" needs `SAFE_MODE_DISCLAIMER` co-present.
- **Use the test roots that already exist.** P11 wrote `app/backend/test/integration/...`; if the tree says `tests/`, follow the tree and note the deviation in the session log rather than creating a second root.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P23 — broadcast-campaigns. Read plan/v1/P23-broadcast-campaigns.md and follow it exactly:
one phase, one session. Deps P19, P20 and P22 are done (see plan/README.md). Do not start P24.
P23 is sized L: if it does not fit one sitting, split at its stated split line
(snapshot+expansion+cancel / composer+pre-flight+progress UI) into P23a and add the row to plan/README.md.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
