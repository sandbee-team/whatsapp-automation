# P21 — inbox-inbound

**Goal (one line):** a message someone sends to a connected number is durably stored — one `messages` row in a tenant-scoped `chats` thread, keyed on the extended `message_wa_ids` authority — with a bounded media pipeline, a per-instance inbound admission bucket, and an `inbound_dead_letters` row instead of a silent drop when the handler throws.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P20, P12 (must be `done`)
**Blocks:** P22, P23, P24

## Prerequisites (facts, not phases)
- Postgres **17** + Redis (`redis-ctl` / `redis-sig` / `redis-cache`) up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean on a fresh volume.
- **P03 landed:** `message_wa_ids` already exists in its **final both-directions shape** — PK `(client_id, instance_id, direction, wa_msg_id)`, `message_id` nullable, `inbox_message_id` / `inbox_message_created_at` present. This phase **never** creates a second inbound id authority.
- **P12 landed:** `app/backend/src/modules/queue/echo-capture.ts` is wired into the session worker's `messages.upsert` handler and writes `message_wa_ids` rows with `direction='out'`, `content_hash`, `observed_at`; `db/migrations/…_reconcile_support.sql` carries the header comment *"P21 owns the inbound body path and must ALTER, never CREATE"*. SPIKE-2's verdict is filed in `docs/evidence/P12-spike-2-echo.md` — read it before step 8.
- **P20 landed:** client-scoped `contacts` with `phone_hash`, `addressing_mode`, `lid_jid`, and the `@wp/domain` JID/LID normalisation module. **P14 landed:** `app/backend/src/modules/inbound/optout-detect.ts` (the inbound hook this handler calls) and the `opt_outs` registry. **P13 landed:** `instance_recipient_contacts`, the single source of `is_new_conversation` / `first_inbound_at`.
- **P15 landed:** `emit(tx, event)` writes an `outbox_events` row inside the caller's transaction; `ROLE=relay` fans it out to SSE. There is no second publisher.
- ADRs **0017, 0018, 0019, 0020 accepted**. `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL **O2**).
- **O3:** the inbound transaction, the id authority, dead letters and admission control are decided in ADR 0017 §3 and the scope delta's *Inbox* section — do **not** run `/feature` for them. Exactly one thing is undecided: **message/media retention** (founder open question 10, default 24 months). See *Risks*; it ends as a one-paragraph `/decide` at C6, not as an unrecorded default.

## What you are building (3-6 bullets)
- `chats` (`UNIQUE (client_id, instance_id, jid)`), monthly-partitioned `messages` (**rendered body only, never `rawMessage`**), `inbound_dead_letters` and `media_assets`, plus per-partition FTS on the 4 most recent partitions only — never on the partitioned parent.
- The **one inbound transaction**, gated by an `INSERT … ON CONFLICT DO NOTHING` on `message_wa_ids (direction='in')`: message row, `chats` unread/preview update, `contacts.last_inbound_at`, `instance_recipient_contacts.first_inbound_at`, the opt-out keyword hook, and one `chat.updated` outbox event.
- Outbound parity: the P11 send-result transaction also writes its `messages` row (`direction='out'`), so our own sends appear in the thread and the P12 echo takes an **update** path instead of a dead end.
- A per-instance inbound **admission bucket** on `redis-ctl`: above the ceiling, inbound persistence sheds to a counted path (`wp_inbox_shed_total`) with honest panel copy — and isolation suite B proves a noisy tenant cannot starve a quiet one.
- `inbound_dead_letters` (ids and hashes only, own transaction) with a per-instance chip and a human-triggered replay path; a throwing handler skips one message and **never** drops the socket.
- The bounded media pipeline: `storage.put()` (the only place an object key is built), MIME allow-list, per-type byte caps, streamed, ≤4 concurrent downloads per worker, 3 retries then metadata-only, tenant-scoped serving via 5-minute signed URLs.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | **`Inbox` — the whole section** (inbound transaction, outbound-in-thread fix, dead letters, admission control, media, what is deferred) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *Schema delta → Conversations and messages* (`chats`, `messages`, the `message_wa_ids` ALTER with `direction` in the PK, `inbound_dead_letters`, FTS **not** on the partitioned parent); *Observability (one rule, not two)*; *Redis, Signal state and inbound decryptability* |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Corrections found after synthesis* **item 1** (this phase closes it); *Data model → Inbox, compliance, admin* (`media_assets` key shape [R-29s]); *Security, tenant isolation & encryption*; *Testing strategy → Isolation, security and copy suites* |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | **§3 (Inbox)** — and the ordering constraint at the end |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | metric label allow-list; `redis-sig` `noeviction` and why inbound decryptability depends on it |
| ADR | `.memory/decisions/0020-phase-session-protocol-and-plan-folder.md` | — |
| Phase | `plan/v1/P12-queue-recovery-and-echo-spike.md` | steps 2 and 5 (`message_wa_ids` evidence columns, echo capture) — this phase **ALTERs**, never re-creates |
| Phase | `plan/v1/P14-pacing-guards-and-optout.md` | step 5 (`modules/inbound/optout-detect.ts` contract, `@lid` unattributable rule) |
| Invariants | `.claude/rules/core-invariants.md` | all (**3** and **4** bite hardest) |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | honest claims; PII discipline |
| Path rules | `.claude/rules/db-*.md`, `.claude/rules/queue-*.md`, `.claude/rules/api-*.md` | all |

## Ordered minimum steps
Migration numbers: use the next free 4-digit number after P20's and write the real names into the files list.

- [ ] 1. **Write the failing tests first** (all red, none skipped, none `.only`) → `db/test/inbox-schema.test.ts`, `app/backend/src/modules/inbound/handler.test.ts`, `app/backend/test/integration/inbound/inbound.int.test.ts`, `app/backend/test/integration/inbound/dead-letter.int.test.ts`, `app/backend/test/integration/inbound/admission.int.test.ts`, `app/backend/test/integration/inbound/media.int.test.ts`, `packages/domain/src/inbound/render-body.test.ts`, and the new cases appended to `db/test/isolation-suite-b.test.ts`.
- [ ] 2. **(db-engineer) Migration — the inbox schema** → `db/migrations/00NN_inbox_chats_messages.sql`, `db/schema/{chats,messages,inbound-dead-letters,media-assets}.ts`, `db/src/partitions.ts` (changed), `db/queries/ensure-partitions.sql` (changed), `db/test/isolation-suite-a.test.ts` + `db/test/role-grants.snapshot.json` (changed). `chats`, `messages` (monthly partitions, PK `(id, created_at)`, `messages_thread_idx`), `inbound_dead_letters`, `media_assets` exactly as the delta's *Conversations and messages* block; enums `chat_kind` / `msg_direction` added to P02's enum migration **only if absent**, and mirrored into `@wp/domain` with the existing equality test. Also `ALTER TABLE whatsapp_instances ADD COLUMN capture_media bool NOT NULL DEFAULT false, ADD COLUMN capture_groups bool NOT NULL DEFAULT false, ADD COLUMN inbound_max_per_minute int NOT NULL DEFAULT 120` with the header comment **"P24 owns `capture_groups` behaviour and must ALTER, never CREATE"**. FTS: `body_tsv` + GIN created **per partition**, on the 4 most recent only, created and dropped by the same helper that manages partitions — **no index on the parent**. Every table leads with `client_id NOT NULL`, RLS `ENABLE`+`FORCE`, `wp_app` R/W, no new entry on the three-item exemption list.
- [ ] 3. **Rendered body + type mapping + the ignore filter, browser-pure** → `packages/domain/src/inbound/{render-body.ts,msg-type.ts,ignore-jid.ts}` + tests. `renderBody(msg)` returns `{ msgType, body, quotedWaMsgId, mediaHint }` from the Baileys message union — text, extended text, caption, reaction, location label, contact card name, system/unsupported → an explicit `msg_type` and a short honest placeholder. **It never returns, stores or logs `rawMessage`.** `shouldIgnoreJid(jid, { captureGroups, sendEnabledGroupJids })` drops `status@broadcast` and newsletter JIDs, and drops group *messages* when `capture_groups=false` — but **never** drops a group whose receipts we need (P24's rule; keep the parameter and the test now).
- [ ] 4. **Chat and contact resolution** → `app/backend/src/modules/inbound/resolve-chat.ts` + `.test.ts`. Normalise with P20's `jidNormalizedUser` wrapper; upsert `chats` on `(client_id, instance_id, jid)`; resolve or create the `contacts` row with `source='inbound'`; when the event carries a lid↔pn mapping, **persist it** (`lid_jid`, `addressing_mode`, hashed `phone_hash`) rather than re-deriving digits; a `@lid`-only sender with no mapping resolves to a chat with `contact_id NULL` and is recorded unattributable — **never** mis-attributed to a guessed contact.
- [ ] 5. **The one inbound transaction** → `db/queries/insert-inbound-message.sql` + `app/backend/src/modules/inbound/{inbound.repo.ts,handler.ts}`. Order exactly as the delta's *Inbox* block: `INSERT message_wa_ids (…, direction='in') ON CONFLICT DO NOTHING RETURNING` gates everything (0 rows ⇒ genuine duplicate, stop; an existing row with the same `wa_msg_id` but `direction='out'` ⇒ `wp_inbound_id_collision_total++`, counted, never merged) → `INSERT messages` (rendered body only) → back-fill `message_wa_ids.inbox_message_id`/`inbox_message_created_at` → `UPDATE chats SET unread_count = unread_count + 1, last_message_at, last_message_preview, last_inbound_at, last_message_direction` → `UPDATE contacts SET last_inbound_at` → `UPDATE instance_recipient_contacts SET first_inbound_at = COALESCE(first_inbound_at, now())` → call P14's `optout-detect` hook → `emit(tx, 'chat.updated')`. One transaction, one statement per line above, **ids-only in the outbox payload**.
- [ ] 6. **Per-instance admission bucket + the two-tenant proof** → `app/backend/src/modules/inbound/admission.ts` + `.test.ts`, `app/backend/src/platform/redis/lua/inbound-bucket.lua`, `db/test/isolation-suite-b.test.ts` (changed), `app/backend/src/platform/config.ts` (changed: `INBOUND_MAX_PER_MINUTE` default, burst). Token bucket on **`redis-ctl`**, keyed `wp:{env}:inbound:c:{client}:i:{instance}` via `tenantKey()`, refilled from `whatsapp_instances.inbound_max_per_minute`. Above the ceiling the message is **shed before persistence**, counted on `wp_inbox_shed_total{worker}` and reflected on the instance chip — it is never queued in memory and never retried into a growing backlog. Redis unavailable ⇒ **fail open on admission** (persist) and count it; shedding is a fairness control, not a safety control.
- [ ] 7. **Dead letters + replay** → `app/backend/src/modules/inbound/{dead-letter.ts,replay.routes.ts}` + tests, `packages/contracts/src/app/inbox.ts`. On any throw inside the per-message handler: write one `inbound_dead_letters` row **in its own transaction** (`client_id`, `instance_id`, `wa_msg_id`, `chat_jid_hash`, `error_class`, `raw_size` — **no body, no JID, no phone number**), count `wp_inbound_dead_letters_total{error_class}`, and continue with the next message. `POST /v1/instances/:id/inbound/dead-letters/:dlId/replay` requires `ctx.actor.userId` + `Idempotency-Key`, is bounded per call, writes `replayed_at` and an audit row; there is **no automatic replay loop**.
- [ ] 8. **Wire into the socket and close the outbound-in-thread gap** → `app/backend/src/roles/session-worker.ts` (changed), `app/backend/src/modules/queue/echo-capture.ts` (changed), `app/backend/src/engine/queue/result.ts` + the P11 result statement in `db/queries/` (changed — use the exact filenames from P11's file list). In `messages.upsert`: filter → admission → `key.fromMe === false` goes to the inbound handler, `key.fromMe === true` goes to echo capture **which now also upserts the outbound `messages` row** (update path on conflict: delivery timestamps only; an unknown id inserts with `message_id NULL` so P12's reconciler still matches it). The send-result transaction writes its own `direction='out'` `messages` row + `chats` update (no unread increment). **One try/catch per message** — a throw is one dead letter, never a socket teardown, never a rejected promise reaching the process.
- [ ] 9. **Bounded media pipeline** → `app/backend/src/platform/storage.ts` (+ `storage.s3.ts`, MinIO in `infra/compose/docker-compose.dev.yml`), `app/backend/src/modules/inbound/{media.ts,media.routes.ts}` + tests, `packages/domain/src/inbound/media-policy.ts`. `storage.put()` is the **only** place an object key is built (`clients/{clientId}/{instanceId}/{yyyy}/{mm}/{uuid}`, [R-29s]). Downloads only when `capture_media=true`; MIME allow-list and per-type byte caps enforced **before** the download; streamed to the object store (never `Buffer.concat` of the whole file); global semaphore of **4** concurrent downloads per worker; 3 retries then a metadata-only `media_assets` row with `status='unavailable'`. Serving: `GET /v1/media/:id` → authenticated, tenant-scoped, 302 to a **5-minute** signed URL; the object store is never public.
- [ ] 10. **Metrics, copy and the demo evidence** → `app/backend/src/platform/metrics.ts` (changed: `wp_inbox_inbound_total{msg_type}`, `wp_inbox_shed_total`, `wp_inbound_id_collision_total`, `wp_inbound_dead_letters_total{error_class}`, `wp_inbox_media_downloads_total{outcome}` — **no `client_id`/`instance_id` label on any of them**), `packages/i18n/src/catalogues/{en,hi}.ts` (shed chip, dead-letter chip, media-unavailable, parked-number caveat reuse), `scripts/cross-tenant-queries.ts` (changed: register the partition/FTS maintenance and media retention sweeps with role + reason + projected columns), `docs/evidence/P21-inbound-demo.md` — the demo: a real reply from a second phone lands in `messages` and produces one `chat.updated` SSE frame, with the measured wall-clock latency and the verbatim row (ids and hashes only, no body pasted).

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/test/inbox-schema.test.ts` | `messages_has_no_unique_index_without_the_partition_key` | catalog scan over `messages` and its partitions (blueprint test 21 stays green) |
| `db/test/inbox-schema.test.ts` | `the_only_inbound_id_authority_is_message_wa_ids` | no table other than `message_wa_ids` carries a `wa_msg_id`/`external_id` uniqueness constraint; `message_wa_ids` is non-partitioned and its PK includes `direction` |
| `db/test/inbox-schema.test.ts` | `fts_indexes_exist_on_recent_partitions_only_and_never_on_the_parent` | GIN on the 4 newest partitions, 0 on the parent; a rotation run drops the 5th |
| `db/test/inbox-schema.test.ts` | `every_new_inbox_table_is_in_isolation_suite_a_and_the_exemption_list_is_still_three` | `chats`, `messages`, `inbound_dead_letters`, `media_assets` lead with `client_id`, `rowsecurity`+`forcerowsecurity` true |
| `packages/domain/src/inbound/render-body.test.ts` | `render_body_never_returns_raw_message_json` | every fixture type maps to `msg_type` + a rendered string; `rawMessage` appears in no output field |
| `packages/domain/src/inbound/render-body.test.ts` | `an_unsupported_message_type_renders_an_honest_placeholder` | explicit `msg_type`, no crash, no empty body |
| `app/backend/src/modules/inbound/handler.test.ts` | `a_throwing_inbound_handler_writes_a_dead_letter_and_does_not_drop_the_socket` | **delta gating test** — 3 messages, the middle one throws: 2 stored, 1 `inbound_dead_letters` row, socket still open, next message stored |
| `app/backend/src/modules/inbound/handler.test.ts` | `a_dead_letter_row_contains_no_body_jid_or_phone_number` | column-level assertion + log-grep over the seeded body/number |
| `app/backend/src/modules/inbound/resolve-chat.test.ts` | `a_lid_only_sender_is_recorded_unattributable_not_misattributed` | `chats` row created, `contact_id NULL`, no contact invented; with a mapping present the lid is persisted |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `an_inbound_message_appears_in_the_thread_with_one_row_and_one_event` | **the phase demo** — 1 `messages` row, `chats.unread_count = 1`, preview set, exactly 1 `chat.updated` outbox row |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `a_replayed_inbound_message_inserts_exactly_one_message_row` | same `wa_msg_id` twice (and concurrently) → 1 row, 1 unread increment, 1 event |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `an_inbound_id_colliding_with_an_outbound_wa_msg_id_is_counted_not_merged` | both rows exist (different `direction`), `wp_inbound_id_collision_total` +1, no row overwritten |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `an_outbound_queued_send_appears_in_the_conversation_thread` | **delta gating test** — send-result writes `direction='out'` `messages` row, thread ordered, `unread_count` unchanged |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `an_echo_for_an_unresolved_attempt_is_recorded_not_dropped` | P12 case re-run against the new echo path: evidence row with `message_id NULL` survives, reconciler still resolves |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `an_inbound_stop_keyword_writes_one_optout_and_cancels_queued_jobs` | P14 hook fires inside the same transaction; jobs `cancelled` with `cancel_reason='opt_out'`, **0 failed**, 0 deleted |
| `app/backend/test/integration/inbound/inbound.int.test.ts` | `a_rolled_back_inbound_transaction_leaves_no_row_no_unread_and_no_event` | crash between statements ⇒ nothing partially applied |
| `app/backend/test/integration/inbound/admission.int.test.ts` | `inbound_above_the_ceiling_is_shed_and_counted_never_silently_dropped` | `wp_inbox_shed_total` matches the shed count; stored count equals the bucket allowance |
| `app/backend/test/integration/inbound/admission.int.test.ts` | `redis_unavailable_fails_open_and_persists_inbound` | bucket errors ⇒ message stored, error counted, no dead letter |
| `db/test/isolation-suite-b.test.ts` | `a_noisy_tenants_inbound_cannot_starve_a_quiet_tenants_inbound` | **isolation suite B** — tenant A floods 10× its ceiling while tenant B sends 20 messages: all 20 of B stored, B's p95 persistence latency within budget, 0 of B shed |
| `db/test/isolation-suite-b.test.ts` | `the_inbound_handler_never_reads_or_writes_another_tenants_rows` | two-tenant run under RLS FORCE with `wp_app`; cross-tenant row count 0 |
| `app/backend/test/integration/inbound/dead-letter.int.test.ts` | `replay_requires_a_user_actor_and_is_idempotent` | API key → 403, system actor → 403, user + same `Idempotency-Key` twice → one replay, one audit row |
| `app/backend/test/integration/inbound/dead-letter.int.test.ts` | `a_replayed_dead_letter_that_already_landed_creates_no_second_message` | the `message_wa_ids` gate holds on replay |
| `app/backend/test/integration/inbound/media.int.test.ts` | `a_disallowed_mime_type_is_never_downloaded` | 0 provider download calls, metadata-only row, counted |
| `app/backend/test/integration/inbound/media.int.test.ts` | `an_oversized_media_message_is_stored_metadata_only` | cap enforced before download; `status='unavailable'`, thread still shows the message |
| `app/backend/test/integration/inbound/media.int.test.ts` | `media_is_streamed_and_never_fully_buffered` | `storage.put()` receives a stream; peak heap delta over a 16 MB fixture stays under the budgeted bound |
| `app/backend/test/integration/inbound/media.int.test.ts` | `no_more_than_four_media_downloads_run_concurrently_per_worker` | semaphore observed under 50 queued media messages |
| `app/backend/test/integration/inbound/media.int.test.ts` | `a_media_url_is_tenant_scoped_signed_and_expires_in_five_minutes` | foreign tenant → 404; expired signature → 403; the object store is not publicly readable |
| `app/backend/src/modules/inbound/metrics.test.ts` | `no_inbound_metric_carries_a_client_or_instance_label` | label allow-list guard (ADR 0018) reports a non-zero matched-file count |
| `scripts/__tests__/check-copy.test.ts` | `inbox_copy_states_the_shed_and_parked_limits_honestly` | en + hi; shed chip says some messages are not being stored; no banned claim; the parked-number caveat string is reused verbatim |

Mandatory-suite tests this phase makes green: **none new from the blueprint's numbered tables.** It extends **isolation suite A** (four tables), **isolation suite B** (the inbound handler and the admission bucket as two-tenant background paths), the **log-grep PII scan** and `copy_contains_no_banned_claims`; blueprint test **21** and Safe Mode tests **16/18** (opt-out `cancelled`, not `failed`) must stay green — re-run both.

## Definition of done
- [ ] Every step box above is ticked.
- [ ] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [ ] Named tests above exist and pass; no test is skipped or `.only`.
- [ ] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [ ] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding — invariants **3** and **4** answered explicitly for `message_wa_ids` and the admission bucket.
- [ ] `docs/evidence/P21-inbound-demo.md` exists with the measured reply-to-stored latency and the ids-only row.
- [ ] Retention decided and recorded (ADR or a session-log paragraph naming the default taken).
- [ ] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `db/migrations/00NN_inbox_chats_messages.sql` — created
- `db/schema/chats.ts`, `db/schema/messages.ts`, `db/schema/inbound-dead-letters.ts`, `db/schema/media-assets.ts` — created
- `db/schema/message-wa-ids.ts` — changed: inbox back-reference columns documented (ALTER only, never CREATE)
- `db/src/partitions.ts` — changed: `messages` monthly cadence + per-partition FTS rotation
- `db/queries/ensure-partitions.sql` — changed
- `db/queries/insert-inbound-message.sql` — created
- `db/test/inbox-schema.test.ts` — created
- `db/test/isolation-suite-a.test.ts`, `db/test/role-grants.snapshot.json`, `db/test/isolation-suite-b.test.ts` — changed
- `packages/domain/src/inbound/{render-body.ts,msg-type.ts,ignore-jid.ts,media-policy.ts}` + tests — created
- `packages/contracts/src/app/inbox.ts` — created
- `packages/i18n/src/catalogues/en.ts`, `packages/i18n/src/catalogues/hi.ts` — changed: inbox chips and media copy
- `app/backend/src/modules/inbound/{handler.ts,inbound.repo.ts,resolve-chat.ts,admission.ts,dead-letter.ts,replay.routes.ts,media.ts,media.routes.ts,metrics.ts}` + tests — created
- `app/backend/src/platform/redis/lua/inbound-bucket.lua` — created
- `app/backend/src/platform/storage.ts`, `app/backend/src/platform/storage.s3.ts` — created
- `app/backend/src/platform/metrics.ts` — changed: five inbox metrics, no tenant labels
- `app/backend/src/platform/config.ts` — changed: `INBOUND_MAX_PER_MINUTE`, media caps, storage/MinIO settings
- `app/backend/src/roles/session-worker.ts` — changed: filter → admission → inbound/echo split, one try/catch per message
- `app/backend/src/modules/queue/echo-capture.ts` — changed: upserts the outbound `messages` row, keeps the `message_id NULL` evidence path
- `app/backend/src/engine/queue/result.ts` + the P11 result statement in `db/queries/` — changed: outbound `messages` + `chats` write
- `app/backend/test/integration/inbound/{inbound,dead-letter,admission,media}.int.test.ts` — created
- `infra/compose/docker-compose.dev.yml` — changed: MinIO service
- `scripts/cross-tenant-queries.ts` — changed: partition/FTS + media retention sweeps
- `docs/evidence/P21-inbound-demo.md` — created

## Risks / gotchas specific to this phase
- **Do not invent a third id authority.** `inbound_message_ids` is struck (delta, *Conversations and messages*; ADR 0017 §3). The inbound gate is `message_wa_ids` with `direction` in the PK — non-partitioned, `client_id NOT NULL`, RLS FORCE. A `UNIQUE (instance_id, external_id)` on the partitioned `messages` table silently becomes per-partition and turns blueprint test 21 red.
- **A duplicate is not a collision.** 0 rows from the gate = genuine duplicate, stop quietly. A row with the same `wa_msg_id` but `direction='out'` is a **different** situation: count `wp_inbound_id_collision_total`, keep both rows, merge nothing.
- **Never store or log `rawMessage`.** Rendered body only (blueprint *Inbox, compliance, admin*). Third-party PII we have no consent to keep is not a debugging convenience. The same rule kills "just log the payload on error" — that is what `error_class` + `raw_size` are for.
- **One try/catch per message, and the catch must write.** A catch that only logs is permanent loss of a customer's message: WhatsApp will not redeliver it. The dead-letter write is its **own** transaction, so it survives the failure of the main one.
- **The dead-letter write can itself fail.** If Postgres is down, count `wp_inbound_dead_letters_total{error_class='persist_failed'}`, log ids only, keep the socket. Do **not** buffer inbound messages in memory to "retry later" — an unbounded in-memory queue is exactly the OOM shape ADR 0018 budgets against, and it makes the loss silent again.
- **Admission control fails open.** The bucket is a fairness control, not a safety control; a Redis outage must not stop storing customer mail. Shedding, when it happens, is disclosed in the panel — *"high inbound volume — some group messages are not being stored"* — never hidden behind a spinner.
- **`redis-sig` stays `noeviction`.** If a decrypt failure spike appears while testing, the fix is sizing and the `wp_signal_decrypt_failure_total{cause}` metric — **never** switching to `allkeys-lru`. Evicting a Signal session record makes already-encrypted inbound customer mail permanently unreadable (ADR 0018 §5).
- **FTS belongs on partitions, not the parent.** A `STORED` `body_tsv` + GIN on the parent builds and maintains across every partition while the UI only searches 90 days, and child indexes cannot be dropped while the parent index exists. Rotation lives in the same helper that creates partitions, or it will be forgotten.
- **Media must never be buffered.** Cap and MIME-check **before** the download, stream through `storage.put()`, semaphore of 4. A 16 MB `Buffer.concat` on a busy worker is a multi-hundred-MB spike across 135 sessions.
- **Retention (founder open question 10) is undecided.** Default for this session: **24 months** for `messages` and `media_assets`, implemented as partition drops + an object-store sweep so shortening later is cheap and lengthening is not. Record the default in a one-paragraph `/decide` at C6; do not silently bake it in and do not block the phase on an answer.
- **Per-user unread state is deferred to v2 and is a known product hole** (delta, *Inbox*). `chats.unread_count` is workspace-level. Say so in the session log and carry it into P22's file rather than quietly implementing a per-user variant here.
- **Panel UI is P22.** This phase ends at durable rows + one `chat.updated` event. Building a thread component here will collide with P22's keyset pagination and search work.
- **If the session clock runs out**, the split line is after step 8: `P21a-inbound-media-pipeline.md` carries steps 9-10 (storage port, media pipeline, metrics/copy/evidence). Do **not** split before step 8 — an inbound handler that stores nothing outbound leaves the thread half-broken and the P12 echo path dangling. Add the `P21a` row to `plan/README.md` and write its next-session prompt instead.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P22 — inbox-conversation-and-reply. Read plan/v1/P22-inbox-conversation-and-reply.md and follow
it exactly: one phase, one session. Deps P21 are done (see plan/README.md). Do not start P23.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
