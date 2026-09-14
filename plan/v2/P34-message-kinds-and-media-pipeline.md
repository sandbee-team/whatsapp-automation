# P34 — message-kinds-and-media-pipeline

**Goal (one line):** The outbound payload widens from an open `z.record` to a closed per-kind discriminated union (text/image/video/audio/document), backed by a tenant-scoped media upload pipeline and an exhaustive transport switch, so a media kind can never again silently send as text.
**Status:** todo - **UNBLOCKED 2026-09-14 for the ACCEPTED SCOPE only** (ADR 0052 "Founder acceptance 2026-09-14": outbound **image + document** only, upload-then-send, caps 5 MB / 20 MB. Video, audio, templates, scheduling and the composer work remain BLOCKED and belong to P35/P36. P30a is NOT a prerequisite for this slice - it carries no plan entitlement.)
**Size:** M · **Session:** 1 of 1
**Depends on:** P30a, P20, P23, P23a (must be `done`)
**Blocks:** P35

## Prerequisites (facts, not phases)
- ADR 0052 accepted (founder). ADR 0050/0051 accepted; P30a done so entitlements and prices come from plan versions (`plan_versions`, `plan_entitlements`, `resolveEffectiveEntitlements`).
- Postgres 17 + Redis up via `infra/compose/docker-compose.dev.yml`; `pnpm db:migrate` clean on a fresh volume; quick gate `pnpm run typecheck && pnpm run guards:meta` green on the tree as found (SESSION-PROTOCOL O2).
- `db/migrations/` is **listed at session open** and the next free 4-digit number is taken — do not assume `0076`; verify.
- The v1 object store (`app/backend/src/platform/storage/`) and the v1 broadcast engine (snapshot → ref-first expansion → paced claim → funnel, ADR 0017/0041) exist and are **unchanged** by this phase — this is a payload/pipeline phase, not an engine change.
- `message_jobs.payload_kind` stays the closed PG enum `job_kind ('text','media','reply')` — this phase does **not** widen it; the fine kind lives only inside `payload.kind` (ADR 0052 §7.1).
- The `media_messages` plan entitlement (ADR 0052 §8) is added and seeded **in this phase**, not P35, so `POST /v1/media` is gated by a real entitlement from day one rather than shipping ungated. `message_templates` and `scheduled_sends` remain P35's (their enforcement points — the templates CRUD routes and the scheduled-broadcast branch — do not exist until P35).

## What you are building (3-6 bullets)
- A closed discriminated-union payload contract (`text`/`image`/`video`/`audio`/`document`) replacing the open `z.record`, with the `message_jobs` payload CHECK raised 2048 → 8192 bytes via the `NOT VALID` + `VALIDATE` sequence (never a blocking `ADD CONSTRAINT`).
- A tenant-scoped media upload pipeline: `media_assets` table, magic-byte MIME sniffing (with the `text/*` UTF-8 carve-out), an object-store port widened to a `'media'` kind, `POST /v1/media` and a streaming `GET /v1/media/:id/content` (no presigned URLs).
- An exhaustive `toWaContent()` transport switch — the current text-for-everything fallback is deleted; an unhandled kind throws `TransportSendError('invalid_payload', ...)`, terminal, never retried.
- The two live guard holes closed: captions become guarded exactly like bodies (`extractBody` kind-aware in both `pipeline.ts` and `send-loop-claim-evaluation.ts`), and a TEMPLATE-derived fingerprint is written to `message_jobs.content_fingerprint` at expansion so personalisation can no longer defeat the duplicate fan-out guard.
- The quote/debit price-key divergence fixed: broadcast expansion threads the campaign's real message kind (mapped through `MEDIA_KINDS.has(...)`) instead of the `'text'` literal, so `quote_minor` and the ledger debit always agree.
- The `media_messages` plan entitlement (one `ADD VALUE` + a seed row, sequential migrations per the 0059 idiom) gates `POST /v1/media` and the kind validator from the moment the route ships.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Design doc | `.memory/research/2026-09-11-messaging-depth-and-simple-broadcast-design.md` | §1-5, §10 (P34 unit table) |
| ADR | `.memory/decisions/0052-messaging-depth-and-simple-broadcast.md` | §1, §1.1, §2, §3, §7, §7.1, §7.2 |
| ADR | `.memory/decisions/0050-plans-entitlements-and-admin-managed-pricing.md` | §2 (entitlements shape), §3 (resolution order) |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | Broadcast disclosure/engine (unchanged) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | pricing/debit invariants |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md`, `.claude/rules/api.md` | all |
| v1 module (payload) | `packages/contracts/src/messages.ts` | current `messageKindSchema`/`messagePayloadSchema` |
| v1 module (transport) | `app/backend/src/provider/baileys/adapter.ts` | `toWaContent()` (the fallback being deleted) |
| v1 module (pricing) | `packages/domain/src/pricing.ts` | `resolvePriceKey` (unchanged, mapping applied at write site) |
| v1 module (guards) | `app/backend/src/modules/pacing/guards/pipeline.ts`, `app/backend/src/engine/queue/send-loop-claim-evaluation.ts` | `extractBody` (the two sites that must not drift) |
| v1 module (fingerprint) | `app/backend/src/modules/pacing/content/fingerprint.ts`, `packages/domain/src/content/normalise-body.ts` | current normalisation (unchanged) |
| v1 module (expansion) | `app/backend/src/modules/broadcasts/expansion.{worker,repo}.ts` | the `'text'` literal being replaced |
| v1 module (object store) | `app/backend/src/platform/storage/{object-store-keys,object-store,object-store-types,object-store-fs,object-store-s3}.ts` | current `ObjectKind`/`contentType` literals |

## Dispatch plan
5 units. U1a and U1b are migrations and run alone, sequentially (U1a before U1b). U2, U3, U3b run in parallel (disjoint file scopes: domain+contracts / key-builder+sniffer / object-store port). U4 runs after U1b+U2+U3+U3b. U5 runs after U2.

| Unit | Agent | File scope | Parallel |
|---|---|---|---|
| U1a MIGRATION enums only | db-engineer | `db/migrations/00NN_message_media_enums.sql` (the two `CREATE TYPE` statements and nothing else), `db/migrations/00NN_plan_entitlement_media_messages_value.sql` (the single `ALTER TYPE plan_entitlement ADD VALUE 'media_messages'` and nothing else), `packages/domain/src/enums/index.ts` (`PG_ENUMS`, exact label order) | none |
| U1b MIGRATION tables + ALTERs + registries | db-engineer | `db/migrations/00NN_media_assets_and_templates.sql` (both tables + RLS/FORCE/policy + composite tenant FKs + `campaigns` ALTERs (`parent_campaign_id` + its composite tenant FK, `default_var_values`) + the `NOT VALID`/`VALIDATE` payload CHECK swap + full grants: `wp_app` DML on both tables, `wp_scheduler` SELECT on `media_assets` + column-scoped `UPDATE (last_used_at)`, `GRANT SELECT` to `wp_admin_app` on both), `db/migrations/00NN_plan_entitlements_media_messages_seed.sql` (the `plan_entitlements` seed row `media_messages = ON` per existing plan version), `db/schema/{media-assets,message-templates,campaigns,plan-entitlements}.ts`, `db/schema/grants.snapshot.json`, `db/src/isolation/tenant-tables.ts`, `db/src/schema-version.ts` | none, after U1a |
| U2 domain + contracts | implementer | `packages/domain/src/message/kinds.ts`, `packages/domain/src/copy/media-copy.ts`, `packages/domain/src/pacing/send-origin.ts` (+ test), `packages/contracts/src/{messages,media}.ts` + tests, `scripts/check-forbidden-mechanisms.ts` + `scripts/guards/check-forbidden-mechanisms.test.ts` (add the six banned identifiers: `spintax`, `spin_text`, `randomizeBody`, `humanize`, `antiBan`, `bypass`). `pricing.ts` and `queue/content-hash.ts` UNCHANGED | ‖ U3, U3b |
| U3 key builder + sniffer | implementer | `app/backend/src/platform/storage/{object-store-keys,media-sniff}.ts` + tests (incl. the `text/*` UTF-8 carve-out) | ‖ U2, U3b |
| U3b object-store port widening | implementer | `app/backend/src/platform/storage/{object-store-types,object-store,object-store-fs,object-store-s3}.ts` + tests | ‖ U2, U3 |
| U4 media module + routes | implementer | `app/backend/src/modules/media/**` (incl. `GET /v1/media/:id/content` streaming, the `media_messages` entitlement gate on `POST /v1/media`), route registration, the four `wp_*` metric registrations (`wp_media_uploads_total{kind,result}`, `wp_media_bytes_stored`, `wp_media_fetch_failures_total{reason}`) + `scripts/registries/` metric-manifest regeneration | after U1b, U2, U3, U3b |
| U5 transport arms + dispatch + guard holes | implementer | `app/backend/src/provider/{provider.types.ts,baileys/adapter.ts,baileys/media-content.ts}`, `engine/queue/dispatch.ts` (split a sibling if it crosses 300 lines; stamp `media_assets.last_used_at = now()` under the column-scoped `wp_scheduler` grant at dispatch), `modules/pacing/guards/pipeline.ts` + `engine/queue/send-loop-claim-evaluation.ts` (kind-aware `extractBody`), `modules/broadcasts/expansion.{worker,repo}.ts` (real `payloadKind` + template fingerprint), the `wp_message_kind_sent_total{kind}` metric registration + manifest regeneration + tests | after U2 |

## Ordered minimum steps
- [ ] 1. List `db/migrations/` and confirm the next free number; write the two enum-only `CREATE TYPE` statements plus the single `ALTER TYPE plan_entitlement ADD VALUE 'media_messages'` (own file, nothing else) → `db/migrations/00NN_message_media_enums.sql`, `db/migrations/00NN_plan_entitlement_media_messages_value.sql`, register in `packages/domain/src/enums/index.ts`.
- [ ] 2. Migration: `media_assets` + `message_templates` tables, RLS, composite tenant FKs, `campaigns` ALTERs (`parent_campaign_id` + its composite tenant FK, `default_var_values`), the payload-size CHECK swap (`NOT VALID` + separate `VALIDATE`), full grants (`wp_app` DML on both tables, `wp_scheduler` SELECT on `media_assets` + column-scoped `UPDATE (last_used_at)`, `wp_admin_app` SELECT on both), plus the `media_messages` seed row (`ON` for every existing plan version) → `db/migrations/00NN_media_assets_and_templates.sql`, `db/migrations/00NN_plan_entitlements_media_messages_seed.sql` + the four registries (enums, Drizzle schema, grants snapshot, tenant-tables + schema-version).
- [ ] 3. Closed discriminated-union payload contracts + `MEDIA_KINDS`/`MIME_ALLOW_LIST`/`SIZE_CAPS_BYTES` constants (image 5 MB / audio 16 MB / video 16 MB / **document 100 MB** — founder-ruled 2026-09-14, ADR 0052 Q1) + `'test'` added to `SEND_ORIGINS`/`NON_EXEMPT_ORIGINS` + the six banned identifiers (`spintax`, `spin_text`, `randomizeBody`, `humanize`, `antiBan`, `bypass`) added to the forbidden-mechanisms ban list → `packages/domain/src/message/kinds.ts`, `packages/domain/src/pacing/send-origin.ts`, `packages/contracts/src/{messages,media}.ts`, `scripts/check-forbidden-mechanisms.ts`.
- [ ] 4. Object-store key builder split (`buildImportObjectKey` keeps `.csv`; new `buildMediaObjectKey`) + magic-byte MIME sniffer with the `text/*` UTF-8 carve-out → `object-store-keys.ts`, `media-sniff.ts`.
- [ ] 5. Widen the `ObjectStore` port (`ObjectKind` gains `'media'`, `contentType` becomes a closed MIME union) across all four implementations → `object-store-types.ts`, `object-store.ts`, `object-store-fs.ts`, `object-store-s3.ts`.
- [ ] 6. Media module: upload service (stream → sniff → validate → `put()` → INSERT row), gated by the `media_messages` entitlement; `POST /v1/media`, `GET /v1/media/:id` (metadata), `GET /v1/media/:id/content` (streaming, tenant-scoped); register `wp_media_uploads_total{kind,result}`, `wp_media_bytes_stored`, `wp_media_fetch_failures_total{reason}` and regenerate the metric manifest → `app/backend/src/modules/media/**`, `pnpm run check:metric-inventory` green.
- [ ] 7. Transport widening: `WaMessagePayload` discriminated union, `TransportCapabilities.kinds` (removing `text`/`media`/`templates` booleans), exhaustive `toWaContent()` switch with a `never`-checked default that throws `invalid_payload` → `provider.types.ts`, `baileys/adapter.ts`, `baileys/media-content.ts`.
- [ ] 8. Dispatch resolves `mediaId → object key` at send time, streaming bytes without buffering the whole file; stamps `media_assets.last_used_at = now()` under the column-scoped `wp_scheduler` grant on every dispatch that references the asset; an object-store outage takes the guard-style DEFER path (no `attempts` increment) → `engine/queue/dispatch.ts`.
- [ ] 9. Close the two guard holes: kind-aware `extractBody` (`payload.text ?? payload.caption`) in both `modules/pacing/guards/pipeline.ts` and `engine/queue/send-loop-claim-evaluation.ts`; template-derived `content_fingerprint` written at expansion; real `payloadKind` (via `MEDIA_KINDS.has(...)`) threaded through `expansion.worker.ts`/`expansion.repo.ts` instead of the `'text'` literal; register `wp_message_kind_sent_total{kind}` and regenerate the metric manifest.
- [ ] 10. Grep for readers of `capabilities.text` and `capabilities.templates`; remove both fields in the same edit as `kinds` lands.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/contracts/src/messages.test.ts` | `the_payload_check_accepts_8192_and_rejects_8193` | exact boundary on the raised CHECK |
| `app/backend/src/provider/baileys/adapter.test.ts` | `a_media_kind_never_sends_as_text` | exhaustive switch; a planted unknown kind throws, current fallback removed |
| `app/backend/src/provider/baileys/adapter.test.ts` | `an_unknown_kind_fails_terminal_invalid_payload_and_never_retries` | `TransportSendError('invalid_payload')` is terminal, not retried |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `a_media_job_payload_contains_no_bytes` | job row/payload never carries raw media bytes, only `mediaId` |
| `app/backend/src/modules/media/media.integration.test.ts` | `no_filename_caption_or_mime_reaches_a_log_or_metric` | log/metric scan finds no filename, caption or MIME string |
| `app/backend/src/modules/media/media.integration.test.ts` | `a_foreign_media_id_yields_404_and_streams_nothing` | cross-tenant `mediaId` → 404, no bytes, no existence oracle |
| `app/backend/src/modules/media/media.integration.test.ts` | `a_non_opus_audio_upload_is_rejected_at_the_route` | non-OGG/Opus audio rejected at upload, no transcoding |
| `app/backend/src/platform/storage/media-sniff.test.ts` | `a_declared_mime_that_contradicts_the_magic_bytes_is_rejected` | both arms: binary declared/sniffed mismatch, and a text-declared binary signature |
| `app/backend/src/platform/storage/media-sniff.test.ts` | `a_text_document_with_no_magic_bytes_is_accepted_only_as_valid_utf8_without_control_bytes` | `text/csv`/`text/plain` structural validation path |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `an_object_store_outage_defers_without_burning_the_retry_budget` | DEFER path, `attempts` untouched, job preserved |
| `app/backend/src/modules/broadcasts/expansion.integration.test.ts` | `a_media_broadcast_quote_and_debit_use_the_same_price_key` | exact equality: `campaigns.quote_minor` equals the exact sum of ledger debits |
| `app/backend/src/modules/pacing/guards/pipeline.integration.test.ts` | `a_caption_is_blocked_word_and_link_guarded_exactly_like_a_body` | both `extractBody` sites; captioned media hits blocked-word/link/fan-out guards |
| `app/backend/src/modules/broadcasts/expansion.integration.test.ts` | `personalised_copies_of_one_template_share_the_EXACT_same_stored_fingerprint` | exact sha256 equality across differently-rendered recipients, never a bound |
| `app/backend/src/modules/broadcasts/expansion.integration.test.ts` | `two_captionless_media_sends_to_one_recipient_resolve_none` | ADR 0035 ambiguity behaviour preserved for captionless media |
| `db/tests/media-assets-schema.test.ts` | `a_media_asset_of_another_tenant_is_invisible_under_rls` | isolation suite A entry green |
| `db/tests/media-assets-schema.test.ts` | `the_object_key_of_every_asset_starts_with_its_own_client_prefix` | CHECK + property fuzz on `object_key` prefix |
| `db/tests/media-assets-schema.test.ts` | `wp_scheduler_cannot_insert_or_delete_a_media_asset` | grants snapshot: `wp_scheduler` SELECT on `media_assets` + column-scoped `UPDATE (last_used_at)` only, no INSERT/DELETE |
| `app/backend/src/modules/media/media.integration.test.ts` | `an_upload_past_the_cap_aborts_without_buffering_the_file` | size counter aborts stream before full buffering |
| `packages/domain/src/message/kinds.test.ts` | `capabilities_kinds_matches_the_exhaustive_transport_switch` | source scan: `TransportCapabilities.kinds` and the switch's handled kinds cannot drift |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `a_dispatch_stamps_last_used_at_on_the_referenced_asset` | `media_assets.last_used_at` is written at every dispatch that references the asset, under the column-scoped `wp_scheduler` grant |
| `app/backend/src/modules/wallet/charge.integration.test.ts` | `a_media_send_is_charged_the_media_rate_and_a_text_send_the_text_rate` | exact paise per kind against the resolved price key, never a bound |
| `app/backend/src/modules/media/media.integration.test.ts` | `a_disabled_media_entitlement_returns_409_and_creates_no_job` | `PlanEntitlementDisabledError` → 409 on `POST /v1/media`, zero job rows |
| `scripts/guards/check-forbidden-mechanisms.test.ts` | `no_spintax_or_randomisation_identifier_exists_in_the_tree` | the six banned identifiers (`spintax`, `spin_text`, `randomizeBody`, `humanize`, `antiBan`, `bypass`) are rejected anywhere in the tree |

Mandatory-suite tests this phase makes green: none from the v1 numbered tables (a v2 phase); the ADR 0052 §9 named test list above is this phase's own gate.

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
- **`max-lines: 300` is real.** `engine/queue/dispatch.ts` and `app/backend/src/provider/baileys/adapter.ts` have little headroom; the media-content builders and the DEFER-path branch are named as sibling-module splits up front (`baileys/media-content.ts`) rather than discovered mid-unit.
- **Every `app/backend` unit test whose import chain reaches `@wp/server-kit` must import `modules/realtime/__test-support__/stub-wp-server-kit-env.js` first** — the whole suite fails to load otherwise.
- **No ambient-state assertions.** Upload timing, sniffer throughput and file-size margins must never be asserted from live process state; assert exact byte boundaries and injected inputs only.
- **`ALTER TYPE ... ADD VALUE` never shares a transaction with a statement reading the new value** — U1a is enums only, nothing else, and U1b runs strictly after it.
- **The payload CHECK swap is NOT a plain `ADD CONSTRAINT`** — `message_jobs` is partitioned; use `DROP CONSTRAINT` → `ADD CONSTRAINT ... NOT VALID` → separate `VALIDATE CONSTRAINT`, never a blocking single statement.
- **Media never reaches a log line, metric label or event payload** — filenames, captions and MIME strings are banned from all three; the label allow-list is `kind`, `result`, `reason` only.
- **`check-copy` on every new copy string**, including any upload-rejection or disclosure text this unit touches.
- **No new integration test may assert on ambient state** (timing margins, sampled race outcomes) — inject the ambient input and assert the exact value instead.
- **`media_messages` is added and seeded HERE, not in P35** — `POST /v1/media` must never ship ungated even for one phase; the enum-value and seed migrations follow the same 1a/1b split as `message_templates`/`scheduled_sends` in P35, and this phase's `ADD VALUE` file touches only `plan_entitlement`, never a statement that reads it.
- **Size caps: image 5 MB / audio 16 MB / video 16 MB / document 100 MB (founder-ruled 2026-09-14, ADR 0052 Q1 — the earlier 20 MB standing figure was for inbound capture; this ADR amends it for outbound upload).** There is still no per-client stored-bytes quota; `wp_media_bytes_stored` is the watch signal (§2.2).
- **`media_assets.last_used_at` must be stamped, not just swept** — P35's retention sweeper reads this column; if dispatch does not write it (step 8), the sweep silently degrades to `created_at` and purges actively-used assets. This is column-scoped through `wp_scheduler`'s `UPDATE (last_used_at)` grant only — never a full-row update.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P35 — templates-personalisation-scheduling-and-resend. Read plan/v2/P35-templates-personalisation-scheduling-and-resend.md and follow it exactly:
one phase, one session. Deps P34 are done (see plan/v2/README.md). Do not start P36.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
