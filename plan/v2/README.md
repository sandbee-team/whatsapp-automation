# v2 outline (deferred — nothing here may be built inside a v1 phase)

Source: ADR 0016, **amended 2026-08-26 by ADR 0017** (broadcast, group messaging, inbox and the wallet moved
into v1). This file is an outline only: one line per phase, no steps, no tests, no file paths. It exists so
nothing "temporarily" leaks into v1.

v2 opens only after v1's numbers are real — that is, after `P26 scale-proof-1k` (Gate B). Which v2 phase
opens first is decided by what P26 measures: scale hardening if the measured per-session cost is worse than
the pessimistic bracket, breadth if it is not.

| id | phase | one line | changed by the v1 re-scope? |
|---|---|---|---|
| V2-P1 | Meta Cloud API / BSP adapter | A second `ProviderAdapter` under `provider/meta/` (Tech Provider or 360dialog/Gupshup), `LinkChallenge {type:'redirect'}` embedded signup, templates re-entering `job_kind`, per-provider capability gating. Queue, pacing, health FSM, UI and DB untouched. | no |
| V2-P2 | Billing and entitlements | Subscriptions, invoices, payment gateway (Razorpay/Stripe), dunning, plan changes and proration. | **yes — loses the wallet, the ledger, pricing and usage metering (now v1, ADR 0019). Manual UPI/bank top-up with staff approval is v1; the gateway is here.** |
| ~~V2-P3~~ | The inbox (product) and team-inbox depth | **The inbox product itself: inbound message bodies, `chats` + the partitioned `messages` table, FTS/search, `media_assets` and the media pipeline, `capture_media` / `capture_groups`, the conversation thread UI, the reply composer, outbound rows in the thread, per-conversation and per-user unread, and the dead-letter replay route + panel chip.** Then team depth on top: assignment and ownership, SLA/first-response timers, private notes, collision detection, canned replies, outbound presence/typing, bulk chat actions, opt-in bounded history backfill, group **management** actions (create/add/remove/promote) behind warm-up and band gates. | **yes — the inbox product returned to v2 on 2026-08-26 (founder decision, ADR 0021). v1 keeps only a headless inbound listener: delivery receipts, opt-out detection, `fromMe` echo evidence and two contact timestamps. v1 phase P22 is retired; its number is not reused. Basic group send/receive stays in v1 (P24).** | **REMOVED 2026-09-11 (ADR 0051): the inbox product and team-inbox depth are not part of v2; only the group-management actions (create/add/remove/promote behind warm-up and band gates) remain as outline material for a later row.**
| V2-P4 | Campaign and automation suite | Saved segments with a filter DSL, drip/automation rules, A/B variants (with the duplicate fan-out guard integrated). | **yes — loses basic broadcast (audience snapshot, expansion, pause/cancel, funnel and pre-flight are v1) and loses templates + scheduling, both pulled forward into P35 by ADR 0052 §10.** |
| V2-P5 | Public API, webhooks v2, integrations | Published OpenAPI, per-key rate plans, event replay, Zapier/n8n/Make, CRM connectors. | no |
| V2-P6 | Reliability and scale hardening | Whatever `P27 scale-path-10k` did not finish: further Redis sharding, Parquet archival of dropped partitions, session-worker/send-worker split at fleet scale, per-session memory reduction, the Go/Rust session-host evaluation, and a connection-plane split if zero-impact deploys become a requirement. | **partly — Redis Sentinel/replica, the read replica and the first worker split move into v1 (ADR 0018 thresholds).** |
| V2-P7 | Compliance and enterprise security | OpenBao/Vault or cloud KMS behind the existing `KeyProvider`, pgaudit, SSO/SAML, passkeys, SOC 2 readiness, automated DSAR, data-residency options. | no |
| V2-P8 | AI-assist | **Deferred, not planned.** Only if the founder asks; ADR 0011 stays deferred and its bounded-business-process gate applies if it ever returns. | no |

Permanent non-goals, in v1 and v2 alike (safety-compliance skill, ADR 0013): automatic number rotation,
failover to another number after a pause, proxy pools or connection masking, device-fingerprint or identity
spoofing, any mechanism whose purpose is to evade detection or a restriction, auto-resume after a
restriction without an explicit human action, and client-settable pacing bypass flags.

## Phase files (v2) - cut just in time (ADR 0043)

| id | phase | status | dep | size | demo | maps to |
|---|---|---|---|---|---|---|
| P30 | `plans-versions-and-entitlements` | todo (blocked: founder approval of ADR 0050) | P28, P19, P29a | M | a client stays pinned to its plan version's price after a new version is published; signup credits and prices exactly from the assigned plan version; a published plan version cannot be re-priced by `wp_app` | V2-P2 (billing/entitlements slice pulled forward) |
| P30a | `plans-admin-routes-and-panels` | todo (blocked: founder approval of ADR 0050) | P30 | S | staff create, publish and set-default a plan and assign a client to a version through the audited admin panel; the tenant sees a read-only plan/usage page; the retention legal copy exists as an approved-pending draft | V2-P2 (billing/entitlements slice pulled forward) |
| P31 | `inbox-schema-and-inbound-capture` (**RETIRED**, file `P3x-RETIRED-*.md`) | retired (founder 2026-09-11, ADR 0051: no inbox in v2, no real-chat surface) | P21, P23a, P30a | M | a real inbound message lands as one `chats` row + one `messages` row with its gate row, under `SET LOCAL ROLE wp_scheduler`; a duplicate event writes nothing extra; zero bodies in logs | V2-P3 (write path) |
| P32 | `inbox-read-api-realtime-and-thread-ui` (**RETIRED**, file `P3x-RETIRED-*.md`) | retired (founder 2026-09-11, ADR 0051: no inbox in v2, no real-chat surface) | P31 | M | a real inbound message appears in the panel thread within seconds over SSE, with an unread badge that clears on read | V2-P3 (read path) |
| P33 | `inbox-reply-path-and-outbound-row` (**RETIRED**, file `P3x-RETIRED-*.md`) | retired (founder 2026-09-11, ADR 0051: no inbox in v2, no real-chat surface) | P32 | M | a reply typed in the panel becomes a durable job obeying the instance's configured window/cap/gap/opt-out/wallet, shown `queued` in the thread and ticking only at `sent` | V2-P3 (reply path) |
| P34 | `message-kinds-and-media-pipeline` | todo (blocked: founder approval of ADR 0052; P30a done) | P30a, P20, P23, P23a | M | a closed per-kind payload (text/image/video/audio/document), a tenant-scoped media upload pipeline, and an exhaustive transport switch so a media kind can never silently send as text | new (ADR 0052) |
| P35 | `templates-personalisation-scheduling-and-resend` | todo (blocked: founder approval of ADR 0052; P30a done) | P34, P30a | M | saved message templates, per-campaign default variable values, server-side single-send personalisation, two additive plan entitlements (`media_messages` already landed in P34), cron-promoted scheduling, a charged test-send, resend-to-failed as a new campaign | new (ADR 0052) — pulls forward two named V2-P4 items (templates, scheduling) |
| P36 | `the-simple-composer` | todo (blocked: founder approval of ADR 0052; P30a done) | P35, P30a | M | one shared composer for single-send and broadcast, a corrected `BROADCAST_DISCLOSURE`, the collapsed 3-section single-page composer, resend/export on the detail view | new (ADR 0052) |

**P34, P35 and P36 are cut in full** (ADR 0052, messaging depth and the simple broadcast — message-type parity with the founder's reference repos, media, personalisation, a simple broadcast composer); P31-P33 are retired and their numbers are never reused. The remaining ADR 0052 material is outline-only for now (`plan/README.md` folder rules — the next 3 phases in full, the rest as rows):

| id | one line |
|---|---|
| P37 | `voice-notes-and-video-polish` — polish only (founder ruled 2026-09-14, ADR 0052 Q2: all five kinds ship in P34/P35 now); opens only after real usage asks for more |
| P38 | `location-and-contact-card` — on a customer ask; one transport arm + one composer control each |
