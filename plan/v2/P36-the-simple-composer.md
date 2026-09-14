# P36 — the-simple-composer

**Goal (one line):** A shared `<MessageComposer>` gives both the single-send and broadcast screens the same kind picker, media dropzone, variable picker, saved-messages picker and persistent phone-mock preview, on ONE page with no new mandatory clicks, and `BROADCAST_DISCLOSURE` is corrected to stop promising the removed inbox.
**Status:** todo (blocked: founder approval of ADR 0052; P30a done)
**Size:** M · **Session:** 1 of 1
**Depends on:** P35, P30a (must be `done`)
**Blocks:** —

## Prerequisites (facts, not phases)
- ADR 0052 accepted (founder). ADR 0050/0051 accepted; P30a done so entitlements and prices come from plan versions.
- P34/P35 landed: the closed message-kind contracts, the media pipeline and upload route, `message_templates`, single-send parity, scheduling and resend-to-failed. This phase is UI-only — no queue/db/money surface.
- Postgres 17 + Redis up via `infra/compose/docker-compose.dev.yml`; quick gate `pnpm run typecheck && pnpm run guards:meta` green on the tree as found (SESSION-PROTOCOL O2).
- The current broadcast composer is already a single page with a decorative `Stepper` (`composer.tsx:76-81`) — every field stays mounted and directly fillable in one pass; `fillBasicForm` and its sibling suites depend on this. This phase must not add click-through gating.

## What you are building (3-6 bullets)
- One shared `<MessageComposer>` in `features/shared/message-composer/**`, consumed by both the single-send screen and the broadcast composer's Message section — so the two screens cannot drift apart.
- A kind picker (text/image/document/video/audio), a media dropzone (`idle → uploading(%) → ready → rejected{reason}`), the variable picker (including "Custom fields" for `{{attrs.*}}`), "Use a saved message", and a persistent phone-mock preview pane.
- The broadcast composer collapses its `STEP_IDS` from four to three (Audience / Message / Review) while staying the same single-page, non-gated form; a charged test-send control is added to the Message section.
- The broadcast detail view gains a per-recipient reason column, a Resend-to-failed confirm flow, and an Export control.
- `BROADCAST_DISCLOSURE` is corrected: the struck Inbox-reply clause is removed, with a test asserting no `Inbox` token remains; `check-copy` gains the "message template" ban clause so tenant surfaces never claim Meta-approved templates.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Design doc | `.memory/research/2026-09-11-messaging-depth-and-simple-broadcast-design.md` | §7, §10 (P36 unit table) |
| ADR | `.memory/decisions/0052-messaging-depth-and-simple-broadcast.md` | §4, §5, §5.1, §5.2, §5.3, §6, §9 |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | `BROADCAST_DISCLOSURE` origin and copy rules |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/api.md` | route/UI-facing sections only (no db/queue surface this phase) |
| v1 module (composer) | `app/frontend/src/features/broadcasts/components/composer.tsx` | `STEP_IDS`, the single-page/decorative-stepper contract (lines 66, 76-81) |
| v1 module (disclosure) | `packages/domain/src/copy/disclosures.ts` | `BROADCAST_DISCLOSURE` (the Inbox clause being struck) |
| v1 module (copy guard) | `scripts/check-copy.ts` | co-presence rule this phase extends |
| P35 phase file | `plan/v2/P35-templates-personalisation-scheduling-and-resend.md` | Files created or changed (what actually landed) |

## Dispatch plan
5 units, all to ui-implementer, no queue/db/money surface. U1 and U2 run in parallel (disjoint scopes: composer+preview / i18n+copy). U3 and U4 run after U1, in parallel with each other. U5 runs after U3 and U4.

| Unit | Agent | File scope | Parallel |
|---|---|---|---|
| U1 shared composer + kind picker + preview | ui-implementer | `app/frontend/src/features/shared/message-composer/**`, `features/media/**` | ‖ U2 |
| U2 i18n + copy | ui-implementer | `packages/i18n/src/catalogues/{en-media,hi-media}.ts`, `en-broadcasts.ts`, `hi-broadcasts.ts`, `packages/domain/src/copy/disclosures.ts` (strike the Inbox clause + test), `scripts/check-copy.ts` (+ "message template" clause), `scripts/guards/check-copy.test.ts` | ‖ U1 |
| U3 composer: 3 sections on ONE page | ui-implementer | `features/broadcasts/components/{composer,phone-preview,kind-picker}.tsx`, `routes/_authed/broadcasts/new.tsx`, `__tests__/composer.test.tsx`, `__tests__/use-composer-retry-c2b.test.tsx` | after U1 |
| U4 detail: reasons, resend, export + single-send screen | ui-implementer | `features/broadcasts/components/{broadcast-detail,resend-confirm}.tsx`, `features/messages/compose/**`, `features/message-templates/**` | after U1 |
| U5 panel proof | ui-implementer | `features/broadcasts/__tests__/panel-proof.test.tsx` | after U3, U4 |

## Ordered minimum steps
- [ ] 1. Build the shared `<MessageComposer>` — kind picker, body/caption field with the variable picker, dropzone with the four-state upload lifecycle, "Use a saved message" — in `features/shared/message-composer/**`.
- [ ] 2. Build the persistent phone-mock preview pane rendering the first recipient's frozen vars, labelled "Preview — example recipient" → `features/shared/message-composer/**`.
- [ ] 3. Strike the Inbox clause from `BROADCAST_DISCLOSURE`; add the "message template" ban clause to `check-copy`; add media/broadcast i18n keys → `disclosures.ts`, `check-copy.ts`, `en-media.ts`/`hi-media.ts`.
- [ ] 4. Collapse the broadcast composer's `STEP_IDS` from four to three, keeping every field mounted (no click-through gating); wire the shared composer into the Message section; add the test-send control → `composer.tsx`, `phone-preview.tsx`, `kind-picker.tsx`.
- [ ] 5. Broadcast detail: per-recipient reason column, Resend-to-failed confirm flow, Export control → `broadcast-detail.tsx`, `resend-confirm.tsx`.
- [ ] 6. Single-send screen: consume the same shared composer component as the broadcast Message section → `features/messages/compose/**`.
- [ ] 7. Saved-messages picker UI (list/create/use) → `features/message-templates/**`.
- [ ] 8. Panel-proof test: compose (any media kind) → pre-flight → start → funnel drains, disclosure present in both locales, both screens render the same shared composer.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `features/shared/message-composer/__tests__/message-composer.test.tsx` | `the_kind_picker_offers_exactly_the_five_supported_kinds` | text/image/video/audio/document, no more |
| `features/shared/message-composer/__tests__/message-composer.test.tsx` | `the_dropzone_moves_through_idle_uploading_ready_and_rejected_states` | four-state lifecycle exercised |
| `features/broadcasts/__tests__/composer.test.tsx` | `every_field_stays_mounted_across_all_three_sections` | no click-through gating; `fillBasicForm` still passes unmodified |
| `features/broadcasts/__tests__/composer.test.tsx` | `step_ids_collapse_to_three_and_remain_decorative` | `STEP_IDS` length 3; stepper is not a gate |
| `features/broadcasts/__tests__/use-composer-retry-c2b.test.tsx` | (existing suite, extended) | still green with the collapsed `STEP_IDS` |
| `packages/domain/src/copy/disclosures.test.ts` | `broadcast_disclosure_contains_no_inbox_token` | no `Inbox` substring anywhere in `BROADCAST_DISCLOSURE` |
| `scripts/guards/check-copy.test.ts` | `no_tenant_surface_claims_a_meta_approved_message_template` | the bare phrase "message template" is banned on tenant copy surfaces |
| `messages/messages_composer_parity.test.tsx` | `single_send_and_broadcast_render_the_same_shared_composer_component` | both routes import and render the identical component instance type |
| `features/broadcasts/__tests__/broadcast-detail.test.tsx` | `resend_to_failed_shows_a_confirm_that_states_the_recharge` | confirm copy states failures may recur and the resend is charged again |
| `features/broadcasts/__tests__/panel-proof.test.tsx` | `a_media_broadcast_composes_previews_and_drains_over_the_funnel` | end-to-end panel proof; disclosure present in `en` and `hi` |

The forbidden-mechanisms identifier ban list (`scripts/guards/check-forbidden-mechanisms.test.ts`) is built and tested in **P34** (the earliest phase adding a variation-adjacent surface); it runs as part of every subsequent phase's gate, this one included, with no separate step here.

Mandatory-suite tests this phase makes green: none from the v1 numbered tables (a v2, UI-only phase); this phase closes the ADR 0052 §9 UI-surface tests not covered by P34/P35.

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
- **No click-through gating, ever.** The existing single-page contract (`composer.tsx:76-81`) is load-bearing for three existing suites (`composer.test.tsx`, `panel-proof.test.tsx`, `use-composer-retry-c2b.test.tsx`); collapsing `STEP_IDS` from four to three must not add a mandatory click.
- **`max-lines: 300` is real** on panel component files; check with `wc -l` before reporting green.
- **`check-copy` on every new copy string incl. the disclosure** — any file containing the standalone capitalised word "Broadcast" must render `BROADCAST_DISCLOSURE` verbatim (via the catalogue, not the bare word in source).
- **Media never in logs** — no filename, caption or MIME string in any client-side log/telemetry call this phase adds.
- **No ambient-state assertions** — the dropzone upload-progress test must drive percentage via an injected/mocked stream, never real upload timing.
- **The disclosure edit is a live copy correction, not cosmetic** — rendering the old Inbox-reply clause after ADR 0051 removed the inbox is a false product claim; ship the struck version everywhere before any other panel work in this phase lands.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
No phase is queued directly after P36 in this cut. Re-read plan/v2/README.md's outline rows
(P37 voice-notes-and-video-polish, P38 location-and-contact-card, V2-P4 automation/drip/A-B)
and cut the next phase file only after founder direction on which outline row opens next.
```
