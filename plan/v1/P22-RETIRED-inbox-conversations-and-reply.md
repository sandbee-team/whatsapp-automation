# P22 — RETIRED from v1 (inbox conversations and reply moved to v2)

**Status:** retired · **Date:** 2026-08-26 · **Decision:** ADR 0021

The founder moved the inbox **product** to v2 after seeing its cost (the derived 450-700 GB figure at 10k connected sessions with the inbox on, driven mostly by group sender-key state, media buffers and inbound event volume). This phase was the conversation thread UI and the reply composer; all of it is now **V2-P3**.

**The number P22 is not reused.** P23-P29 keep their numbers. A future session must not "tidy up" the gap by renumbering — every next-session prompt, dependency line and README row downstream assumes the current numbering.

## What survived, and where it lives now
| Was in P21/P22 | Now |
|---|---|
| Delivery receipts → `delivery_events` | **P21** (`inbound-listener-receipts-and-optout`) |
| STOP / opt-out detection and job cancellation | **P21**, calling P14's `optout-detect` hook |
| `fromMe` echo evidence for the reconciler | **P12**, wrapped by P21's dispatcher |
| `contacts.last_inbound_at`, `instance_recipient_contacts.first_inbound_at` | **P21** |
| Counted shed path, `inbound_dead_letters` (table + metric) | **P21** |

## What moved to v2 (V2-P3)
`chats`; the monthly-partitioned `messages` table and message bodies; FTS and search; `media_assets` and the whole media pipeline; `whatsapp_instances.capture_media` and `capture_groups`; `chats.unread_count` and the `chat.updated` outbox event; `packages/contracts/src/app/inbox.ts`; the dead-letter replay route and panel chip; outbound `messages` rows in a thread; per-conversation and per-user unread state; `message_wa_ids (direction='in')` rows and the use of the `inbox_message_id` / `inbox_message_created_at` columns (the columns stay in v1, unused).

## Where the design lives
Nothing was lost by deleting the steps — the canon holds the design:
- `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` → the *Inbox* and *Conversations and messages* sections (**read the correction note at the top of *Inbox* first** — most of that section is v2)
- `.memory/research/2026-08-26-inbox-to-v2-split.md` → what split, why, and the honest memory delta
- `plan/v2/README.md` → the V2-P3 entry

The v2 phase file will be written just in time, when v2 starts. Pre-writing it now would guarantee a stale file.
