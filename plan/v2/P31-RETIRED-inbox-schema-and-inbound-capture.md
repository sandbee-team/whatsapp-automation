# P31 — inbox-schema-and-inbound-capture

> **RETIRED 2026-09-11 (founder, ADR 0051):** *"V2 me inbox ke alawa all thing hame karna hai, inbox add hi nahi karna
> hai."* / *"hame real chat yaha show karni hi nahi hai."* The inbox product is not part of v2. This file is kept for the
> record (memory protocol: never delete); its number is never reused; do not start it. Former slug: `P31-inbox-schema-and-inbound-capture`.


**Goal (one line):** the inbox product's schema (`chats`, `messages`, `media_assets`) exists, a real inbound
message is captured into it in one transaction under `wp_scheduler` with a peppered sender hash and never a
raw body log, and a partition-maintenance loop keeps `messages` ahead of the calendar.
**Status:** retired (2026-09-11, ADR 0051 - inbox removed from v2) · **Size:** M · **Session:** 1 of 1
**Depends on:** P30, P30a (plans/pricing - retention attribute; P30a owns the retention legal draft), P21, P23a (must be `done`); transitively P20 (contacts), P24 (groups/`send_enabled`)
**Blocks:** P32, P33

> **V2-P3 mapping (ADR 0043).** This file implements the first third of the V2-P3 outline row (write path
> only) — no chat list, no thread UI, no reply. See `plan/v2/README.md`'s appended v2 table.

## Prerequisites (facts, not phases)
- Postgres **17** + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean on a
  fresh volume; quick gate `pnpm run typecheck && pnpm run guards:meta` green on the tree as found
  (SESSION-PROTOCOL **O2**).
- Migrations are at schema version **75** (`db/src/schema-version.ts`); the highest file on disk is
  `db/migrations/0075_clients_consent_tos_version.sql`. **0076 is already reserved** (ADR 0044 §4, pricing,
  `0076_pricing_real_figures.sql`) — this phase's migrations are **0077 and 0078**. Re-verify by listing
  `db/migrations/` at session open; never trust this line if the directory disagrees (ADR 0046 §1).
- **ADR 0043 and ADR 0046 are both founder-accepted.** Until then this phase does not start (SESSION-PROTOCOL
  O3 — a design decision already exists, but its acceptance is the gate).
- P21 landed: the headless inbound dispatcher (`handler.ts`), admission bucket, in-flight limiter,
  dead-letter writer, `shouldIgnoreJid`, `message_wa_ids` (currently `direction='out'` only in production
  use), `optout-detect`, the contact touch-points. This phase extends the dispatcher; it does not replace it.
- P24 landed: `send_enabled` group gating and `wa_groups` (counts-only).
- The session-worker process connects to Postgres under the `wp_scheduler` login
  (`engine/session/session-worker-health-loop-wiring.ts`) — this is the role the capture transaction runs
  under, **not** `wp_app`.
- ADR 0003 holds: **no git in this repo, ever.** "Files created or changed this session" is the diff.

## What you are building
- **Three new tables** (migrations 0077, 0078): `chats` (conversation header, non-partitioned, unique on
  `(client_id, instance_id, jid)`), `messages` (body store, monthly-partitioned by `created_at`, PK
  `(id, created_at)`), `media_assets` (object metadata, non-partitioned, unique on `(client_id, object_key)`),
  plus `chat_read_state` and three new `whatsapp_instances` columns (`capture_bodies`, `capture_media`,
  `capture_groups`, all `DEFAULT false`, platform/staff-set only).
- **The inbound capture transaction** (`modules/inbox/capture.ts`): extends P21's dispatcher — filter →
  admission → in-flight limiter are unchanged — with a gate insert on `message_wa_ids (direction='in')`,
  an in/out id-collision check (dead-lettered, never paused), chat resolve-or-create, the `messages` insert
  (rendered body only, **never** `rawMessage`), the `sender_jid_hash` peppered HMAC, chat/contact
  touch-points, the opt-out hook (unchanged authority), and one `chat.updated` outbox event with a non-null
  `coalesce_key`.
- **`packages/domain/src/inbound/render-body.ts`**: pure Baileys-message → `{msgType, body, quotedWaMsgId,
  mediaRef}` renderer that never returns `rawMessage`.
- **The `wp_scheduler` grant fix**: column-scoped UPDATE on `message_wa_ids (inbox_message_id,
  inbox_message_created_at)` and the `inbound_dead_letters` grants that P21 mistakenly left on `wp_app`
  only (ADR 0046 §2 — the dead-letter writer runs in the session worker too).
- **Partition-maintenance cron loop**: calls `ensureAllPartitions` on a `wp_migrator`-privileged connection
  at a cadence with margin over the 3-month seed — without it, capture hard-fails the moment the third
  seeded month elapses.
- Isolation suite A registrations for all four new tables (`chats`, `messages`, `media_assets`,
  `chat_read_state`) in `TENANT_TABLE_COVERAGE`/`check-tenant-scope.ts`, plus three `CANONICAL_AUTHORITY_KEYS`
  entries (`chat_read_state`'s PK leads with `client_id` and needs none), and the grant proof reconciled for
  **both** `wp_scheduler` and `wp_app`.
- The new inbox metrics registered in the `@wp/domain` metric inventory (`wp_inbound_id_collision_total` plus
  the rest of design §6's seven metrics and new `error_class` labels), manifest regenerated.
- The cadence assertion required by ADR 0046 §8: no inbox timer registers an interval below 300 s.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| ADR (opening order) | `.memory/decisions/0043-v2-opening-order-and-phase-numbering.md` | all |
| ADR (data model) | `.memory/decisions/0046-inbox-product-data-model-and-message-lifecycle.md` | §1, §1a, §2, §2a, §8, §9 |
| Design doc | `.memory/research/2026-09-11-v2-inbox-design.md` | §1 (files), §2 (DDL), §8 (P31 dispatch plan) |
| Invariants | `.claude/rules/core-invariants.md` | all, esp. mechanical conventions on units/quantities and ambient-state assertions |
| Path rules | `.claude/rules/database.md` | all |
| v1 module (extends) | `app/backend/src/modules/inbound/handler.ts`, `dead-letter.ts`, `admission.ts`, `inflight-limiter.ts` | the dispatcher this phase extends, unchanged |
| v1 module (echo) | `app/backend/src/modules/queue/echo-capture.ts` | the update path this phase's `messages` row must not collide with (P33 owns the fix; this phase must not touch `result.ts`) |
| Precedent (dead-letter table + suite-A rescue) | `db/migrations/0063_inbound_dead_letters.sql`, `db/src/isolation/canonical-authority-keys-p20-plus.ts` | the `match:{kind:'primary_key'}` idiom this phase repeats 3× |
| Precedent (composite tenant FK) | migration 0061 (contacts tag links) | why every new FK here carries `client_id` |
| Retention registry (NOT touched here) | `db/src/retention.ts` | read only — confirms no policy entry exists yet; P35 widens it, this phase must not |

## Dispatch plan (written at cut time, per SESSION-PROTOCOL E1)

**Units (order; ‖ = parallel):** U1 (solo, migrations) → (U2 ‖ U3) → U4 (serial after U3).

- **U1** (db-engineer, solo — migrations never run in parallel with anything): steps 2, 3, 4. Files:
  `db/migrations/{0077_inbox_chats_messages,0078_inbox_media_assets}.sql`,
  `db/schema/{chats,messages,chat-read-state,media-assets,whatsapp-instances,index}.ts`,
  `db/src/isolation/{tenant-tables,canonical-authority-keys-p20-plus}.ts`, `db/src/schema-version.ts`,
  `scripts/check-tenant-scope.ts`, the grant proof, `db/tests/inbox-schema.test.ts`.
- **U2** (implementer, parallel with U3 — disjoint files): step 5. Files:
  `packages/domain/src/inbound/render-body.ts` + `.test.ts`, `packages/domain/src/inbound/index.ts`,
  `packages/domain/src/index.ts` (export line only).
- **U3** (implementer, parallel with U2 — disjoint files): steps 6, 7, 8. Files:
  `app/backend/src/modules/inbox/{chats.repo,messages.repo,capture}.ts` + tests,
  `app/backend/test/integration/inbox/capture.integration.test.ts`,
  `app/backend/src/modules/inbound/handler.ts` (changed: one new call site only).
- **U4** (implementer, serial after U3 — depends on capture.ts existing): steps 9, 10. Files:
  `app/backend/src/engine/cron/{inbox-partition-maintenance,inbox-loop-cadence}.ts` + tests,
  `app/backend/src/modules/inbox/metrics.ts` (new), `packages/domain/src/obs/metric-inventory-*.ts` (changed),
  `scripts/check-scheduler-queries.ts` (changed), `app/backend/test/security/log-grep-pii.integration.test.ts`
  (changed), `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts`,
  the two retired-and-replaced test names (delete from their v1 file, add the replacements).

**Shared contracts named up front:** `render-body.ts`'s output shape (`{msgType, body, quotedWaMsgId,
mediaRef}`) is fixed by U2 and consumed unchanged by U3's `capture.ts`. The `chats`/`messages`/`media_assets`
column names and the three `CANONICAL_AUTHORITY_KEYS` entries are fixed by U1 before U2/U3 start (U1 is
first in the sequence, not merely non-parallel — U2/U3 cannot write against schema that does not exist yet).
`capture.ts`'s transaction statement order (ADR 0046 §2) is the contract U4's log-grep and suite-B tests
assert against; U4 must not alter it. After U3 lands, run
`pnpm vitest run app/backend/src/modules/inbox app/backend/src/modules/inbound packages/domain/src/inbound`
once before starting U4.

## Ordered minimum steps
- [ ] 1. Write the failing tests first (all red, none skipped) → `db/tests/inbox-schema.test.ts`,
      `packages/domain/src/inbound/render-body.test.ts`, `app/backend/src/modules/inbox/capture.test.ts`,
      `app/backend/test/integration/inbox/capture.integration.test.ts`.
- [ ] 2. **(db-engineer) Migration 0077** — `chats`, `messages` (+ 3 partitions), `chat_read_state`; composite
      tenant FKs per ADR 0046 §1a → `db/migrations/0077_inbox_chats_messages.sql`,
      `db/schema/{chats,messages,chat-read-state}.ts`. Confirm or `ALTER TYPE` the `chat_kind` label set
      against migration 0008's placeholder flag and record the confirmation here.
- [ ] 3. **(db-engineer) Migration 0078** — `media_assets` + the three `whatsapp_instances` capture-flag
      columns → `db/migrations/0078_inbox_media_assets.sql`, `db/schema/media-assets.ts`,
      `db/schema/whatsapp-instances.ts` (changed).
- [ ] 4. **(db-engineer) Isolation + grants** — `TENANT_TABLE_COVERAGE` + `check-tenant-scope.ts` lock-step for
      all FOUR new tables (`chats`, `messages`, `media_assets`, `chat_read_state`), plus THREE
      `CANONICAL_AUTHORITY_KEYS` entries (`chats`, `messages`, `media_assets`, `match:{kind:'primary_key'}`;
      `chat_read_state`'s PK leads with `client_id` and needs none), the `wp_scheduler`/`wp_app`/`wp_admin_app`
      grants from ADR 0046 §2's table incl. the `message_wa_ids` column-scoped UPDATE fix and the
      `inbound_dead_letters` grant fix, `db/src/schema-version.ts` 75→78 →
      `db/src/isolation/{tenant-tables,canonical-authority-keys-p20-plus}.ts`, `scripts/check-tenant-scope.ts`;
      reconcile the grant proof in `db/tests/grants-snapshot.test.ts` (and the P28 sibling for
      `wp_admin_app`) for both `wp_scheduler` and `wp_app`.
- [ ] 5. `packages/domain/src/inbound/render-body.ts` — pure renderer, never returns `rawMessage`, 256-char-safe
      caption/text extraction reusing P21's extractor idiom where possible.
- [ ] 6. `modules/inbox/{chats.repo,messages.repo}.ts` — resolve-or-create chat, insert message, link
      `inbox_message_id`, chat counter/preview update, all parameterised, all tenant-scoped.
- [ ] 7. `modules/inbox/capture.ts` — the full transaction per ADR 0046 §2's ordered statement list, incl. the
      `sender_jid_hash` peppered HMAC via `hashRecipient` under the `optout-pepper` KEK purpose (confirm the
      mount exists in the session-worker role composition; add if not) and the `id_collision` dead-letter path.
- [ ] 8. Wire `capture.ts` into `modules/inbound/handler.ts`'s `fromMe === false` branch, inside the same
      `withTenant` transaction as `handleInboundMessageSignals` — dispatcher/admission/limiter untouched.
- [ ] 9. Partition-maintenance cron loop (`wp_migrator`-privileged connection) + `SCHEDULER_LOOP_MODULES`
      registration + the cadence assertion (no inbox timer registers an interval below 300 s) →
      `engine/cron/inbox-partition-maintenance.ts` (new), `engine/cron/inbox-loop-cadence.test.ts` (new),
      `scripts/check-scheduler-queries.ts` (changed) + register the new inbox metrics in the `@wp/domain`
      metric inventory and regenerate the manifest (`pnpm check:metric-inventory`,
      `pnpm check:metric-manifest`) → `app/backend/src/modules/inbox/metrics.ts` (new),
      `packages/domain/src/obs/metric-inventory-*.ts` (changed).
- [ ] 10. Retire the two v1 guard tests and replace them (never delete silently) → remove
      `no_chats_messages_or_media_assets_table_exists_in_v1` and
      `the_inbound_path_writes_no_message_body_to_any_store`, add
      `the_inbound_path_writes_no_raw_message_json` and extend
      `app/backend/test/security/log-grep-pii.integration.test.ts` with a seeded body.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/tests/inbox-schema.test.ts` | `chats_messages_media_assets_and_chat_read_state_lead_with_client_id_and_are_rls_forced` | isolation suite A entry for all four; exemption list still three |
| `db/tests/inbox-schema.test.ts` | `messages_pk_includes_the_partition_key_and_is_registered_as_a_canonical_authority` | `(id, created_at)` PK + `CANONICAL_AUTHORITY_KEYS` entry present |
| `db/tests/partitions.test.ts` (changed) | `a_messages_partition_exists_for_now_plus_n_months_at_the_configured_cadence` | partition-maintenance loop keeps ≥3 months ahead |
| `packages/domain/src/inbound/render-body.test.ts` | `the_body_renderer_never_returns_raw_message_json` | every fixture message type; `rawMessage` in no output field |
| `app/backend/src/modules/inbox/capture.test.ts` | `sender_jid_hash_equals_hashRecipient_output_and_is_NOT_the_bare_sha256` | exact expected bytes vs the peppered HMAC, not a bound |
| `app/backend/test/integration/inbox/capture.integration.test.ts` | `a_replayed_inbound_message_writes_exactly_one_messages_row` | concurrent duplicate under the `message_wa_ids (direction='in')` gate |
| `app/backend/test/integration/inbox/capture.integration.test.ts` | `an_id_collision_with_an_existing_outbound_wa_msg_id_dead_letters_and_never_pauses` | `error_class='id_collision'`, zero body, zero unread increment, instance still `connected` |
| `app/backend/test/integration/inbox/capture.integration.test.ts` | `an_undecryptable_inbound_dead_letters_and_never_pauses_the_instance` | fail-safe path, core invariant 2 |
| `app/backend/test/integration/inbox/capture.integration.test.ts` | `the_capture_transaction_executes_under_SET_LOCAL_ROLE_wp_scheduler` | the P16-lesson production-role proof; grants exercised for real |
| `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts` | `tenant_Bs_rows_are_never_visible_or_modifiable_under_tenant_A_context` | invariant itself, not a sampled outcome |
| `app/backend/src/modules/inbox/isolation-suite-b-inbox.integration.test.ts` | `the_inflight_limiter_bound_is_honoured` | invariant, never a sampled starvation margin |
| `app/backend/test/security/log-grep-pii.integration.test.ts` (changed) | `no_body_or_phone_number_appears_in_any_log_metric_or_audit_value` | seeded body present in DB but absent from every log/metric/audit surface |
| `scripts/__tests__/check-scheduler-queries.test.ts` | `every_inbox_loop_module_is_registered_and_its_sql_carries_a_limit` | pinned `SCHEDULER_LOOP_MODULES` list includes the partition loop |
| `app/backend/src/engine/cron/inbox-loop-cadence.test.ts` | `no_inbox_timer_registers_an_interval_below_300_seconds` | ADR 0046 §8's normative cadence floor, source-level assertion |

Mandatory-suite tests this phase makes green: **none new from the blueprint's numbered tables.** It extends
**isolation suites A and B** and the log-grep PII scan; retires and replaces
`no_chats_messages_or_media_assets_table_exists_in_v1` and `the_inbound_path_writes_no_message_body_to_any_store`.

**Demonstrable outcome:** a real inbound message lands as one `chats` row + one `messages` row with its gate
row, under `SET LOCAL ROLE wp_scheduler`; a duplicate event writes nothing extra; a decrypt failure or an
in/out id collision dead-letters without pausing; zero bodies anywhere in logs.

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
- **This phase owns EVERY migration for P31-P33; it never runs in parallel with anything.** U1 (migrations)
  is solo in its slot — see Dispatch plan.
- **The `wp_scheduler` role, not `wp_app`, is the real writer.** A capture transaction proven only under a
  BYPASSRLS/superuser dev role is not proof (see lesson `2026-09-02-dev-superuser-hides-force-rls-bugs.md`);
  the `SET LOCAL ROLE wp_scheduler` test is mandatory, not optional.
- **`inbound_max_per_minute` and the in-flight limiter are NOT widened.** This transaction is ~8 statements,
  roughly double v1's per-message DB work, inside the same fixed-size pool. State the measured
  statements-per-inbound in the session log; if the limiter needs raising, that is a `/decide`, not a silent edit.
- **Same-chat serialization is accepted, not a bug.** Concurrent inbound to the same chat lock the same
  `chats` row; the isolation-suite-B test asserts the tenant/limiter invariant, never a starvation timing
  margin (core-invariants.md's ambient-state rule).
- **`sender_jid_hash` must be the peppered HMAC, never a bare sha256** — a bare hash over the phone-number
  space is brute-forceable and would make this column recoverable PII in a table that now holds bodies.
  `inbound_dead_letters.chat_jid_hash` (plain sha256) is *not* the precedent to copy.
- **Suite-A index-lead rule**: `chats.id`, `media_assets.id`, `messages.(id, created_at)` all lead with `id`.
  Omitting the three `CANONICAL_AUTHORITY_KEYS` entries takes isolation suite A red — this is the exact gap
  the first ADR draft had.
- **No `chats.jid` retention/erasure logic here.** Retention (partition drop, media reaper, per-contact
  erasure) is entirely P35's; this phase must not add a `RETENTION_POLICIES` entry or any DELETE grant.
- **300-line cap**: `canonical-authority-keys-p20-plus.ts` and `whatsapp-instances.ts` schema descriptor are
  candidates to approach the cap; check with `wc -l` before reporting, reclaim from descriptive prose first.
- **Test file placement**: any new `app/backend` unit test reaching `@wp/server-kit` imports the
  stub-env file first; real-infra tests are `*.integration.test.ts`, never `*.test.ts`.
- **PowerShell gate invocation**: `powershell -File scripts/gate.ps1` only, never a composed pipeline.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P32 — inbox-read-api-realtime-and-thread-ui. Read plan/v2/P32-inbox-read-api-realtime-and-thread-ui.md
and follow it exactly: one phase, one session. Dep P31 is done (see plan/v2/README.md). Do not start P33.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
