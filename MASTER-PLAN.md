# WP - Master Plan v1 / v2 (2026-08-26)

**Status:** DRAFT for founder review. ADRs 0013-0016 and the updated 0002 are *proposed* and need your confirmation before V1-P0 starts. No application code exists yet.

**What this is:** the single phase-wise plan for the whole product, split into **v1** (prove the engine, then surface it) and **v2** (breadth). v1 order is fixed by you: signup/login -> onboarding -> WhatsApp QR login -> send messages -> scale proof, and then the admin panel, and then the marketing website.

**Direction (2026-08-25):** no Meta official API - v1 runs on a QR / linked-device engine (Baileys) behind a transport boundary so a Cloud API adapter can drop in later; no AI features; Node.js + TypeScript backend with React frontends; separate frontend and backend projects per surface sharing one database and one set of conventions; Safe Mode on by default.

**How it was produced:** 18 verified web-research dimensions -> deep review of two reference projects (Blastup, evolution-api) -> 4 architecture designs -> 3 adversarial critics -> the v1 blueprint (`.memory/research/2026-08-25-v1-architecture-blueprint.md`, the canon) -> ADRs -> these 11 sections.

**Two things this plan will not do:** it will not promise that Safe Mode prevents WhatsApp restrictions (it reduces risk from sending too fast or too cold; bans also come from recipient reports, content and account reputation), and it will not quote a capacity or price number as measured until V1-P8 measures it. Every capacity figure below is derived.

**Hard constraints:** this project is never linked to git or any VCS (ADR 0003) - deploys, reviews and CMS editing are all designed git-less; the plan.html invariants hold (durable-first, fail-safe pause, storage-level idempotency, tenant isolation, pause preserves work, no evasion mechanisms, honest claims).

## Table of contents

- 0. Overview: what we are building, the v1/v2 split, and how to read this plan
- 1. What we learned from Blastup and evolution-api
- 2. Architecture: engine, queue, and the common code base
- 3. Safe Mode: pacing, warm-up and account health
- 4. Data model, security and tenant isolation
- 5. The v1 product panel: modules, screens and flows
- 6. v1 delivery plan - Part A (V1-P0 - Foundations, guardrails and local CI to V1-P5 - Safe Mode: pacing ledger, warm-up, content guards, opt-out registry)
- 7. v1 delivery plan - Part B (V1-P6 - Health, signals, pause/resume and notifications to V1-P10 - Marketing website (Next.js))
- 8. Admin panel and marketing website (end of v1)
- 9. v2 scope: everything deferred, in order
- 10. Quality strategy, risks, open questions and next steps

Sections 6 and 7 are the executable phase plan; sections 2-5 are the reference they point to. Total: 65517 words.


---

# 0. Overview: what we are building, the v1/v2 split, and how to read this plan

WP is reliable WhatsApp messaging infrastructure for multi-tenant senders. A tenant links their own WhatsApp number, hands us messages, and we deliver them under per-account pacing, durable queueing and honest health reporting. The API never sends: every send begins life as a durable row in PostgreSQL, is claimed exactly once by the single worker that owns that account's socket, is granted a send unit by one atomic pacing statement, and produces an auditable outcome. When anything is unclear — a dropped socket, an ambiguous send, a restriction signal — the system pauses and preserves work rather than retrying blindly. That is the whole product thesis: **controlled, reliable delivery with an operator's view of the truth**, not "instant bulk sending".

v1 proves that thesis on a QR / linked-device engine (Baileys), on the tenant's own number, with no Meta Cloud API and no AI. It ships in eleven phases: guardrails, schema, identity, session engine, durable queue, Safe Mode, health, observability, a measured scale proof, then the admin panel, then the marketing website. v2 adds breadth — a Meta Cloud API adapter, billing, inbox depth, campaigns, public API — only after v1's numbers are real.

## What changed on 2026-08-25, and what it costs us

The founder replaced the Meta Cloud API plan with a QR / linked-device engine (ADR 0013 supersedes 0004), removed AI from both releases (ADR 0011 stays deferred), and fixed the release order (ADR 0016). The trade is not free, and stating it precisely is the point of this table (`2026-08-25-v1-architecture-blueprint.md`).

| Dimension | Meta Cloud API plan (dead) | v1 as built |
|---|---|---|
| Connection | Cloud API + Embedded Signup; Meta bills the tenant | QR or 8-char pairing code; the tenant's number becomes a linked device |
| Time to first send | Business verification, days | QR scan in about 60 seconds |
| Per-message cost | Meta conversation/message pricing | zero provider fee; our cost is infrastructure only |
| Ban risk | Meta policy engine, appealable, quality rating exposed via API | unappealable restriction on the tenant's **real** number; no reputation API — we infer signals |
| Health inputs | quality rating, messaging tier, 130429 throughput errors | `DisconnectReason` codes, send-failure classes, delivery/read ratios, opt-out rate (12 signals, section 6) |
| Templates | required for business-initiated messages | unavailable; `template` is not in the v1 job-kind enum |
| Server state | none (stateless HTTPS) | roughly 35 MB of live socket state per connected session — this **is** the capacity problem (section 9) |
| Terms-of-service standing | sanctioned integration | linked-device automation is not a sanctioned WhatsApp integration; the tenant carries that risk knowingly |

What it buys: zero marginal message cost, 60-second onboarding, no gatekeeper, and a product we can ship without Meta's approval queue. What it costs: server-side session state (the entire scale story), no templates, and a ban risk that lands on a real number with no appeal path. What survives from the Meta work unchanged: the durable queue, fairness scheduling, retry matrix, health FSM, tenant-isolation model, design system, infra topology and the no-git deploy path. The `MessageTransport` / `ChannelLink` boundary survives too, which is exactly why v2's Cloud API adapter is an addition rather than a rewrite.

## Positioning and the claims we may make

WP's wedge is operational transparency: no reviewed competitor shows queue depth, pacing state and real send rate to the end user (`2026-08-25-competitor-feature-matrix-wa-saas.md`). We sell that, plus durability. We do not sell speed, and we never sell safety from bans.

### The Safe Mode disclaimer, verbatim and non-negotiable

Exported once as `SAFE_MODE_DISCLAIMER` from `@wp/domain`, used verbatim in the panel, docs, ToS and website:

> "Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control."

`scripts/check-copy.ts` asserts that every user-facing surface string containing "Safe Mode" ships alongside this disclaimer. A surface that mentions Safe Mode without it is a red build, not a copy review comment.

### Forbidden claims

One `BANNED_CLAIMS` array in `@wp/domain`, scanned across the whole repo except `demo/` and `.memory/`, in English and Hindi/Hinglish (`2026-08-25-v1-design-repo-structure.md`, blueprint enforcement table).

| Never write | Why it is a lie |
|---|---|
| "ban-proof", "ban nahi hoga", "block nahi hoga", "100% safe" | recipient reports and content dominate ban causes; sender-side pacing cannot touch them |
| "won't get blocked", "avoid ban", "bypass restrictions" | describes evasion, which we do not build (safety-compliance skill) |
| "instant bulk sending", "blast 50,000 messages now" | contradicts pacing; also the exact promise that gets tenants restricted |
| "guaranteed delivery" | delivery depends on the provider, the recipient and the network |
| "zero gaps", "0 issues", "unhackable" | no one can honestly promise this; see section 8 for what we do promise |
| any capacity or price number before phase V1-P8 | every capacity figure in this plan is derived, not measured (ADR 0016) |

### The ban-risk posture, in plain language

WP connects as a linked device to the tenant's own WhatsApp account. If WhatsApp restricts that account, the restriction lands on **their** number, there is no appeal path we control, and no reputation API tells us why. We reduce sender-side risk: per-account daily/hourly caps, jittered minimum gaps, sending windows, a 30-day warm-up ramp, cold-outreach ratio caps, per-recipient frequency limits, duplicate fan-out guards, blocked-word and link-in-first-message guards, and a hashed opt-out registry enforced at three points (section 5). We read real signals and tighten or pause (section 6). We never rotate numbers, never fail over to a second number, never use proxies or fingerprint spoofing, and never auto-resume after a restriction — resuming a restricted instance requires an authenticated human user plus an acknowledgement checkbox.

Six statements go into onboarding and the ToS verbatim (`2026-08-25-v1-design-data-and-security.md`): the account and its standing are yours; WhatsApp may restrict any account and our pacing cannot prevent it; you are responsible for having permission to message every recipient and you attest to it on import; on a restriction signal we stop, keep your queued messages and tell you, and we will not resume automatically, switch numbers or work around it; WP is a linked device so our servers process your message content in the clear; retention defaults are stated and export/deletion are self-service.

## Goals and non-goals for v1

**Goals.** (1) A tenant signs up, verifies, completes onboarding, scans a QR and sends real messages from a real number. (2) Every send is durable, claimed once, paced by one authority, and never silently lost or duplicated. (3) Every state change is visible: health band, queue depth, oldest queued age, next send countdown, why a send is waiting. (4) Tenant isolation is proven by tests that go red when a new table forgets `client_id`. (5) Session credentials are envelope-encrypted at rest. (6) A measured answer to "how many accounts fit on how many boxes". (7) Then an admin panel. (8) Then a marketing site.

**Non-goals for v1.** Billing, wallet, invoices. Meta Cloud API. Templates. Team inbox depth (assignment, canned replies, presence). Automation, drip and chatbots. Public API v2, Zapier/CRM integrations. Redis high availability. AI, in any form. Anything whose only justification is v2 (ADR 0016). The honest consequence: **v1 is not sellable to most customers as-is** — it is a technical proof plus a usable panel.

## Who uses WP, and what they hire it for

| Persona | Job to be done in v1 | What v1 gives them |
|---|---|---|
| SMB owner / founder (India, 5-50 staff) | "Send offers without losing my number"; "know whether it is actually working" | Safe Mode on by default with a plain-language health card, one-click pause, queue depth and oldest-queued age |
| Marketing manager | "Send to my list without getting flagged"; "see sent / delivered / failed with reasons" | warm-up tiers, cold-ratio and duplicate fan-out guards, failure breakdown by error class, per-instance pause |
| Agency operator (5-30 client numbers) | "Keep clients isolated"; "see every number's health at a glance" | per-instance queue, pacing, health and metrics; `instance_grants` per membership |
| Developer / integrator | "Send from my backend idempotently"; "receive delivery events reliably" | `POST /v1/messages` with a mandatory `Idempotency-Key`, signed SSRF-guarded webhooks, oRPC/Zod contracts |
| WP operator (us) | "Know before the customer does"; "support a tenant without touching the database" | metrics and alerts (section 9), the runbook, and from V1-P9 an admin panel that cannot write the send path |

Support-agent inbox work and campaign-suite work are deliberately v2 (V2-P3, V2-P4).

## Success criteria for v1

**Functional.** The Playwright end-to-end `signup → onboarding → QR → send` passes. Mandatory suites pass verbatim: send-path and engine tests 1-23, the amended Safe Mode suite, isolation suites A/B/C, the role-grant snapshot, real-429 rate-limit tests, the SSRF hostile-URL table, the log-grep PII test, `no_forbidden_mechanism_exists`, and `copy_contains_no_banned_claims`. Chaos: 100 worker kills between dispatch and result produce zero lost jobs and zero silent duplicates; a pause mid-batch of 5,000 produces zero lost, zero failed, zero duplicated.

**Scale, stated honestly.** The founder asked whether about 1,000 accounts fit on one or two small boxes. **Derived answer: 1,000 concurrently connected sessions do not.** At ~35 MB per session that is ~35 GB for sockets alone, plus worker overhead, plus 2-5 GB of Redis and Postgres — roughly **45-50 GB RAM and 10-12 dedicated vCPU: two 8 vCPU / 32 GB worker boxes plus a third 8/32 for Postgres and Redis, about USD 400-560 per month**. If a session actually costs 60-80 MB — plausible for accounts with large contact sets, because the signal-key working set scales with distinct contacts — the fleet and the cost roughly double. The escape hatch that makes a small fleet real is that not every account must be connected: **1,000 registered accounts at a realistic 30% concurrency is about 300 connected, about 11 GB**, which genuinely fits one 8 vCPU / 32 GB box. Two caveats we disclose rather than bury: a parked linked device receives nothing while offline (it syncs on reconnect, and WhatsApp's offline buffer is neither unlimited nor documented), and cycling accounts hourly to save RAM is not something we build. **"1,000 registered" and "1,000 connected simultaneously" are different products at different prices**, and this plan must say which one v1 sells (open question 1, section 10).

**Every number in the previous paragraph is DERIVED, not measured.** Nothing has been benchmarked. The v1 measurement target is **150 sessions on one 4 vCPU / 16 GB box**, extrapolated only after V1-P8 runs synthetic, real-account and chaos phases. V1-P8's gate is zero cap violations, zero lost jobs, zero unexplained `blocked_needs_review`, p99 pacing `reserve()` under 25 ms, and a published capacity table. **No capacity figure and no price may be quoted to any customer before V1-P8 completes** (ADR 0016).

## Hard constraints

1. **No git, no VCS, ever** (ADR 0003). No `git`, no `gh`, no GitHub Actions, no git-push deploy. Versioning is `VERSION` + `CHANGELOG.md` + `scripts/snapshot.ps1`; deployment is `docker save` → rsync → `docker load` → migrate → rolling restart.
2. **The founder's folder layout is binding** (ADR 0014): `app/{frontend,backend}`, `admin/{frontend,backend}`, `website/`, plus `packages/` and one `db/`. The database is shared; `app/backend` alone owns the send path and DDL; `admin/backend` reads through a registry and mutates only via `/internal/v1`. Shared code lives in `packages/`, never copy-paste.
3. **The security bar.** Envelope-encrypted session credentials with purpose-separated KEKs, four isolation layers with self-extending test suites, hashed revocable sessions, tested rate limiting, no PII or secrets in logs, SSRF-guarded webhooks, fail-closed everywhere. Answered honestly: "0 gap, 0 issue" is not a promise anyone can make (section 8).
4. **Low-config-first.** Safe Mode is ON with no tenant off-switch; tenants may only tighten. Sensible defaults over knobs: a knob that can loosen a limit is a bypass, and we do not ship one.
5. **No provider-evasion mechanisms, ever.** Number rotation, failover-to-another-number, proxy pools, fingerprint spoofing, auto-resume and client-settable pacing bypasses are absent by interface design and blocked by a CI token ban.

## v1 phases

| Phase | Goal in one line |
|---|---|
| V1-P0 - Foundations, guardrails and local CI | the repo shape and every mechanical guard exist before feature code |
| V1-P1 - Data model, migrations and tenant isolation proof | schema, RLS, roles and isolation suites exist before any tenant data can arrive |
| V1-P2 - Identity, onboarding and the panel shell | a real user signs up, verifies, completes onboarding and sees an honest empty dashboard |
| V1-P3 - Baileys session engine: lease, fence, encrypted auth state, QR linking | a scanned number stays connected across crashes and deploys with no plaintext credential anywhere |
| V1-P4 - Durable queue: claim, attempts, reaper, reconciler | every send is a durable row claimed exactly once; a crash never silently duplicates or loses a message |
| V1-P5 - Safe Mode: pacing ledger, warm-up, content guards, opt-out registry | one atomic pacing authority a tenant cannot loosen; a cap defers work instead of failing it |
| V1-P6 - Health, signals, pause/resume and notifications | real signals tighten or pause an instance; only a human restarts sending |
| V1-P7 - Realtime, observability and the operator runbook | the panel tells the truth in real time and an operator can diagnose the fleet without SSH |
| V1-P8 - Scale proof: synthetic and real-account measurement | replace every derived capacity number with a measured one; unblocks all pricing and capacity claims |
| V1-P9 - Admin panel (admin/frontend + admin/backend) | staff can see, suspend and support without ever writing the send path directly |
| V1-P10 - Marketing website (Next.js) | a fast, honest, high-craft site that never over-claims |

## v2 phases

| Phase | Goal in one line |
|---|---|
| V2-P1 - Meta Cloud API / BSP adapter | a second transport behind the v1 boundary; templates re-enter the job-kind enum |
| V2-P2 - Billing, wallet and entitlements | subscriptions, invoices, payments, append-only wallet ledger, dunning |
| V2-P3 - Team inbox depth | groups, media at scale, assignment, notes, canned replies, presence |
| V2-P4 - Campaign & automation suite | templates, segments, scheduling, drip rules, A/B variants |
| V2-P5 - Public API, webhooks v2 and integrations | published OpenAPI, per-key rate plans, event replay, Zapier/n8n/CRM |
| V2-P6 - Reliability and scale hardening | Redis Sentinel (removing the v1 SPOF), read replica, worker split, per-session memory reduction |
| V2-P7 - Compliance and enterprise security | Vault/KMS behind the existing `KeyProvider`, pgaudit, SSO, passkeys, SOC 2 readiness |
| V2-P8 - AI-assist (deferred, not planned) | only if the founder asks; ADR 0011 stays deferred |

## How to read this plan

| Section | What it answers |
|---|---|
| 0 | this overview: scope, claims, ban posture, success criteria, constraints, the phase lists, glossary |
| 1 | what the two reference projects (Blastup, evolution-api) actually do, the honest verdict on the "won't get blocked" claim, and what we borrow versus never build |
| 2 | architecture: the Baileys session engine (lease, fence, encrypted auth state, reconnection), the durable queue and its canonical claim, the transport boundary, realtime, capacity - and the common code base: the four-project folder tree, shared packages, layering and the guards that enforce them |
| 3 | Safe Mode: the pacing ledger and its single grant statement, warm-up ladder, the 12 health signals and bands, content guards, opt-out registry, panel copy, and what Safe Mode cannot do |
| 4 | the data model (tables, partitioning, uniqueness authorities, the claim SQL) and security: the four tenant-isolation layers, envelope encryption, auth, hardening, the threat model, and an honest answer to "0 gap, 0 issue" |
| 5 | the v1 product panel: every module, screen, state and flow, with the MVP-versus-deferred line for each |
| 6 | **v1 delivery plan Part A** - V1-P0 to V1-P5, work package by work package with tests, migrations and exit criteria |
| 7 | **v1 delivery plan Part B** - V1-P6 to V1-P10, including the scale-proof soak test that answers the accounts-per-box question, and the release checklist |
| 8 | the admin panel and the marketing website as products: modules, IA, animation plan, lead capture, launch checklist |
| 9 | v2 scope: every deferred phase, its trigger, and what v1 must not compromise to keep it cheap |
| 10 | testing policy, the risk register, the open questions you need to answer, and the immediate next steps |

Read sections in order for the rationale; jump to 2, 3 and 4 for the invariants that any change must not break, and to 6 and 7 to start building.

## Glossary

| Term | Meaning in this plan |
|---|---|
| **Tenant** / client | one customer account; the unit of isolation. `client_id` is the first column of every tenant table and every tenant index |
| **Instance** | one WhatsApp number belonging to a tenant, with its own queue, pacing state, health state, worker claim scope and pause switch |
| **Session** | the live Baileys socket plus auth state for an instance; costs roughly 35 MB RSS while connected (derived) |
| **JID** | WhatsApp's addressing identifier for a user or group; normalised before any comparison, never written to a log |
| **QR pairing** | linking flow where the tenant scans a QR (or types an 8-char pairing code) in WhatsApp; bounded to 5 attempts per 5-minute window, then a terminal `pairing_expired` state |
| **Linked device** | WhatsApp's multi-device companion; WP is one of the tenant's linked devices, which is why WP sees message content in the clear |
| **Lease** | Redis mutual-exclusion key granting one worker the right to own a session (TTL 30s, heartbeat 10s, takeover grace 15s). Redis is rebuildable |
| **Fence** | a monotonically increasing integer **minted in Postgres** on lease acquisition and asserted in every state-write predicate, so a stale owner writes zero rows even if Redis is flushed |
| **Durable job** | a `message_jobs` row created before any send is attempted; invariant 1 says no send exists without one |
| **Claim** | the single canonical SQL statement that moves a job from `queued` to `processing`, carrying fence, health, session-epoch, client-status and plan predicates inside the UPDATE |
| **Safe Mode** | the user-facing name of the pacing module: caps, jittered gaps, sending windows, warm-up, cold-ratio limits, content guards and opt-out enforcement, always shipped with its disclaimer |
| **Warm-up tier** | one of six time- and health-gated steps over about 30 days (day 1 ≈ 20 messages, steady 600-1,000/day with a 2,000 hard ceiling); never reply-rate-gated, never skippable by payment |
| **Health band** | HEALTHY / WATCH / DEGRADED / CRITICAL, derived from a 0-100 score over 12 signals; tightening is immediate, loosening is hysteretic; CRITICAL pauses the instance |
| **Pacing ledger** | the Postgres counter table that is the **only** grantor of a send unit; Redis pacing state is advisory and can only deny |
| **Opt-out registry** | hashed (HMAC) per-client list of recipients who asked to stop; enforced at API creation, at claim-time and pre-send; matched jobs are `cancelled`, never `failed`, and excluded from every health denominator |


---

# 1. What we learned from Blastup and evolution-api

Before writing a line of WP code we read two working QR/Baileys products end to end: **Blastup** (Node + MongoDB, a single-tenant WhatsApp panel with a "Safe Mode" ban-avoidance module) and **evolution-api** (Node + PostgreSQL/Prisma, the widely self-hosted multi-instance WhatsApp API, plus its React manager UI). Seven code-level reviews with file:line citations came out of that pass: `2026-08-25-ref-review-baileys-engine.md`, `-blastup-safemode-claim.md`, `-multiaccount-scale.md`, `-data-model.md`, `-security-blastup.md`, `-security-evolution.md`, `-evolution-ui.md`, synthesised in `2026-08-25-ref-review-SUMMARY-blastup-vs-evolution.md`.

The headline: **neither repo is a copy source.** evolution-api has the better structural bones (relational schema, DB-backed auth state, a pluggable session store, a bounded QR flow); Blastup has a few clean local ideas (per-message try/catch, self-expiring Redis counters, hashed revocable login sessions). Both are request-driven single-process wrappers that break WP's durable-first and tenant-isolation invariants at the core, both store the tenant's live WhatsApp credentials in plaintext, and evolution-api ships an outright evasion mechanism — rotating public proxies — that WP will never build at any layer. We take patterns; we build the durable, leased, tenant-scoped layer neither of them has.

## How each system works

| Dimension | Blastup | evolution-api | What WP does |
|---|---|---|---|
| Engine | Baileys, QR only, 60s expiry gate | Baileys, QR **and** pairing code, bounded QR-refresh with a terminal state | Baileys behind a `MessageTransport`/`ChannelLink` boundary; QR + pairing code, 5 attempts / 5 min, terminal `pairing_expired` and a manual regenerate button |
| Send path | API → `sock.sendMessage` inline, DB write **after** the provider call (`message.service.ts:46-115`) | API → `client.sendMessage` inline (`whatsapp.baileys.service.ts:2629-2649`) | API → durable `message_jobs` row → scheduler → leased worker → transport. The API cannot open a socket (lint-enforced) |
| Multi-account | `sockets = new Map` in one process (`whatsapp.service.ts:36`) plus five companion maps | `waInstances: Record` on a singleton (`monitor.service.ts:40,307`) | Redis lease + Postgres-minted fence per instance across a stateless worker fleet |
| Auth state | plaintext JSON files on local disk (`:141`) | `Session.creds` plaintext column + plaintext Redis blobs (`use-multi-file-auth-state-prisma.ts:28-56,91-129`) | Creds/pre-keys/app-state keys in Postgres, high-churn signal keys in Redis, **all envelope-encrypted** |
| Reconnect | flat 2s, no jitter, no stagger, cap 5, then silently stops (`:902-909`) | recursive `connectToWhatsapp()` inside the close handler, zero delay, no cap (`:430-431`) | exponential backoff + full jitter + per-instance stagger, cap 8, exhaustion ⇒ `paused` + `needs_user_action` + audit + notification |
| Restriction handling | only `loggedOut` special-cased | `loggedOut`/`forbidden`/402/406 → no reconnect (`:428`) — the one genuinely good fail-safe | full disconnect map; 401/402/403/406/411/440/500 never auto-reconnect; jobs preserved; resume needs a human |
| Pacing | "Safe Mode" tiers, non-atomic, throws mid-send | none | Postgres `pacing_ledger` as sole grantor; Redis advisory pre-filter can only deny; over-cap leaves the job **queued** |
| Proxy rotation | none (full-repo grep confirms) | rotating proxyscrape pool, `Math.random()` per connection, in the WS + fetch agents (`:604-636`) + a `Proxy` table | **never, in any form** |
| Tenant model | 1 user = 1 tenant = 1 instance; `req.user.id` reused as `instanceId` | one global API key; instance token doubles as resource id (`auth.guard.ts:19,33`) | distinct `clients`/`whatsapp_instances`; four isolation layers |
| Rate limiting | present but disabled by `skip:()=>true` (`rateLimit.ts:7,25,43,51`) | none anywhere in `src` | real, per client_id/IP, tests assert a genuine 429 under load |
| Data growth | `Message`/`CampaignLog` unbounded | `Message` unbounded, raw payload stored forever | partitioned jobs/events/messages with retention from the first migration |

Two structural facts explain most of the table. **Neither repo has a durable outbound job table** — evolution-api has no queue at all; Blastup's `Campaign`/`CampaignLog` pair is written by a scheduler loop, not claimed atomically per recipient, so a crash mid-campaign loses or duplicates sends with no reconciliation path (`-data-model.md`). That layer is 100% new WP work and is why the plan sequences data model and queue before anything user-visible. And **neither repo can run more than one process**, because socket ownership lives in a JS `Map`: two processes would either both think they own an instance, or neither would.

## The "won't get blocked" claim — the honest verdict

Blastup markets `safemode/` as an "algorithm that avoids WhatsApp blocking". We read all eleven files plus call sites (`-blastup-safemode-claim.md`, confidence High). Verdict: **partially true, oversold in framing. The mechanisms are legitimate; the promise is not, and WP must never repeat it.**

| Mechanism | Where | Classification |
|---|---|---|
| Daily cap per tier (10 → 50 → 150 → 500 → unlimited) | `tiers.ts:14-54` | Legitimate volume ceiling. WP adopts it as a durable, atomic cap |
| Minimum inter-send gap (10s/5s/3s/2s/1s) | `tiers.ts:15-55` | Legitimate, but **fixed constants are themselves a mechanical pattern**. WP uses a jittered range |
| Sending window, UTC 09:00-21:00 | `tiers.ts:65-66` | Legitimate. WP makes it **local** per instance — a UTC window is the wrong window for India |
| New-conversation-per-day cap | `tiers.ts:16-56` | Legitimate; cold-outreach velocity is a real abuse signal |
| Link-in-first-message block | `tiers.ts:72-73`, `SafeModeManager.ts:176-184` | Legitimate content guard, surfaced as a warning, never a promise |
| Group-action block for immature accounts | `tiers.ts:18-38` | Legitimate conservatism |
| Time + reply-rate gated tier advance | `SafeModeManager.ts:220-240` | Shape fine; **reply rate as a hard gate is not** — it is recipient-controlled and can trap an account at tier 1 forever. WP gates warm-up on elapsed time and health band |
| Fail-closed on cap: mark pending, break loop, no retry storm | `campaign.service.ts:249-268` | Correct, and the closest thing in either repo to "pause preserves work". Adopted |
| Self-expiring counters (`INCR` + `EXPIREAT`) | `RedisSafeModeStore.ts:73-96` | Clean, no cron. Adopted for advisory state only, never as grantor |
| Preseeding known chats on reconnect | `recordKnownChatsFromStore.ts:36-46` | Legitimate bookkeeping so an old number isn't treated as cold |

**Why the framing is oversold.** The module has zero visibility into the signals that actually drive bans: recipient block/report rates, WhatsApp's content classifiers, device/IP/account-trust reputation, policy enforcement. It never reads a disconnect reason, a restriction signal, or a delivery receipt — it is a pre-emptive self-throttle and nothing else. Sender-side pacing can only reduce the volume/velocity/cold-outreach subset of risk, and even that reduction is unquantified: there is no published function from send rate to ban probability and nobody outside Meta can measure one.

Two engineering defects sit under the marketing. `checkAndRecord` reads `sentToday`/`newChatsToday`/`lastSentAt` at lines 137-173 and only increments at 187-196 — a **TOCTOU race** letting two concurrent sends both pass a cap only one should. And a violation is thrown as a synchronous `SafeModeError`, so a paced-out message looks at the call site exactly like a real send failure. WP inverts both: the grant is a single conditional `UPDATE` on `pacing_ledger` inside the claim transaction, and a denial leaves the job `queued` with `pacing_deny_reason` set, never `failed`. There is also a client-settable bypass — `content.__blastupSystemReply === true` skips **every** check (`wrapBaileysSocket.ts:32-35`); its uses today are legitimate auto-replies, but it is an unauthenticated payload boolean with no audit trail. WP's carve-out is a `SendOrigin` enum resolvable only inside `modules/pacing/internal/**`, enforced by a build guard; no DTO anywhere accepts `origin` from input.

**The module contains no evasion code.** A full-repo grep for `proxy`, `rotat`, `fingerprint`, `spoof` found no number rotation, no fingerprint or identity spoofing, no proxy rotation, and no auto-resume-after-ban anywhere in Blastup; the only `proxy` hit is Express `trust proxy`. This matters for reading the competitor honestly: **the code is clean on evasion grounds; the marketing overreaches.** WP closes that gap with one sentence used verbatim wherever "Safe Mode" appears:

> "Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control."

A repo-wide `check-copy` guard fails the build on any banned claim ("ban-proof", "won't get blocked", "100% safe", plus Hindi/Hinglish equivalents) and asserts the disclaimer ships with every Safe Mode surface string.

**The evasion that does exist is in the other repo.** evolution-api fetches a public proxy list from proxyscrape, picks one at random per connection, and wires it into both the WebSocket and fetch agents (`whatsapp.baileys.service.ts:604-636`), backed by a per-instance `Proxy` table with plaintext credentials (`postgresql-schema.prisma:255-267`) and a **Proxy settings page** in the manager UI (`-evolution-ui.md`). That is textbook connection-masking. WP builds no equivalent at any layer — no table, no config field, no page, no `setProxy` method. The transport interface is deliberately shaped so `rotateNumber`, `setProxy`, `forceResume` and `fingerprint` have nowhere to live, and a CI token ban makes reintroducing them a build failure rather than a code-review argument.

## The measured scale reality

`-multiaccount-scale.md` (High on architecture, Medium on numbers — nothing was benchmarked, execution is forbidden in this workspace) is blunt: **neither system is built for thousands of sessions.** Every live socket sits in one in-process structure inside one Node process. No `cluster.fork`, no shard assignment, no session affinity, no cross-process lock anywhere in either `src`. Realistic strain point: **a few hundred concurrently-connected sessions per 4 vCPU / 8-16 GB box.**

Three multipliers make it worse. (1) Blastup sets `syncFullHistory: true` (`:152`), pulling the device's entire chat history on every fresh pairing or relink and bulk-upserting it into Mongo with no batching — a memory spike, an unbounded write burst and a reconnect-storm amplifier, per instance. (2) Reconnection is a storm generator in both: Blastup's flat 2s with no jitter means N sockets that drop together reconnect together; evolution-api's zero-delay recursion has no cap. (3) Restart is a guaranteed cold start — creds survive, so no re-QR, but the socket map rebuilds empty and every instance reconnects at once on every deploy, unstaggered.

WP instead makes `syncFullHistory:false` and `markOnlineOnConnect:false` defaults rather than options, keeps no in-process message store (`getMessage` reads Postgres), bounds caches, evicts signal keys to Redis with a TTL, and meters connect storms with a per-worker bucket (2/s, burst 5) plus a fleet-wide Redis bucket (8/s, burst 20) and a permanent per-instance offset — a cold start of 1,000 sessions deliberately takes about two minutes. Workers grab leases up to `MAX_SESSIONS_PER_WORKER` (default 150) with no central assigner and no rebalance subsystem.

**The honest limit, because the founder asked for "1000s of accounts on 1-2 small boxes":** our per-session figure is ~35 MB RSS and it is **derived, not measured**. At 35 MB, 1,000 *concurrently connected* sessions is ~35 GB for sockets alone, plus 2-5 GB Redis for encrypted signal keys, plus Postgres — roughly 45-50 GB RAM and 10-12 dedicated vCPU: two 8 vCPU/32 GB worker boxes plus a third for Postgres+Redis, about USD 400-560/month. If a real campaign account costs 60-80 MB (plausible — the signal-key working set scales with distinct contacts) the fleet and cost roughly double. The lever that makes a small fleet real is `desired_state='offline'`: 1,000 **registered** accounts at ~30% concurrency is ~300 connected, ~11 GB, which genuinely fits one 8 vCPU/32 GB box — but a parked linked device receives nothing while offline, and cycling accounts hourly to save RAM is not something we build. "1,000 registered" and "1,000 connected at once" are different products at different prices, and the plan must say which one v1 sells. V1-P8 starts by measuring **150 sessions on one 4 vCPU / 16 GB box**; no capacity number and no price reaches a customer before it runs.

## The security failures, and WP's counter-design

Both repos fail the same fundamentals. WP's invariants already forbid every one, so this is enforcement, not new scope.

| Finding | Where | WP's counter-design |
|---|---|---|
| **Plaintext WhatsApp credentials** — a live unattended login to the tenant's real number | Blastup: raw `useMultiFileAuthState` files (`:141`). evolution-api: `Session.creds` plaintext column + plaintext Redis blobs | Envelope AES-256-GCM at the auth-state boundary; per-record DEK wrapped by a `session` KEK mounted only into workers; separate tables with separate GRANTs; AAD split by layer. **Highest-severity finding in both reviews** |
| **Rate limiting disabled by a skip-always toggle** — worse than absent, because it reviews as configured | Blastup `rateLimit.ts:7,25,43,51`; evolution-api has none at all | Real limits on every credential-bearing and resource-creating route, with tests asserting an actual 429. A permanent skip flag is a review-reject |
| **A real shipped cross-tenant leak on a background path** — `ChatbotKnowledge.find({status:'active'})` with no `instanceId` filter feeding one tenant's knowledge base into another tenant's live auto-replies; the correctly-scoped version exists elsewhere (`knowledge.controller.ts:141`) | Blastup `whatsapp.service.ts:778-780` | Four isolation layers plus three self-extending test suites, one of which runs **background/worker paths with two tenants loaded** — background paths are exactly where both repos leaked. Plus `check-tenant-scope.ts`: an unscoped query on a `client_id` table fails the build unless registered with role, reason and projected columns |
| **A single global API key authorising every instance**, credential doubling as resource id, raw `===` comparison, caller-suppliable low-entropy tokens | evolution-api `auth.guard.ts:19,33`, `instance.controller.ts:59-60` | Server-generated keys, **hash only** at rest, scoped to one `client_id`, hashed/constant-time lookup; hashed revocable user sessions with rotation and reuse detection |
| **Hardcoded default secret shipped in `env.example`** identical to the code fallback (`BQYHJGJHJ`) | evolution-api `env.config.ts:869`, `env.example:63` | Services fail closed and refuse to boot on a missing secret or schema-version mismatch; no literal fallbacks |
| **Raw API key stored in plaintext beside its own hash** | Blastup `ApiKey.ts:5,21-24` | Hash only, shown once at creation, never persisted reversibly |
| **Secrets and message content in logs** — full webhook payloads with message text, phone numbers and the tenant's own `apikey`, at default log level | evolution-api `webhook.controller.ts:93-123`; Blastup logs recipient phones (`campaign.service.ts:271,278`) | No phone numbers, JIDs, bodies or QR payloads in any log line, metric label or audit value — ids only, with an audit metadata allow-list and an end-to-end log-grep test |
| **SSRF guard commented out** on tenant-supplied webhook URLs; the emit-time check still accepts `http://169.254.169.254/…` | evolution-api `webhook.controller.ts:20-23,126` | https-only in production, DNS resolved with private/link-local/loopback/metadata ranges rejected, re-validated **on every dispatch** |
| **Fail-open identity fallback** `req.user?.id \|\| 'default'` in every controller; an empty match-all filter in `listApiKeys` | Blastup repo-wide (`apikey.controller.ts:50`) | Missing principal or scope ⇒ 401/500. Never a shared literal, never a widened filter |
| **Global open CORS + CSP disabled app-wide** for one embeddable widget; **unauthenticated static serving of tenant media** | Blastup `security.ts:15-45`, `app.ts:60-67` | Strict origin allowlist on the authenticated API (v1 ships no public widget); private object store served through authenticated tenant-scoped endpoints |
| **Unbounded message history, no retention or partitioning** | both repos | Partitioned `message_jobs` (monthly), `delivery_events` (weekly, 90-day retention), `messages` (monthly), with retention policies in the first migration |

Two correctness traps would be inherited by anyone porting code. evolution-api's `readData` **double-JSON-parses** the non-creds branch (`use-multi-file-auth-state-prisma.ts:107-129`) — already-parsed data re-parsed with `BufferJSON.reviver`, a latent throw; WP makes that unrepresentable with exactly one serialisation boundary in each direction, at the encryption boundary, guarded by a round-trip test on a real `initAuthCreds()` object. And evolution-api's own comment warns against self-minting message ids (`:2155`), so WP does not rely on caller-supplied Baileys ids for idempotency in v1 unless a spike proves WhatsApp deduplicates on them and echoes them back.

## What we borrow

1. **DB-backed pluggable auth state** (evolution-api's adapter shape: creds in Postgres, hot signal keys in Redis) — with encryption added at the boundary and the double-parse bug fixed. This is what makes workers stateless.
2. **Bounded QR/pairing attempts with an explicit terminal state** (`:336-362`) instead of an infinite QR loop.
3. **`forbidden`/402/406/`loggedOut` → never auto-reconnect** (`:428`), promoted into WP's full disconnect map and health FSM.
4. **Purging auth material on logout** (Blastup `:285-292`), plus `session_epoch++` so no queued job can be sent from a different number after a relink.
5. **Structured disconnect-reason fields on the instance row** as the "why" behind every health transition, shown in the panel and written to audit.
6. **Per-message try/catch in the inbound event loop** (Blastup `:402-408`) — one malformed message never kills the batch.
7. **Compound unique idempotency keys at the storage layer** and idempotent `ON CONFLICT DO UPDATE` upserts for inbound sync.
8. **1:1 per-instance config side tables**, an **append-only delivery-event log** with a real enum (evolution-api left it a free string), and **never `SELECT *`** on a table holding a secret or blob.
9. **The legitimate pacing rules** — daily cap, jittered min-gap, new-conversation cap, sending window, first-message-link guard, group conservatism, time-gated warm-up — reimplemented atomically and durably.
10. **Fail-closed-and-preserve on a self-imposed cap** (`campaign.service.ts:249-268`): stop cleanly, keep the job queued, never fail it, never retry-loop.
11. **Self-expiring Redis daily counters** for advisory state, and **preseeding known recipients** on reconnect so warm-up counters don't misfire on established numbers.
12. **Hashed revocable session rows over stateless JWT**, Zod validate-and-replace at every boundary, login lockout paired with (not instead of) real IP rate limiting.
13. **Webhook retry shape** — exponential backoff + jitter + non-retryable code list (400/401/403/404/422) — adopted only after SSRF and logging are fixed.

## What we never build

1. Proxy rotation, proxy pools, connection masking, or any per-instance egress-rotation config — no table, no field, no page, no interface method.
2. Device-fingerprint or identity spoofing of any kind.
3. Automatic number rotation, or failover to another number after a pause or restriction.
4. Auto-resume after a restriction: `paused → sending` always requires an authenticated human user, never an API key, never a system actor.
5. Client-settable pacing bypasses (Blastup's `__blastupSystemReply`) or any Safe Mode off-switch a tenant can reach — tenants may only tighten.
6. Silent background ratcheting of send limits dressed up as a compliance milestone.
7. Direct Baileys sends from a controller with no durable job row first.
8. Unbounded, zero-backoff or recursive reconnect; silent give-up with no "needs user action" state.
9. Non-atomic check-then-write pacing, or treating a pacing denial as a dropped or failed send.
10. A single global API key; a credential string as the tenant boundary; caller-chosen secrets; plaintext secrets at rest.
11. PII, message content, JIDs or secrets in logs; unauthenticated media serving; a `skip:()=>true` rate-limit toggle; open CORS on the authenticated API.
12. "Ban-proof", "won't get blocked", "100% safe" or any equivalent in product copy, docs, marketing or Hinglish — enforced by a build guard, not by good intentions.

## UI patterns worth taking from the evolution manager

Evolution Manager v2 (React 18 + Vite + Tailwind v4 + Radix behind an in-house design-system package, TanStack Query, socket.io, react-i18next) is a competent tool, not a premium product: uniform radii, default type stack, no keyboard layer, no virtualization, no team concepts, and shipped languages of en/es/fr/pt with **no Indic support at all** — a blocker for an India-first product (`-evolution-ui.md`). Take the interactions, rebuild the surface.

1. **Instance card with health status** — avatar, display name, technical name, colour-coded badge, meta counts, and an action row hidden at rest and revealed on hover. WP adds queue depth, oldest-queued age, last successful send, and warm-up tier.
2. **One tiny status-badge component** mapping a single enum to colour plus an i18n label — mapped to the real FSM (connected / degraded / paused / logged_out) plus a distinct "action required" treatment.
3. **Dual-path connect modal** — QR tab and pairing-code tab, polling every ~3s, self-closing on success. WP adds bounded attempts, a 45s ring and a terminal state with a manual regenerate button.
4. **Type-the-name-to-confirm** on destructive actions, extended to show the exact queued-job count that will be cancelled.
5. **Socket-into-query-cache merge** rather than refetch-on-every-event — hardened so the tenant-scoped channel carries **ids only** and the client refetches through the authorised API, making a cross-tenant leak over the live channel structurally impossible.
6. **Zod + react-hook-form + Radix settings recipe**, but sectioned (connection, Safe Mode/pacing, notifications, danger zone) from the start rather than one flat form.
7. **Responsive card grid, skeleton loaders, real empty states** — with richer empty and error states than theirs, each naming the next action.

What WP adds that this UI lacks: a command-palette/keyboard layer, virtualized lists, honest paused-state copy that says why and what the user must do, and a Safe Mode panel showing current caps, gaps and warm-up tier with the disclaimer attached — never framed as ban prevention. The Proxy page has no WP counterpart, by design.

## Confidence

Code-level facts here are **High** confidence: seven reviews with direct file:line citations against the pinned copies in `demo/`, read-only, nothing executed. Capacity figures are **Medium at best and derived, not measured** — neither reference repo was benchmarked and WP's own engine has never been run; the "few hundred per box" ceiling and our ~35 MB/session figure are engineering derivations that V1-P8 exists to replace. The UI review is High on stack facts, Medium on UX judgement (no instance was run, no user research exists).


---

# 2. Architecture: engine, queue, and the common code base

This section is the buildable form of the v1 architecture blueprint (`.memory/research/2026-08-25-v1-architecture-blueprint.md`). It fixes the components, the four end-to-end flows, the Baileys engine, the durable queue, the transport boundary, the capacity envelope, and the shared code layout that all four projects sit on. Where a number appears it is either a constant that lives in one file in code, or a derived estimate that is explicitly marked as unmeasured.

## 2.1 The system, component by component

One image per backend project. `ROLE=` selects the process. This is a modular monolith with process roles, not microservices: the API, the worker and the scheduler share the same repository layer, the same finite-state machines and the same config, and differ only in what they are allowed to do.

```
   browser (app SPA)  ---> app/backend ROLE=api  (Fastify 5 + oRPC)
   browser (admin SPA) --> admin/backend ROLE=api (read + S2S) --> /internal/v1 on app/backend
                                  |                                        ^
                                  | INSERT message_jobs (+refs, outbox, audit)
                                  v
                          +----------------+          +----------+
    scheduler (leader) -->|  PostgreSQL 17 |<-- relay |   SSE    |--> browsers
    cron (reaper etc.) -->|  source of truth|         +----------+
                          +--------+-------+
                                   ^  claim / reserve / results
                                   |
        app/backend ROLE=session-worker  (N per box)
          - holds the Redis lease + Postgres fence per instance
          - owns the Baileys socket, auth state, reconnect policy
          - claim loop: admit -> band -> guards -> reserve -> claim -> send -> record
                 |                                  |
            Redis 7 (rebuildable)              WhatsApp (linked device)
```

| Component | Role | Runtime | Scaling unit | Structurally forbidden |
|---|---|---|---|---|
| Customer API | `api` | Fastify 5 + oRPC/Zod v4, Node 24 | replicas behind nginx; stateless | may not import `provider/**` (dependency-cruiser rule `api ↛ provider`); never opens a WhatsApp socket; never sends |
| Session worker | `session-worker` | Node 24 + Baileys | one process per ~150 sessions; add processes, then boxes | may not send without holding the lease and the current fence; may not call `logout()` from the shutdown path |
| Scheduler | `scheduler` | Node 24 | singleton via a `singleton_leases` row (never `pg_advisory_lock`, which is unreliable under PgBouncer transaction pooling) | may not claim or send |
| Relay | `relay` | Node 24 | 1-2 replicas | may not publish inside a business transaction; reads the outbox only |
| Cron | `cron` | Node 24 | singleton via the same lease table | reaper, reconciler, retention, warm-up step, rollups |
| Migrate | `migrate` | one-shot container as `wp_migrator` on a direct, non-pooled connection | runs once per deploy, before the rolling restart | application processes never migrate; they assert schema version at boot and refuse to start on mismatch |
| Admin API | `admin/backend` | Fastify 5 | 1 replica | no DDL, no writes to any send-path table; mutations only via `/internal/v1` |
| PostgreSQL 17 | - | + PgBouncer (transaction pooling) | vertical first, read replica in v2 | the only source of truth |
| Redis 7 | - | - | vertical; dedicated box at roughly 2,000 sessions | strictly rebuildable: advisory pacing pre-filter, lease mutual exclusion, hot signal keys, SSE fan-out. It may deny, never grant |

v1 deliberately has **no separate send-worker role**. The lease-holder is the only legal sender, so job claiming is co-located inside `session-worker`. Splitting them is a v2 scaling lever and the lease design already permits it without a rewrite.

## 2.2 Flow A - connect an account by QR

1. Tenant clicks Connect. The API writes `desired_state='online'`, `link_state='pairing'`, `pairing_started_at=now()`, `qr_attempts=0`, plus an audit row. Connect is only reachable when `clients.onboarding_step` has passed email verification, timezone, pacing profile and the consent attestation - an entitlement check, not a hidden button.
2. Every session worker scans every 5s (±2s jitter) for instances that want to be online and are unowned. One worker wins the Redis lease `wp:{env}:lease:c:{client}:i:{instance}` with `SET NX PX 30000`.
3. The winner mints the fence in Postgres: `UPDATE whatsapp_instances SET current_fence = current_fence + 1, owner_worker_id=$w, lease_seen_at=now() WHERE id=$iid RETURNING current_fence`, writes that value back into the lease value, then waits `takeoverGraceMs` (15s) so any previous owner has time to self-fence. Grace is skipped when the previous owner released cleanly.
4. `makeWASocket` with no creds. Baileys emits `connection.update {qr}`. The worker increments `qr_attempts` and publishes the challenge on the tenant-scoped channel `wp:{env}:rt:c:{client}:i:{instance}`. The QR is a bearer credential: it is never logged, never a metric label, never an audit metadata value.
5. The panel renders the QR over the authenticated SSE connection with a 45s ring. The window is bounded: 5 attempts inside 5 minutes, then a terminal `pairing_expired` state with a **"Generate a new code"** button - never an auto-loop. A pairing code (8 characters, `requestPairingCode`) is the same flow with a different challenge type.
6. On `connection.update {connection:'open'}`: persist creds, `link_state='linked'`, `health_state='connected'`, clear `needs_user_action`, apply warm-up tier 1, advance `onboarding_step`. The panel shows "Connected as +91·····21" with the number masked.
7. Baileys then almost always closes with `515 restartRequired`. This is expected: one immediate reconnect off a separate budget of 2, never `degraded`, never surfaced as an error.

Relink to a different JID is hard-blocked by default. Silently accepting a different number under the same instance is number substitution by the back door. If it is ever allowed, it requires typed confirmation showing the exact queued-job count, cancellation with `cancel_reason='relink_different_number'`, an audit row with old and new JID hashes, and a webhook.

## 2.3 Flow B - send a message

```
POST /v1/messages   (Idempotency-Key required)
 |- authz + entitlement + opt-out precheck + plan queue-depth cap (429 + Retry-After on breach)
 |- ONE transaction: INSERT message_jobs (status='queued')
 |                 + INSERT message_job_refs (public_id uuidv7, idempotency_key, dedupe_key)
 |                 + INSERT outbox event + audit row
 |- conflict on mjr_idem_uq -> ON CONFLICT DO UPDATE (no-op) RETURNING -> return the ORIGINAL job
 '- 201 { data: { id: public_id, status: "queued" } }
```

`DO UPDATE` rather than `DO NOTHING` is deliberate: under 50 parallel identical POSTs, `DO NOTHING` returns zero rows for the losers and produces 5xx unless the code re-selects; the no-op update returns the row every time.

The worker loop, per leased instance:

1. `gate.admitInstance()` - health state, sending window, health band, plus the Redis advisory pre-filter. A denial here costs no database work at all.
2. `band = DWRR.pick()` - deficit-weighted round robin, HIGH:NORMAL:LOW = 6:3:1, falling through to the next non-empty band. Deficit state is per-worker, in-memory, per leased instance, rebuilt on lease acquisition - advisory and rebuildable by construction.
3. `BEGIN` -> select the next eligible job (`FOR UPDATE SKIP LOCKED`, `LIMIT 1`) -> content guards (opt-out, blocked words, link-in-first-message, duplicate fan-out, per-recipient frequency) -> `pacing.reserve()` -> the claim `UPDATE` -> `COMMIT`. Any failure rolls the whole thing back, including the pacing reservation.
4. `INSERT send_attempts (state='prepared', lease_id, owner_fence, content_hash)` and `attempts = attempts + 1` in one transaction with a `dispatched` delivery event. The attempt row exists **before** the provider is contacted, which is what makes "crashed after send" detectable rather than invisible.
5. `transport.send()` with a hard 45s timeout. The lease heartbeat renews `message_jobs.lease_expires_at` while a send is genuinely in flight, so a slow media send does not get reaped out from under itself.
6. Result: attempt -> `acked`/`failed`; job -> `sent`/`queued` (retry with backoff)/`failed`; a `delivery_events` row. A zero-row result write is a hard error (`claim_lost_during_send`, `wp_claim_lost_total`), and the outcome is written onto the attempt row so the reaper repairs the job instead of discarding a successful send.

A **manual send from the panel is the same path**. The inbox composer calls the same `POST /v1/messages` with `SendOrigin.INBOX_MANUAL`, gets the same durable job row, the same pacing reserve, the same content guards and the same attempt record. There is no "send now" shortcut anywhere in the codebase, because `roles/api.ts` cannot import `provider/**` - the invariant is structural, not a convention. `SendOrigin` is a function parameter chosen by the call site, never a payload field; request schemas are `.strict()` and contain no `origin`.

## 2.4 Flow C - receive a message

1. The socket factory mounts handlers on every connect, so they cannot be forgotten after a reconnect. `messages.upsert` processes only `type === 'notify'`; `append` (history replay) is skipped in v1.
2. Each message is handled inside its own `try/catch`. One malformed message never kills the batch; the failure is logged with ids only and counted.
3. JID filters drop `status@broadcast` and `@newsletter` before any work. Group messages are ingested only when `whatsapp_instances.capture_groups = true` (default false). Presence and typing indicators are dropped - pure noise at fleet scale.
4. Storage is an idempotent upsert keyed on the provider message id, with the tenant predicate present even on the conflict path. Media metadata is always stored; bytes only when `capture_media = true` and the payload is ≤16 MB, downloaded lazily and streamed to the object store under `clients/{clientId}/{instanceId}/{yyyy}/{mm}/{uuid}` - a key that only `storage.put()` may construct. Media is served exclusively through an authenticated route that re-checks `client_id` and issues a 5-minute signed URL; never a static directory.
5. `fromMe` echoes are ingested too, because they are the reconciler's primary evidence (2.7).
6. Receipts (`messages.update`, `message-receipt.update`) become `delivery_events` and advance a **monotonic** status rank on the job (`queued=0 … read=4`, `failed=9` always wins). Without the rank predicate, a late `delivered` silently downgrades a `read`.
7. Receipts are recorded even while the instance is paused. Pausing stops *sending*, not *observing*.

## 2.5 Flow D - an account goes unhealthy

Three orthogonal fields, never collapsed: `link_state` (unlinked/pairing/linked), `health_state` (connected/degraded/paused/logged_out), `desired_state` (online/offline). `needs_user_action` + `user_action_reason` drive the panel banner. Every transition out of `connected` writes an audit row and a notification; nothing silently stops.

1. A restriction code arrives (403/402/406). The instance moves to `health_state='paused'`, `pause_reason='provider_restriction'`, `needs_user_action='RESTRICTION_SIGNAL'`.
2. Claims stop **at the storage layer**, not in application code: `i.health_state = 'connected'` is a predicate inside the claim UPDATE, so a stale or buggy worker gets zero rows.
3. Queued jobs are untouched. Nothing is deleted, failed or reordered by a pause.
4. Notification fan-out is mandatory: panel banner, email, customer webhook, audit row, plus a `pacing_events` row of kind `hard_signal_pause` carrying the full signal vector, effective limits, warm-up tier, account age and 30-day send history. That single row per restriction is the labelled dataset that eventually makes the health score tunable.
5. Resume requires an authenticated **user**. `POST /v1/instances/:id/resume` returns 403 for `actor_type='api_key'` and `actor_type='system'` in every case, and additionally requires an acknowledgement flag when `pause_reason='provider_restriction'`. There is no `forceResume`, no timer, no auto-clear.

Softer degradation follows the same shape: transient closes set `degraded` and reconnect with backoff; an exhausted reconnect budget sets `paused` with `RECONNECT_FAILED`; the pacing evaluator can tighten caps or, at band CRITICAL, pause. Tightening is immediate; loosening is hysteretic (+8 points, a dwell period, no hard signal in 24h, at most one improvement per 6h and two per 24h).

## 2.6 The Baileys session engine

### Encrypted auth state: what lives where

Baileys' `AuthenticationState` is `{ creds, keys }`, and the two halves have completely different churn and rebuildability.

| Material | Churn | Rebuildable | Storage |
|---|---|---|---|
| `creds` | low | no - losing it means a full re-QR | Postgres `whatsapp_session_credentials`, envelope-encrypted |
| `app-state-sync-key`, `app-state-sync-version` | very low | no - losing them breaks app-state sync | Postgres `whatsapp_session_keys`, encrypted |
| `pre-key` | moderate | no | Postgres `whatsapp_session_keys`, encrypted |
| `session` (per-contact Signal session) | high | yes, at the cost of some decrypt retries | Redis only, encrypted, TTL 30d |
| `sender-key`, `sender-key-memory` | high (groups) | yes | Redis only, encrypted, TTL 30d |

The rule: Postgres is truth, Redis is rebuildable, and **anything not rebuildable is never Redis-only**. This is also what keeps the Postgres write rate at roughly 30-60/s at 1,000 sessions instead of thousands/s.

`EncryptedAuthStore` is `loadCreds`, `saveCreds({expectedVersion, fence})`, `getKeys`, `setKeys(..., fence)`, `purge(..., fence)`. `setKeys` and `purge` take and enforce a fence - a stale owner must not be able to destroy a live session. `saveCreds` is an upsert (`ON CONFLICT (instance_id) DO UPDATE ... WHERE cred_version = $expectedVersion AND owner_fence <= $fence RETURNING cred_version`) so the first save of a new instance does not throw. Calls are serialised per instance behind a promise chain; a **version** conflict with a matching fence reloads and retries up to 3 times and never changes health state, while a **fence** conflict self-fences and releases the lease.

There is exactly **one serialisation boundary**, at the encryption boundary, in both directions: `JSON.stringify(value, BufferJSON.replacer)` -> `envelope.seal` (Buffer in, Buffer out), and `envelope.open` -> `JSON.parse(..., BufferJSON.reviver)` once. `seal`/`open` accept and return Buffers only, so there is no code path where an already-parsed object reaches `JSON.parse` - the double-parse bug found in evolution-api's Prisma auth state is unrepresentable here. A round-trip test on a real `initAuthCreds()` object (Buffers and Uint8Arrays) guards it.

`syncFullHistory:false` and `markOnlineOnConnect:false` are defaults, not options. History sync costs a transient 200-500 MB heap spike per session, an unbatched write burst, a reconnect-storm multiplier, and third-party personal data we have no consent to store.

### Lease plus Postgres-minted fence

Mutual exclusion is the Redis lease; **authority is the fence, and the fence is minted in Postgres**. Redis is declared rebuildable everywhere else in this architecture; if it also minted the fence, a Redis flush would reset the counter and silently freeze the fleet behind stale-fence predicates. With Postgres minting, a flush costs exactly one takeover cycle.

Every state write carries a fence predicate: the claim, the creds save, signal-key writes, purge, the job result, delivery events. A worker with a stale fence gets zero rows on all of them. No branch, no race, no in-memory check.

Self-fencing has two independent triggers: the heartbeat Lua returning 0 or throwing (commands carry a 2s timeout), **and** a local monotonic watchdog that fires unconditionally if no *successful* renewal completed within 15s. The second exists because a hung half-open TCP connection to Redis never returns an error.

All timing constants live in one exported `TIMING` object in `@wp/domain` with a unit test asserting the ordering invariants:

```
leaseTtlMs 30_000 · heartbeatMs 10_000 · takeoverGraceMs 15_000 · watchdogMs 15_000
sendTimeoutMs 45_000 · claimExpiryMs 90_000 · reaperGraceMs 30_000 · reconcileWindowMs 600_000
invariants: sendTimeout < claimExpiry - reaperGrace ; takeoverGrace + leaseTtl > watchdog
```

Split brain is bounded, not eliminated, and the plan says so: a paused process that wakes up may physically deliver one duplicate message before its fence is rejected. Fencing guarantees state integrity; WhatsApp has no conditional-send primitive, so exactly-once *delivery* is not on offer from anyone.

### Fleet assignment, drain, staggered reconnect

Assignment is **lease-grab**, chosen over consistent hashing and over a central assigner. Both alternatives buy placement control we do not need at 1,000 instances and cost a membership/consensus subsystem plus rebalance reconnect storms. Every worker scans every 5s (±2s jitter):

```sql
SELECT id FROM whatsapp_instances
 WHERE desired_state = 'online' AND deleted_at IS NULL
   AND link_state IN ('linked','pairing') AND health_state <> 'logged_out'
   AND (lease_seen_at IS NULL OR lease_seen_at < now() - interval '45 seconds')
 ORDER BY random() LIMIT 50;
```

and grabs up to `MAX_SESSIONS_PER_WORKER` (default 150, hard ceiling 250). `WORKER_SHARD_INDEX/TOTAL` does not exist in the config. Soft yield: above 0.9× cap with event-loop lag p99 over 200 ms, the worker stops grabbing and logs `worker.saturated` - loop lag, not RAM, is the real early-warning signal for a Node session host. Healthy sessions are never moved; imbalance self-corrects over a deploy cycle.

Lease-grab has one failure mode that is invisible unless instrumented: an instance that wants to be online and that **nobody** owns. Two gauges cover it, `wp_instances_unowned` and `wp_fleet_capacity_headroom`, with alerts at unowned > 0 for 2 minutes and headroom < 20%. After three scan cycles unowned, the instance goes `degraded` with `needs_user_action='INFRA_UNAVAILABLE'` so the tenant sees the truth instead of a silently growing queue.

Connect storms are metered twice: a per-worker token bucket (2/s, burst 5) and a fleet-wide Redis bucket `wp:{env}:sys:tb:connect` (8/s, burst 20), plus a permanent per-instance deterministic offset. A cold start of 1,000 sessions therefore takes about two minutes, deliberately - a 15-second stampede pins every core on Curve25519 handshakes and is exactly the kind of correlated behaviour we do not want to present to WhatsApp.

Reconnect backoff is full jitter: `ceiling = min(300_000, 2_000 · 2^(attempt-1))`, `delay = random(0, ceiling)` plus the per-instance stagger, `MAX_ATTEMPTS = 8`. The counter resets only after an `open` that lasts more than 60s, so a flapping session cannot refill its own budget forever. Budget exhausted means `paused` + `RECONNECT_FAILED` + audit + notification + webhook, never a silent stop.

Drain on SIGTERM (`stop_grace_period ≥ 45s`): stop grabbing -> stop claiming -> wait up to 20s for in-flight sends (anything still in flight becomes `needs_reconcile`) -> flush `saveCreds` -> `sock.end()` on every session -> release every lease -> close pools -> exit 0. Step four is `sock.end()`, **never** `sock.logout()`: a logout on shutdown would unlink every tenant's WhatsApp on every deploy. `logout()` lives behind an explicit `unlink()` use case that the shutdown path cannot import, and a static-analysis test asserts that.

### DisconnectReason to health state

`disconnect-map.ts` is a data table with a test that fails when the pinned Baileys enum gains an unmapped member. **The numeric values below come from library knowledge and must be re-derived from the pinned enum at implementation time.**

| Code | Name | health_state | link_state | Auto-reconnect | Action |
|---|---|---|---|---|---|
| 515 | restartRequired | connected (stays) | linked | yes, once, separate budget of 2 | never surfaced as an error |
| 428 | connectionClosed | degraded | unchanged | yes, backoff | - |
| 408 | connectionLost / timedOut (same code) | degraded | unchanged | yes, backoff | do not write code that distinguishes the two names |
| 503 | unavailableService | degraded | unchanged | yes, backoff ×5 | over 20% of the fleet in 5 min triggers a global `PROVIDER_OUTAGE` banner and drops the connect bucket to 2/s |
| 440 | connectionReplaced | **paused** | linked | **never** | `session_replaced`; resolved silently only when this worker can point to a lease acquisition with a higher fence inside `leaseTtl+grace` for this instance |
| 401 | loggedOut | logged_out | unlinked | **never** | purge auth material, `relink_required` |
| 403 / 402 / 406 | forbidden / policy | **paused** | linked | **never** | `restriction_signal`; jobs stay queued; human resume with acknowledgement |
| 411 | multideviceMismatch | logged_out | unlinked | **never** | purge, relink |
| 500 | badSession | logged_out | unlinked | **never** | purge, relink (reconnecting with dead creds loops forever and looks abusive) |
| - | pairing window exhausted | paused | unlinked | no | `pairing_expired` |
| any other | unknown | **degraded, then paused after 2 attempts** | unchanged | limited | logs `disconnect.unmapped` with the raw code |

**Never auto-reconnect: 401, 402, 403, 406, 411, 440, 500.** Four of those are restriction-or-conflict signals, and auto-reconnecting on them is precisely the forbidden "auto-resume after a restriction without explicit human action". The other three are dead-credential states where reconnecting is guaranteed to fail in a loop. An unmapped code gets a *shorter* leash than a known transient, not the default one.

## 2.7 The durable queue

`message_jobs` is partitioned monthly by `created_at` with PK `(id, created_at)` and `id bigint GENERATED ALWAYS AS IDENTITY`. The job reference tuple everywhere is `(message_job_id, message_job_created_at)`; the only externally visible id is `message_job_refs.public_id` (uuidv7); there are no foreign keys to `message_jobs`. Claim index: `(client_id, instance_id, priority_rank, next_attempt_at, id) WHERE status='queued'`.

### The one canonical claim

It lives in `db/queries/claim-jobs.sql` and that file is the single source in code - no module re-transcribes it. It is reproduced once here because the predicates *are* the invariants:

```sql
WITH eligible AS (
  SELECT j.id, j.created_at
    FROM message_jobs j
    JOIN whatsapp_instances i ON i.id = j.instance_id
    JOIN clients c            ON c.id = j.client_id
   WHERE j.client_id       = $client_id
     AND j.instance_id     = $instance_id
     AND j.status          = 'queued'
     AND j.priority_rank   = $band
     AND j.next_attempt_at <= now()
     AND j.scheduled_at    <= now()
     AND i.current_fence   = $fence          -- caller currently owns the session
     AND i.health_state    = 'connected'     -- not paused, not degraded
     AND i.session_epoch   = j.session_epoch -- no wrong-number send after a relink
     AND i.deleted_at IS NULL
     AND c.status          = 'active'        -- suspension stops claims
   ORDER BY j.next_attempt_at, j.id
   FOR UPDATE OF j SKIP LOCKED
   LIMIT 1)
UPDATE message_jobs j
   SET status='processing', lease_owner=$worker, lease_id=gen_random_uuid(),
       owner_fence=$fence, leased_at=now(),
       lease_expires_at = now() + ($claim_expiry_ms || ' ms')::interval,
       pacing_reserved_at = now(), pacing_ledger_date = $ledger_date, updated_at = now()
  FROM eligible e
 WHERE j.id = e.id AND j.created_at = e.created_at AND j.status = 'queued'
RETURNING j.id, j.created_at, j.lease_id, j.instance_id, j.session_epoch,
          j.recipient_jid, j.payload, j.payload_kind, j.attempts;
```

Rules that make this the only claim: `attempts` is **not** incremented here (it moves exactly once, with the `send_attempts` insert); ordering is by `next_attempt_at` inside a band chosen by DWRR, and `ORDER BY priority_weight DESC` is banned as starvation; `LIMIT 1` because per-instance concurrency is 1 and the minimum gap depends on it; zero rows is a normal outcome and rolls the transaction back including the pacing reservation. The review question is literal: *does the claim statement itself carry the fence, health, epoch, client and plan predicates?* Checked outside the UPDATE means reject.

### The reaper

Every 15 seconds, batches of 500, `FOR UPDATE SKIP LOCKED`, joined to `send_attempts` on the partition-aligned tuple plus `lease_id`. It maps the attempt state, not a guess:

| Attempt state at expiry | Job becomes | Why |
|---|---|---|
| no attempt row, or `prepared` | `queued`, `attempts` decremented by 1, `next_attempt_at = now() + 5s` | the provider was never contacted, so the attempt should not be counted |
| `dispatched` | `needs_reconcile` | genuinely ambiguous |
| `acked` | `sent`, `sent_at` and `terminal_at` filled, `reconciled` delivery event | the send succeeded and only the result write was lost |
| `failed` | `queued` with backoff | a normal retry whose result write was lost |

The decrement applies only to `prepared`. The "no attempt row" case never incremented anything, so decrementing it would drive the counter negative and create an unbounded retry path.

### Ambiguous sends: needs_reconcile, then blocked_needs_review

When a socket dies mid-`sendMessage` there is no transaction across WhatsApp and no "get status by client reference" API. **We cannot know whether it was delivered.** Any design claiming otherwise is lying, so v1 resolves it explicitly:

1. The attempt row already exists as `dispatched` with a `content_hash`. The job goes to `needs_reconcile`, **not** back to `queued` - requeueing is a blind retry, and a duplicate WhatsApp message to a real person is the report vector that no sender-side pacing controls.
2. The reconciler looks for evidence for 10 minutes. Primary evidence is the **echo**: WhatsApp replays our own `fromMe` messages to a reconnecting linked device. The inbound handler hashes every `fromMe` message and matches `(instance_id, content_hash)` within ±5 minutes. Secondary evidence is a receipt for a provider id we never recorded, matched the same way.
3. Ambiguity is resolved conservatively: oldest in-flight first, 1:1 assignment enforced by the `message_wa_ids` unique key, and if more than one in-flight attempt shares the hash, **none** is resolved - both go to `blocked_needs_review` and `wp_reconcile_ambiguous_total` increments.
4. Window expired with no evidence means `blocked_needs_review`, attempt `abandoned`, `needs_user_action` on the **job** (not the instance), and a panel entry with exactly two buttons: **"Retry (may duplicate)"** and **"Discard (may have been delivered)"**. The chosen action writes an audit row with `actor_user_id`.
5. **There is no automatic requeue.** The only exception is a per-client, audited, warned setting `ambiguous_send_policy ∈ ('ask_me','resend_once')`, default `ask_me`, which is inert while `pause_reason='provider_restriction'` or the instance is logged out, and must be re-confirmed after any restriction pause.

Ambiguous sends should be rare - they need a crash inside a roughly 1-2 second window. We alert above 0.1% of sends per instance per day, because that indicates real instability rather than bad luck. The echo-replay assumption is the single most important unproven behaviour in this design and gets its own spike in the engine phase.

### Idempotency authorities

A UNIQUE constraint on a partitioned table silently becomes per-partition unless it includes the partition key. Every uniqueness authority therefore lives in a **non-partitioned side table**, and a schema test asserts that no partitioned table carries a unique index without its partition key:

| Authority | Table | Key |
|---|---|---|
| API idempotency | `message_job_refs` | `UNIQUE (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL` |
| Content/campaign dedupe | `message_job_refs` | `UNIQUE (client_id, instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL` |
| Provider message id | `message_wa_ids` | `PRIMARY KEY (client_id, instance_id, wa_msg_id)` |
| Delivery event replay | `delivery_event_ids` | `provider_event_id PRIMARY KEY`, where the id is `sha256(instance_id ‖ external_id ‖ event_type ‖ event_ts ‖ participant_jid)` - the participant must be included or group receipts collide |
| Attempt numbering | `send_attempts` (not partitioned; retention by DELETE) | `UNIQUE (message_job_id, attempt_no)` |

We do **not** self-mint Baileys message ids in v1 unless a spike proves WhatsApp deduplicates on a caller-supplied id and echoes it back. Until then `client_msg_id` is nullable and unused for correctness, and no user-facing or contractual copy may state that duplicates are impossible.

Retry classification lives in `@wp/domain/retry/classify.ts`: `transient` requeues with backoff (`min(15 min, 2s · 2^attempts)` then full jitter); `not_connected` requeues and degrades the instance; `rate_limited` requeues with the provider's retry-after **and** raises a health signal; `invalid_recipient`/`invalid_payload` are terminal `failed`; `restricted` and `unknown` **pause the instance**. Campaign expansion is a resumable cursor - batches of 500, each batch one transaction inserting jobs plus refs with `dedupe_key = sha256(campaign_id ‖ recipient)`, advancing `campaigns.expanded_through_recipient_id`.

Jobs created for an offline or unlinked instance return `202` with `warning: INSTANCE_OFFLINE` (or `409` when unlinked), and the panel surfaces `oldest_queued_seconds` with the reason plus a daily digest - so the "park accounts to save RAM" capacity lever can never become a silent delivery failure.

## 2.8 The transport boundary

`app/backend/src/provider/provider.types.ts` contains no Baileys type (lint-enforced). It is split in two because a Cloud API channel has no persistent socket and a Baileys session has no webhook registration:

- `MessageTransport`: `kind`, `capabilities {text, media, templates, groups, maxMediaBytes, requiresOptIn}`, `send(instanceId, msg): Promise<SendOutcome>` rejecting with `{class: SendErrorClass, retryAfterMs?}`, and `isReady(instanceId)` with no network I/O.
- `ChannelLink`: `beginLink({method:'qr'|'code', phone?})`, `refreshChallenge()`, `linkStatus()`, `unlink(reason)`.
- `LinkChallenge = {type:'qr'|'code'; payload; expiresAt; attemptsLeft} | {type:'redirect'; url; expiresAt}` - so a v2 embedded-signup redirect drops in without changing any caller.
- `SendErrorClass = 'transient' | 'not_connected' | 'invalid_recipient' | 'invalid_payload' | 'rate_limited' | 'restricted' | 'unknown'`. The engine branches only on this; a raw provider string never reaches the hot path.

Permanently absent, and the reason each cannot exist: `rotateNumber`/`failoverTo` (number rotation), `setProxy`/`proxyPool` (connection masking - this is the evolution-api feature we will never copy), `setDeviceFingerprint` (identity spoofing), `forceResume` (auto-resume after a restriction), and any per-send pacing override (a client-settable bypass). The interface is shaped so these methods have nowhere to live, and a CI token ban (`rotateNumber|rotateProxy|proxyPool|setProxy|proxyscrape|fingerprint|spoof|forceResume|autoResume|bypassPacing|failoverNumber`) fails the build if one appears in source. v1 registers exactly one adapter; `whatsapp_instances.provider_kind` exists from day one so a v2 adapter needs no migration.

## 2.9 Realtime updates

One SSE connection per authenticated session, served by `ROLE=api` and fed by the outbox `relay` - not WebSocket, because the traffic is one-directional fan-out and SSE survives nginx and reconnects for free. Channel authorisation happens at connect **and** is re-checked on membership change and on a `token_epoch` bump, so a revoked membership drops the stream within 5 seconds.

| Event | Payload | Consumer |
|---|---|---|
| `instance.qr` | `{instanceId, expiresAt, attemptsLeft}` + challenge payload | pairing screen only, tenant-scoped channel, never logged |
| `instance.health_changed` | `{instanceId, healthState, pauseReason, needsUserAction}` | instance card, banner |
| `instance.pacing_changed` | `{instanceId, band, tier, effDailyCap, configVersion}` | Safe Mode card |
| `message.job.sent/failed/delivered/read` | `{jobPublicId, instanceId, status}` | list invalidation |
| `job.needs_user_action` | `{jobPublicId, reason}` | Unresolved sends list |
| `campaign.progress` | `{campaignId, sent, queued, failed}` | campaign screen |

Events carry ids and enums only; the client refetches through the authorised API, so a channel bug cannot become a data leak. Events are written to the outbox inside the business transaction and published by the relay afterwards, never published inside it.

## 2.10 Capacity and the scaling playbook

**Confidence: Low-Medium. Every number below is derived, not measured.** No capacity figure and no price may be quoted to a customer before the scale-proof phase runs.

Per idle connected session, derived: Baileys socket and Noise state 4-8 MB, Signal working set 5-15 MB (it scales with distinct contacts), bounded Baileys caches 3-8 MB, WP per-instance state 2-4 MB - **use 35 MB RSS and 0.3% of a vCPU**. An actively conversing session is 45-70 MB and roughly 1.0%. These figures are only valid because the design enforces no history sync, no in-process message store, bounded caches and Redis-backed signal keys.

| Tier | Boxes | Sessions | RAM for sessions | Approx cost/month |
|---|---|---|---|---|
| **Proof (start here)** | 1× 4 vCPU / 16 GB (app + PG + Redis) | 150 | 5.4 GB | $40-70 |
| Pilot | 1× 8/32 app + 1× 4/16 DB+Redis | 450 | 16 GB | $190-260 |
| **"1,000" target** | 2× 8/32 app + 1× 8/32 DB+Redis | 900 | 16 GB per app box | $400-560 |
| 1,000 comfortable | 2× 16/64 app + 1× 8/32 DB+Redis | 1,800 capacity, run 1,000 | 32 GB per app box | $700-950 |
| 5,000+ | 6-8× 16/64 app + PG primary/replica + dedicated Redis | 5,000 | - | $2.5-4k |

**The straight answer: 1,000 concurrently connected sessions does not fit on one or two small boxes.** At 35 MB per session that is about 35 GB for sockets alone, plus worker overhead, plus 2-5 GB of Redis for encrypted signal keys (the line item everyone forgets), plus Postgres - roughly **45-50 GB of RAM and 10-12 dedicated vCPU**, meaning two 8 vCPU / 32 GB worker boxes plus a third for Postgres and Redis, around **USD 400-560 per month**. Those are mid-size boxes. **If a session actually costs 60-80 MB** - entirely plausible for campaign accounts with large contact sets, because the signal-key working set scales with distinct contacts - **the fleet and the cost roughly double.** That single unmeasured number carries the whole cost model.

The escape hatch that makes a small fleet real is that not every account needs to be connected. `desired_state='offline'` parks an account; at a realistic 30% concurrency, 1,000 **registered** accounts means about 300 connected and about 11 GB, which genuinely fits one 8 vCPU / 32 GB box. Two honest caveats: a parked linked device **receives nothing while offline** (it syncs on reconnect, and WhatsApp's offline buffer is neither unlimited nor documented), so inbound features degrade; and cycling accounts hourly to save RAM is not something we build - parking an idle account for days is fine, churning handshakes is both a CPU cost and plausibly a signal. **"1,000 registered" and "1,000 connected simultaneously" are different products at different prices, and this plan must say which one v1 sells.**

Scaling playbook, with the measured trigger for each step:

| Trigger (metric) | Threshold | Action |
|---|---|---|
| `wp_worker_eventloop_lag_p99` | > 200 ms at ≥0.9× cap | soft yield engages automatically; if sustained, lower `MAX_SESSIONS_PER_WORKER` before adding sessions |
| `wp_fleet_capacity_headroom` | < 20% | add a `session-worker` replica; add a box when the host is over 70% RAM |
| `wp_instances_unowned` | > 0 for 2 min | page: either the fleet is at cap or a worker died without releasing |
| `wp_session_rss_bytes_est` | > 50 MB sustained | re-derive the capacity table and re-price before any commitment |
| Redis used memory | > 60% of box | move Redis to a dedicated box (expected around 2,000 sessions), then split lease/pacing keys from signal keys |
| `pacing.reserve()` p99 | > 25 ms | Postgres tuning, then partition growth for `message_jobs` |
| Claim throughput vs queue depth | `oldest_queued_seconds` rising with headroom available | split `session-worker` from a dedicated `send-worker` role (the lease design already permits it) |
| Sessions per box beyond measured ceiling | - | reduce per-session memory first (tighter caches, harder eviction to Redis); a Go/Rust session host behind the same transport boundary is the highest-leverage rewrite and is a component swap, not a rebuild |

Consistent hashing is revisited only if placement quality becomes a *measured* problem, which it is not at 1,000 instances.

## 2.11 Common code: the folder tree

The founder's four-project layout is binding and literal. Shared code lives in `packages/`, never copy-paste.

```
wp/
├── app/
│   ├── frontend/          React 19 + Vite SPA, the customer dashboard
│   └── backend/           Node 24 + TS. Owns the DB, the queue, the sessions, ALL DDL
├── admin/
│   ├── frontend/          React 19 + Vite SPA, staff console
│   └── backend/           Node 24 + TS. Read-mostly; no migrations, no send-path writes
├── website/               Next.js 16, static export, animated hero
├── packages/
│   ├── contracts/         oRPC route contracts + Zod v4 schemas + error codes + event payloads
│   ├── domain/            PURE logic: FSMs, TIMING, retry classifier, DWRR, pacing math, can(), BANNED_CLAIMS
│   ├── server-kit/        Node-only base services shared by both backends
│   ├── ui/                React design system used by all three UIs
│   ├── design-tokens/     DTCG JSON -> CSS custom properties + Tailwind v4 preset
│   ├── utils/             isomorphic helpers (phone, dates, cursors) + utils/i18n
│   └── config/            tsconfig / eslint / prettier / vitest / tailwind bases + config/testkit
├── db/                    ONE database: schema/ migrations/ queries/ seeds/ src/
├── infra/                 compose/ deploy/ nginx/ observability/ backup/
├── scripts/               ci.ps1|ci.sh, check-tenant-scope.ts, check-send-origin.ts,
│                          check-copy.ts, snapshot.ps1, new-module.ts
├── docs/                  CONVENTIONS.md, RUNBOOK.md, api/ (generated OpenAPI)
├── demo/                  READ-ONLY reference repos. Never imported, never built
└── package.json  pnpm-workspace.yaml  .npmrc  VERSION  CHANGELOG.md
```

Seven packages plus `db/`. `i18n` starts inside `packages/utils` and `testkit` inside `packages/config`; each is promoted to a top-level package only when a third consumer appears. Turborepo is dropped for v1 - `pnpm -r --filter` plus TypeScript project references covers it at this size, and a task runner is a thing to maintain.

Inside `app/backend`:

```
app/backend/src/
├── main.ts               reads ROLE, boots exactly one role, wires graceful shutdown
├── roles/                api.ts · session-worker.ts · scheduler.ts · relay.ts · cron.ts
├── modules/              identity · tenancy · instances · queue · pacing · messaging ·
│                         contacts · campaigns · webhooks · media · audit · realtime
│                         each: <m>.routes.ts · <m>.service.ts · <m>.repo.ts · types.ts · index.ts
├── provider/             provider.types.ts · registry.ts · errors.ts · baileys/
│                         baileys/: socket-factory · auth-state/{store,bridge,codec} ·
│                         disconnect-map.ts · events/{connection,messages-upsert,receipts} · send.ts
├── engine/               lease/ · fleet/{discovery,drain,connect-budget} · reconnect/ · send/ · inbound/
└── platform/             config.ts (the ONLY file that reads process.env) · container.ts · http/ · jobs/
```

`admin/backend` has the same shape with a single role and roughly 80 lines of platform wiring: modules `auth` (staff, mandatory TOTP, IP allowlist), `tenants`, `instances` (read + S2S pause), `leads`, `analytics`, `support` (time-boxed audited impersonation). `app/frontend` and `admin/frontend` are identical in structure: `routes/` (URL shape and loader only), `features/<feature>/{api.ts, keys.ts, components/, hooks/, index.ts}`, `components/`, `lib/`, `providers/`, `styles/`.

## 2.12 Layering, write ownership and dependency rules

**Backend layering:** `roles/ -> modules/<m>/{routes,service,repo,index} -> @wp/domain`, with `platform/` wiring `@wp/server-kit`. Routes parse with a contract schema, call a service and map the result - they contain no SQL and no `db` import. Repos contain SQL only, are always tenant-scoped, and hold no business rules and no `if` on business state. Services own transactions, authorisation, orchestration and events, take `ctx: TenantContext` as their first argument, and may import another module only through its `index.ts`. Domain rules never live in `modules/` - they live in `@wp/domain` and are called from services, which is why the browser can run the same FSM the worker runs. One primary export per file, file name equals that export, hard limit 300 lines.

**Frontend layering:** a route file holds no business logic; a feature never imports another feature's internals; no component fetches directly - it uses a hook from `features/*/api.ts`, which is the only place `fetch` happens. Server state is TanStack Query with per-feature key factories and explicit `staleTime`; client state is React state and context, with a global store permitted only for the inbox composer draft. Forms use react-hook-form with `zodResolver` over the **same schema the server validates with**, imported from `@wp/contracts`. Every mutation that creates a job sends a client-generated uuidv7 idempotency key. `can()` from `@wp/domain` greys out buttons and the server always re-checks - the UI check is UX, never security.

**Write ownership** is the one place the design deliberately improves on the literal instruction. The database is shared, as instructed, but:

| Concern | app/backend | admin/backend |
|---|---|---|
| DDL and migrations | sole owner; the `ROLE=migrate` one-shot container is the only migrator | never |
| `message_jobs`, `whatsapp_instances`, `delivery_events`, `pacing_ledger`, `send_attempts` | read + write | **read only**, enforced by `wp_admin_app` having no INSERT/UPDATE/DELETE grant, asserted by a role-grant snapshot test |
| Cross-tenant reads | not needed | allowed via the single `platformRead(ctx, reason, fn)` helper, which writes the audit row in the same transaction and is the only code that may open a `wp_admin_app` connection |
| Mutations (pause, resume, cancel campaign, suspend client, limits, pacing override) | owns them | calls `/internal/v1/*` on app/backend with a signed HMAC service token, `X-Actor: staff:<id>`, mandatory `Idempotency-Key`, and a staff audit row per handler |

Two writers of `message_jobs` or of health state would break the durable-queue and fail-safe invariants. One owner, one audit trail, one health FSM.

**Dependency rules, one direction, no cycles:**

```
design-tokens -> nothing          utils -> nothing
domain        -> utils only (browser-pure)
contracts     -> domain, utils
db            -> domain (types only), utils
server-kit    -> db, domain, contracts, utils
ui            -> design-tokens, utils, contracts (TYPES only)
app|admin backend  -> server-kit, db, domain, contracts, utils
app|admin frontend -> ui, design-tokens, contracts, domain, utils
website            -> ui, design-tokens, utils

FORBIDDEN always: app/* <-> admin/*  ·  any frontend -> server-kit or db
                  packages/* -> app|admin|website  ·  roles/api.ts -> provider/**
```

### Mechanical enforcement (a rule without an automated guard is not a rule)

| Guard | What it proves |
|---|---|
| dependency-cruiser | no cross-project imports, no upward package imports, no frontend reaching `server-kit`/`db`, no deep module imports, and `roles/api.ts` may not import `provider/**` - the structural form of "the API never sends directly" |
| `domain-must-be-pure` (two rules) | the core-builtin rule **plus** an npm rule blocking `pg|ioredis|redis|drizzle-orm|pino|fastify|@wp/(db\|server-kit)`; `dependencyTypes:['core']` alone can never match an npm package |
| browser build of `@wp/domain` | shared logic is real, not aspirational; plus `no-restricted-globals` for `Date.now`/`Math.random` inside domain, because an injected clock is what keeps pacing tests deterministic |
| `scripts/check-tenant-scope.ts` | every query against a `client_id` table carries a `client_id` predicate, unless the file:symbol is registered in `CROSS_TENANT_QUERIES` with role, reason and projected columns (one registry covers the discovery loop, the scheduler worklist, the reaper, retention and admin reads) |
| `scripts/check-send-origin.ts` | exempt origins are referenced only under `modules/pacing/internal/`, and no DTO anywhere accepts `origin` from input |
| `scripts/check-copy.ts` | one `BANNED_CLAIMS` array exported from `@wp/domain` (including Hindi/Hinglish forms), scanned across the whole repo except `demo/` and `.memory/`, and every surface string containing "Safe Mode" must ship with `SAFE_MODE_DISCLAIMER` |
| key-construction lint | Redis keys only via `tenantKey()`/`sysKey()`; a raw `wp:` literal outside `platform/redis` is an error |
| `no-restricted-syntax` | plain `SET` (must be `SET LOCAL` or `set_config(...,true)`) and `OFFSET` pagination |
| guard meta-assertion | every guard asserts its target glob matched at least one file and fails with `guard matched zero files` otherwise - a guard that silently matches nothing is worse than no guard |
| role-grant snapshot test | `information_schema.role_table_grants` diff proving `wp_admin_app` cannot write any send-path table |
| TS project references | `composite: true` everywhere, so a cycle or a missing dependency is a compile error |

`scripts/ci.{ps1,sh}` is the definition of done, because with no git there are no server-side hooks: format -> lint -> depcruise -> domain browser build -> guard meta-assertion -> tenant-scope -> send-origin -> copy -> typecheck -> unit -> integration -> build. That single command's verbatim green output is the evidence rule.

## 2.13 Base services (`@wp/server-kit`)

| Service | Interface (abbreviated) | Failure behaviour |
|---|---|---|
| Tenant context | `TenantContext {clientId, actorId, actorType:'user'\|'staff'\|'system', role, requestId, traceId}`; `runInTenant(ctx, fn)` over AsyncLocalStorage + `SET LOCAL app.client_id` | missing context throws; it never defaults to "all tenants". Background jobs build the context from the job row's `client_id` |
| DB access | `createTenantDb(ctx)`; every builder injects `client_id = ctx.clientId`; `tx(ctx, fn)` | RLS FORCE is layer 2, `check-tenant-scope` is layer 3 |
| Config | `config` (Zod-parsed, frozen, boot-time) | fails closed on any missing secret; no runtime `process.env` reads outside this file |
| Logging | `logger.child({requestId, clientId, instanceId, jobId})`, pino JSON | allow-list of typed fields (ids, enums, counts, durations, error classes); free-form `meta: any` does not exist; a CI test greps an end-to-end log stream for the seeded tenant's phone, body, email and API key |
| Metrics/tracing | `metrics.counter/histogram`, `withSpan(name, fn)` | cardinality guard: label values limited to ids we already index |
| Errors | `AppError(code, httpStatus, message, details?)` hierarchy + one Fastify mapper + `classifyProvider(err)` | unknown throwables become `InternalError` with the message stripped; `requestId` always returned |
| Queue client | `queue.enqueue(ctx, tx, {...})`, `jobs.register(name, handler)` | enqueue happens **inside the caller's transaction**; handlers must be re-runnable; the claim is the conditional UPDATE, never memory |
| Event bus | `events.emit(tx, {...})` writes an outbox row; the relay publishes and marks | never publishes inside the business transaction; unpublished events are a visible metric |
| Notifications | `notify(ctx, 'instance.paused', {...})` fans out to in-app, email and customer webhook | pause, logout, budget exhaustion, duplicate-fan-out ack, unresolved send and plan-cap notifications are mandatory; a dedupe key stops a reconnect storm becoming an alert storm |
| Storage | `storage.put(ctx, buf, {mime})` -> `clients/{clientId}/{instanceId}/{yyyy}/{mm}/{uuid}`; `storage.signedUrl(ctx, key, ttl)` | the key prefix is built only here; a read whose prefix mismatches the context throws before reaching the store |
| Cache | `cache.get/set/del(tenantKey(...))`, `cache.wrap` | Redis is rebuildable; a cache outage degrades latency, never correctness |
| Rate limiting | `rateLimit.consume(tenantKey(...), policy)` at IP, client and key scope, strictest wins | tested by asserting a real 429 with headers per route class. Distinct from pacing: this gates HTTP, pacing gates claiming |
| Audit | `audit.record(ctx, {...})` written in the same transaction as the change | if the audit row cannot be written, the change does not happen |
| Feature flags | `flags.enabled('inbox.v2', {clientId})` | flags gate features, never pacing or safety controls |
| Crypto | `secrets.seal/open(ctx, ..., purpose)`, envelope AES-256-GCM, per-record DEK, purpose-separated KEKs behind a `KeyProvider` | the `session` KEK is mounted into workers only, so an RCE in the public API cannot decrypt a WhatsApp session; AAD is split by layer so KEK rotation never bricks a session |

## 2.14 Worked example: adding "send a message", end to end

Every file touched, in build order. This is the shape every future feature follows.

| Step | File | Responsibility |
|---|---|---|
| 1 | `packages/contracts/src/app/messages.ts` | `SendMessageInput` (instanceId, to, body, priority, scheduledAt), `MessageJobDTO`, error codes. `.strict()`, no `origin` field |
| 2 | `packages/domain/src/job/state-machine.ts` | `canTransition(from, to)` over the `job_status` enum |
| 3 | `packages/domain/src/retry/classify.ts` | `SendErrorClass -> RetryAction` (requeue / pause / fail) |
| 4 | `db/schema/message-jobs.ts` + `db/schema/message-job-refs.ts` | partitioned job table, the non-partitioned refs table and its two partial unique indexes |
| 5 | `db/migrations/00NN_message_jobs.sql` | forward-only DDL, hand-reviewed, `CREATE INDEX CONCURRENTLY` in its own `-- wp:no-transaction` migration |
| 6 | `db/queries/claim-jobs.sql` | the canonical claim (2.7), with its own integration tests |
| 7 | `app/backend/src/modules/messages/messages.routes.ts` | `POST /v1/messages`: validate with (1), require `Idempotency-Key`, call the service, return the envelope |
| 8 | `app/backend/src/modules/messages/send-message.service.ts` | `assertCan(ctx,'message:send',instance)`, entitlement + queue-depth cap, opt-out precheck, then one transaction: job + ref + outbox + audit |
| 9 | `app/backend/src/modules/messages/messages.repo.ts` | the insert with `ON CONFLICT (client_id, idempotency_key) DO UPDATE ... RETURNING` |
| 10 | `app/backend/src/modules/contacts/index.ts` | `isOptedOut(ctx, e164)`, consumed only through the module's public surface |
| 11 | `app/backend/src/modules/pacing/index.ts` | `admitInstance()` and `reserve()`; the exempt origins stay inside `modules/pacing/internal/` |
| 12 | `app/backend/src/modules/queue/worker.service.ts` | the claim loop: admit -> band -> guards -> reserve -> claim -> attempt row -> send -> record |
| 13 | `app/backend/src/provider/baileys/send.ts` | maps `sock.sendMessage` and thrown Boom codes onto `SendOutcome` / `SendErrorClass` |
| 14 | `app/backend/src/modules/instances/health.service.ts` | applies `restricted`/`unknown`: pause, preserve jobs, `notify()` |
| 15 | `app/backend/src/roles/relay.ts` | outbox -> customer webhook (SSRF-guarded, signed) + SSE `message.job.sent` |
| 16 | `app/frontend/src/features/compose/api.ts` + `compose-form.tsx` | typed client call, `zodResolver(SendMessageInput)`, client-generated idempotency key, optimistic row invalidated by SSE |
| 17 | tests | `send-message.service.test.ts` (unit, fake clock); `tests/integration/messages.int.test.ts` (`duplicate_idempotency_key_creates_one_job` with 50 parallel POSTs and zero 5xx; `two_workers_cannot_double_claim_one_job`); `tests/e2e/send.spec.ts` |

Files **not** touched: the admin project, the website, any other backend module, infra. That is the structural payoff of the layout, and it is the reason the boundaries are enforced by tools rather than by review notes.

## 2.15 What is honest about this architecture, and what is not

**Provable with tests, and gated in CI:** every send starts as a durable row; a duplicate claim is impossible at the storage layer; a stale worker cannot write anything; a pause never loses, fails or reorders queued work; a crash mid-send never blind-retries a possibly-delivered message; no plaintext WhatsApp credential reaches any datastore, filesystem or backup; the API process structurally cannot open a WhatsApp socket.

**Not provable, and stated rather than softened:** split brain can still deliver one duplicate message before the fence rejects the record of it, because WhatsApp has no conditional send. Echo-based reconciliation is well-observed but unvalidated in our code and needs its spike early, not late. Redis is a genuine single point of failure in v1 - losing it stops the whole fleet within 15 seconds, which is fail-safe but not fail-over, and that trade needs an explicit written acceptance. Every capacity and cost figure in 2.10 is derived from component estimates, not measured; the 35 MB per session assumption carries the entire cost model, and if the real figure is 60-80 MB the fleet and the price roughly double. And no architecture on this engine can prevent WhatsApp restrictions: pacing addresses sender-side velocity signals only, while recipient reports, message content and account reputation dominate and sit outside our control.


---

# 3. Safe Mode: pacing, warm-up and account health

## 3.1 What Safe Mode is, and what it is not

Internal module name: `pacing` (the Pacing and Reputation Engine, `app/backend/src/modules/pacing/**`). User-facing label: **Safe Mode**.

Safe Mode is a sender-side control loop with four jobs: (1) it consumes a metered send unit from a durable ledger before any message can be claimed, (2) it ramps a newly linked number up over calendar days instead of letting it blast on day one, (3) it reads the real signals WhatsApp gives a linked device and tightens or pauses when they degrade, and (4) it refuses to send content and to recipients that are the most common report triggers. It is not a shield, not a guarantee, and not a detection-evasion system.

> **`SAFE_MODE_DISCLAIMER` — single source in `@wp/domain`, used verbatim in the panel, the docs and the marketing site:**
> "Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control."

`scripts/check-copy.ts` scans the whole repo (excluding `demo/` and `.memory/`) against one exported `BANNED_CLAIMS` array and fails the build on `ban-proof`, `ban proof`, `won't get blocked`, `will not get banned`, `avoids WhatsApp blocking`, `100% safe`, `guaranteed delivery`, `unlimited sending`, plus the Hindi/Hinglish equivalents `ban nahi hoga`, `block nahi hoga`. The same guard asserts that every surface string containing "Safe Mode" ships alongside `SAFE_MODE_DISCLAIMER` (v1 architecture blueprint, mechanical enforcement table).

Three defaults are structural, not configurable: Safe Mode is **ON for every instance**, there is **no off switch** in the tenant UI or the API, and tenants may only **tighten**. The v1 blueprint deletes the `instance_pacing_profiles.enabled` column that earlier drafts carried, precisely because an off switch one column away from a tenant-writable table is a bypass waiting to be shipped.

## 3.2 What we took from Blastup

`demo/Blastup/server/src/safemode/` was read, never copied. Ten concepts survive at concept level; every line of our implementation is written from scratch.

| Concept | Their reference | What we keep |
|---|---|---|
| Tiered warm-up ramp | `tiers.ts:11-62` | The shape: start conservative, loosen over calendar days |
| Per-instance daily cap | `tiers.ts:14,24,34,44` | A hard daily ceiling — but **no unlimited tier ever** (their tier 5 is `dailyCap: undefined`, `tiers.ts:54`) |
| Minimum inter-send gap | `tiers.ts:15,25,35,45,55` | A floor between sends, redesigned as a jittered range |
| Sending-hours window | `tiers.ts:65-66` | Do not send when no human is awake — but in the tenant's local timezone, not their hardcoded UTC window (which lands at 14:30-02:30 IST, actively wrong for an India-first product) |
| New-conversation-per-day cap | `tiers.ts:16,26,36,46` | Cold-outreach velocity is capped separately from total volume |
| Link-in-first-message block | `tiers.ts:72-73`, `SafeModeManager.ts:176-184` | An unsolicited link to a stranger is a report trigger |
| Group-action conservatism | `tiers.ts:18,28`, `wrapBaileysSocket.ts:54-76` | Block `groupCreate` / `groupParticipantsUpdate` on immature accounts |
| Fail-closed, no retry loop | `campaign.service.ts:249-268` | Correct instinct — preserve the work rather than hammering |
| Self-expiring daily counters | `RedisSafeModeStore.ts:73-81,88-96` | Cron-free day rollover, kept only for the advisory Redis mirror |
| Pre-seeding known chats | `recordKnownChatsFromStore.ts:36-46` | A number with 3,000 real contacts is not 3,000 cold conversations |

What we did **not** take: their tier numbers as-is, their reply-rate gate, their UTC window, their Redis-authoritative counters, and their bypass flag.

## 3.3 What we fixed, defect by defect

**1. Check-then-write race in `checkAndRecord` → one atomic conditional UPDATE.** Their defect: `SafeModeManager.ts:138` reads `getSentToday`, `:151` reads `getNewChatsToday`, `:162` reads `getLastSentAt`, and only at `:187-191` — several round trips later — increments. Two concurrent sends on one instance both pass the cap check before either increments; `MemorySafeModeStore` has no protection at all. Our fix: **`pacing_ledger` in Postgres is the only grantor**, and one statement both decides and consumes (SQL in section 3.10). Redis Lua survives as an advisory pre-filter that can only return "definitely not eligible" or "ask Postgres" — it can never grant, so a Redis flush cannot reset a daily cap. At v1 scale this costs roughly 3.5 conditional UPDATEs per second aggregate (1,000 instances x ~300 sends/day), which is nothing for PostgreSQL 17.

**2. Fixed gap constants → jittered log-uniform draws.** Their defect: `tiers.ts:15,25,35,45,55` set `minGapMs` to exactly 10000/5000/3000/2000/1000 ms. A perfectly periodic send train is itself a mechanical pattern, and a 1-second steady drip is aggressive. Our fix: every tier carries `gap_min_ms` and `gap_max_ms`; each reserve draws `exp(log(min) + u*(log(max) - log(min)))`, which is right-skewed like human messaging, plus a long pause (multiplier 4-9x, capped at 15 minutes) every 18-35 sends. This is strictly **slower** than a fixed gap, never faster — that is what keeps it a pacing choice and not an evasion mechanism. `gap_min_ms` is an un-overridable floor: no config layer, no jitter draw, no code path may produce a gap below the system profile's floor.

**3. Deferral expressed as a thrown exception that drops the send → the job stays queued.** Their defect: `SafeModeManager.checkAndRecord` throws `SafeModeError` up through a monkey-patched `sock.sendMessage` (`wrapBaileysSocket.ts:29-52`) into `campaign.service.ts:249-275`; on some branches the specific recipient is marked **failed** because a *timing* condition arrived as an exception on the send path. Our fix: the gate is a **function that returns a decision**, and it runs **before the job is claimed**. A pacing denial leaves `status='queued'`, sets `next_attempt_at` to the moment the constraint expires, increments `pacing_deferrals`, and **never touches `attempts`** — a deferral is not a failure and never consumes retry budget (core invariant 5: pause preserves work).

**4. Client-settable bypass flag → typed `SendOrigin` enum.** Their defect: `wrapBaileysSocket.ts:32-35` — `content.__blastupSystemReply === true` skips **every** Safe Mode check, and the flag rides on the caller-supplied payload object. Our fix: `SendOrigin ∈ {campaign, api_send, inbox_manual, system_reply, opt_out_confirmation}` is an enum **parameter** to the gate, never a payload field. The exempt members `system_reply` and `opt_out_confirmation` are constructible only under `modules/pacing/internal/**`, enforced at build time by `scripts/check-send-origin.ts`, which also fails if any DTO or Zod schema anywhere accepts `origin` from request input; request schemas are `.strict()`, so an unknown key is a 400. Exempt sends are not unmetered: they increment `system_count`, respect the opt-out registry, respect blocked words, respect the **sending window** (a 03:00 STOP defers its confirmation to window open), and write a `pacing_events` row.

**5. Silent automatic tier escalation → audited, notified, reversible.** Their defect: `SafeModeManager.ts:199` fires `_maybeAdvanceTier` fire-and-forget with `.catch(() => {})`, throttled to every tenth send (`:262-270`), raising send limits in a background path with swallowed errors and no record of why. Our fix: tier changes happen only in the `pacing-evaluator` cron (every 5 minutes per instance, plus on demand), never on the send path. Every change writes a `pacing_events` row (`kind`, `from_value`, `to_value`, `reason_codes[]`, `evidence`, `actor_user_id`) **and** an `audit_logs` row in the same transaction, bumps `config_version`, and pushes a panel notification: "Day 8 — moved to Warm-up 3: 7 days elapsed, health 82 (healthy), no restriction signals."

**6. Reply rate as the sole hard gate → time-and-health gating.** Their defect: `tiers.ts:98-105` / `computeNextTier` advances a tier only if `replyRate >= minReplyRate`. Reply rate is entirely recipient-controlled, so a legitimate transactional sender (OTPs, delivery updates, invoices) never reaches 5% replies and is trapped at tier 1 — 10 messages a day, forever, with no operator visibility. Our fix has three layers: warm-up advances on **elapsed days + no hard restriction signal in 24h + health band ≥ watch**; reply rate is a soft signal with a capped penalty (10 of 120 points) that is excluded from the critical/pause computation; and `engagement_exempt` (tenant-settable, reason required, audited) marks notification-only instances so a recipient-controlled metric stops penalising them. `engagement_exempt` changes **no cap** — enforced structurally, see section 3.9.

## 3.4 The warm-up ladder

Six tiers over roughly 30 days, per `pacing_profiles.key` (`conservative` | `safe_default` | `steady`). Numbers below are the `safe_default` profile.

| Tier | Days | Daily cap | Hourly cap | New conversations/day | Gap range | Cold ratio max | Links in first message | Group actions |
|---|---|---|---|---|---|---|---|---|
| 1 | 1-3 | 20 | 8 | 5 | 45-180 s | 0.40 | blocked | blocked |
| 2 | 4-7 | 60 | 15 | 15 | 30-120 s | 0.50 | blocked | blocked |
| 3 | 8-12 | 150 | 30 | 40 | 20-90 s | 0.60 | warn | blocked |
| 4 | 13-18 | 300 | 50 | 90 | 12-60 s | 0.70 | allowed | allowed |
| 5 | 19-25 | 600 | 90 | 180 | 8-45 s | 0.75 | allowed | allowed |
| 6 (steady) | 26+ | 1,000 | 120 | 300 | 6-40 s | 0.80 | allowed | allowed |

Why these shapes: at tier 6 the log-uniform mean gap is about 18 s, so 1,000 messages need roughly 5 hours inside an 11-hour sending window — the daily cap binds before the clock does, which is what makes the cap meaningful rather than decorative. The hourly cap is a burst brake, not a second daily cap (11 x 120 > 1,000 by design). **No tier is unlimited**, ever, and the absolute platform ceiling is 2,000/day even under an admin relaxation.

Advancement rules: `day_from` reached (measured from `warmup_started_at`, not from account creation) **and** no hard restriction signal in the last 24 h **and** health band ≥ watch. Band `watch` freezes advancement; band `degraded` rolls back exactly one tier; band `critical` pauses the instance. Skipping the ramp is not purchasable — it is not a plan feature, not a sales lever, and there is no code path that sets `warmup_tier` from a plan entitlement.

**Honest note on the numbers:** these caps and gaps are conservative judgement seeded from Blastup's table (`tiers.ts:11-62`), not measurement. No public, credible source states a safe per-day volume for an unofficial linked device. They are stored in `pacing_warmup_tiers` (data, not code constants) precisely so they can be revised per profile and per country once V1-P8 and real tenant data exist.

## 3.5 The 12-signal health score

Score model: `health_score = clamp(0, 100, 100 − Σ weight_i × severity_i)`, where `severity_i ∈ [0,1]` is piecewise-linear between the good and bad thresholds. Weights sum to 120 so a genuinely bad account floors at 0. Each severity is an EWMA with α = 0.3 over 5-minute evaluation ticks.

| Signal | Measured from | Window | Metric | Weight | severity 0 | severity 1 | Min evidence |
|---|---|---|---|---|---|---|---|
| Hard restriction | `DisconnectReason` 403/402/406, `loggedOut`, restriction stream error | event | boolean | **override** | — | — | none |
| Delivery ratio | `message-receipt.update` → delivered, sends ≥30 min old | 24 h | delivered/sent | 20 | ≥90% | ≤50% | 30 sends |
| Disconnect frequency | `connection.update` close, excluding restrictions and our own restarts | 6 h | count | 15 | ≤1 | ≥8 | none |
| Provider `rate_limited` responses | send outcome class `rate_limited` (fast lane) | 1 h | count | 15 | 0 | ≥5 | none |
| Opt-out (STOP) rate | `opt_outs` inserts attributed to this instance | 24 h | per 1,000 sent | 15 | ≤2 | ≥20 | 100 sends |
| Rejected-send rate | outcome class `rejected_by_provider` | 24 h | failed/attempted | 12 | 0% | ≥5% | 20 attempts |
| Invalid/failed JID rate | `onWhatsApp` miss, `item-not-found` on send | 24 h | invalid/attempted | 10 | ≤1% | ≥10% | 30 attempts |
| Recipient block indicator | message-level 401/403; never-delivering previously-delivering JID | 24 h | per 1,000 sent | 10 | ≤1 | ≥15 | 100 sends |
| Reply rate (soft, capped, exemptible) | `messages.upsert` not `fromMe` from a JID messaged in 72 h | 72 h | replies / new conversations | 10 | ≥8% | ≤0.5% | 50 new convs |
| Cold-outreach ratio (**not** exemptible) | our own ledger | 24 h | new_conv / total | 10 | ≤40% | ≥90% | 50 sends |
| Transient failure rate | outcome class `transient` (fast lane) | 1 h | failed/attempted | 8 | ≤2% | ≥25% | 20 attempts |
| Reconnect churn | `restartRequired`, `connectionReplaced`, QR-refresh loops | 6 h | count | 5 | ≤2 | ≥12 | none |
| Read ratio | receipts → read | 24 h | read/delivered | 5 | ≥40% | ≤5% | 50 delivered |

Three rules keep the score honest. **Minimum evidence**: below the threshold a signal contributes exactly 0 penalty — a brand-new instance with 4 sends is unmeasured, not unhealthy, and warm-up caps (not the score) protect it. **Fast lane**: the hard-restriction override, the `rate_limited` signal and the transient-failure signal are evaluated on every send outcome, not only on the 5-minute tick; any `rate_limited` occurrence forces at least band `watch` within one tick. **Evidence stored**: every score write persists `last_evidence jsonb` with the raw numerator and denominator per signal, so the panel can explain the number and support can audit it.

### Bands, multipliers, hysteresis and dwell

| Band | Score | Cap multiplier | Gap multiplier | New conversations | Warm-up |
|---|---|---|---|---|---|
| healthy | ≥70 | x1.00 | x1.0 | per tier | advances normally |
| watch | 55-69 | x0.70 | x1.5 | x0.5 | frozen |
| degraded | 35-54 | x0.40 | x2.5 | **0** (replies and existing conversations only) | rolled back one tier |
| critical | <35 | — | — | — | instance → **paused** |

Tightening applies on the **first** tick that crosses a threshold: no dwell, no extra smoothing — fail-safe is fast (core invariant 2). Loosening requires all of: score ≥ entry + 8 points of hysteresis (watch→healthy needs 78, degraded→watch needs 63); the score has held above that for a dwell period (2 h for watch→healthy, 6 h for degraded→watch); no hard restriction signal in 24 h; and at most one band improvement per 6 h and two per 24 h, **derived by counting `pacing_events` rows** rather than from a mutable `band_changes_24h` counter. `critical`/`paused` → any sending state is human-only, always (section 3.9). Band flaps are a metric (`wp_pacing_band_flaps_total`); more than 3/day on one instance is an ops alert, because flapping means our thresholds are wrong, not the account.

### What v1 actually scores

**v1 ships the evidence machinery for all twelve signals but scores only three plus the fast lane: hard restriction (override), rejected-send rate, delivery ratio, and the `rate_limited` fast lane.** The other eight are collected, stored and displayed in the "why?" drawer with the label "measured, not yet scored". The reason is honest and worth stating plainly to the founder: the weights above are hand-set guesses with no labelled dataset of accounts that were later banned, and shipping an untuned 12-signal score means throttling paying tenants on a formula we cannot defend. Every hard-signal pause writes a `pacing_events` row of kind `hard_signal_pause` carrying the **complete signal vector, effective limits, warm-up tier, account age and 30-day send history** — one row per restriction, accumulating into exactly the dataset that makes the remaining nine weights tunable after about a month of production data.

## 3.6 Opt-out / STOP registry

Scope defaults to `client`: a STOP to one number stops that person across the tenant's whole account. Per-instance scope is opt-in, audited, and the panel warns that the compliance risk is the tenant's.

Detection normalises inbound text (trim, lowercase, strip punctuation and emoji, collapse whitespace, Devanagari→Latin transliteration) and matches when the message **is** a keyword or **starts with** one and is ≤4 tokens — so "please don't stop sending updates" is not a STOP. Platform keywords include `stop`, `stopall`, `unsubscribe`, `opt out`, `remove me`, `do not message`, `dnd`, `band karo`, `mat bhejo`, `rok do`, `बंद करो`, `रोको`. Tenants may **add** keywords; they may never remove platform ones.

On match, in one transaction: idempotent insert into `opt_outs`, cancellation of every queued job for that contact under the scope (`status='cancelled'`, `cancel_reason='opt_out'` — cancelled, not failed, and **excluded from every health-signal denominator**), a `contact.opted_out` webhook, and exactly **one** confirmation message per contact per 30 days via `SendOrigin.opt_out_confirmation`.

Storage never indexes a raw phone number: `phone_hash = hmac_sha256(pepper_from_key_ring, e164)` is the unique key and the displayable number is envelope-encrypted (see the security section, 4). Enforcement is at three points, because any one alone is a single point of failure: **API creation** (422 `RECIPIENT_OPTED_OUT`, no job row), **claim-time content guard** (the opt-out may have arrived after the job was queued), and **pre-send inside the send transaction** (last defence against a stale cache). Restoring an opt-out requires an authenticated tenant user, a typed reason and an audit row, and the copy states plainly that re-adding someone who asked to stop is the tenant's legal responsibility.

## 3.7 Content-quality guards and frequency caps

| Guard | Rule | Default | Outcome |
|---|---|---|---|
| Duplicate fan-out | `fingerprint = sha256(normalise(body))` (lowercase, URLs replaced by a placeholder token, digits masked, emoji and whitespace stripped, template variables resolved then stripped); distinct recipients counted per `(client_id, local_date, fingerprint)` via `content_fingerprint_recipients` with `ON CONFLICT DO NOTHING`, so re-evaluation can never inflate the count | warn 150, ack 500 | Warn: panel nudge. Ack: jobs stay **queued** with `NEEDS_HUMAN_ACK` until a human confirms — never auto-failed |
| Link in first message | link regex (http/https, `www.`, `t.me/`, `wa.me/`, shorteners, bare `host.tld/path`) against a contact with no `first_inbound_at` | blocked tiers 1-2, warn tier 3, allowed tier 4+ | `failed`, actionable copy, that job only |
| Blocked words | two lists: `platform_blocked_words` (payment fraud, OTP harvesting, lottery, loan-shark, adult, clearly illegal offers — not removable) ∪ `tenant_blocked_words` (additive); word-boundary plus simple leet normalisation | platform on, tenant empty | `failed`, category shown, **never the matched list** (we do not build a filter-tuning oracle); >20 trips/day raises an admin flag |
| Per-recipient frequency | true rolling windows summed from `recipient_send_buckets` hour buckets, enforced **per client** so splitting across instances cannot evade it | 3 / 24 h, 8 / 7 d | stays queued until the window frees |
| Cold-outreach ratio | new conversations ÷ total sends, enforced inside the reserve statement, active only above `cold_ratio_floor` (default 50 sends) so small days are never blocked | 0.40 (tier 1) → 0.80 (steady) | stays queued to next local midnight |

A terminal guard failure continues the inner loop for the same instance up to 25 disposals per pass, so a 1,000-row opted-out list drains immediately rather than one row per full scheduler loop.

## 3.8 The deny-reason table

Every reason the gate can return, with its exact outcome. This table is the specification for `deferJob()` and `failJobFinal()`.

| Deny reason | Job outcome | `next_attempt_at` | attempts | `pacing_deferrals` | Health impact |
|---|---|---|---|---|---|
| `MIN_GAP` | stays queued | `next_eligible_at` | unchanged | +1 | none |
| `DAILY_CAP` | stays queued | next local midnight | unchanged | +1 | none |
| `HOURLY_CAP` | stays queued | next local hour boundary | unchanged | +1 | none |
| `NEW_CONV_CAP` | stays queued | next local midnight | unchanged | +1 | none |
| `COLD_RATIO` | stays queued | next local midnight | unchanged | +1 | none |
| `PLAN_CAP` (client daily) | stays queued | next local midnight | unchanged | +1 | none |
| `OUTSIDE_WINDOW` | stays queued | next window open, local tz | unchanged | +1 | none |
| `PER_RECIPIENT_FREQ` | stays queued | window expiry (hour-bucket exact) | unchanged | +1 | none |
| `NEEDS_HUMAN_ACK` | stays queued + panel banner + email + webhook | null (wakes on ack) | unchanged | +1 | none |
| `INSTANCE_PAUSED` / `NOT_CONNECTED` | stays queued, no reschedule (resume re-runs eligibility) | unchanged | unchanged | +1 | none |
| `GROUP_ACTION_BLOCKED` | `failed` (terminal, tier rule) | — | n/a | — | none |
| `OPT_OUT` | **`cancelled`**, `cancel_reason='opt_out'` | — | n/a | **excluded from every denominator** |
| `BLOCKED_WORD` | `failed`, category-only reason | — | n/a | small penalty if repeated (>20/day) |
| `LINK_IN_FIRST_MESSAGE` | `failed`, actionable copy | — | n/a | small penalty if repeated |
| `NO_LEDGER_ROW` | stays queued, ledger row created, immediate retry | now | unchanged | +0 (non-alerting) | none |
| `PACING_STORE_UNAVAILABLE` | stays queued, instance held | +60 s | unchanged | +1 | none; ops alert |
| `UNKNOWN` | **fail-closed**: stays queued, 60 s instance hold, alert fires | +60 s | unchanged | +1 | none; ops alert |

The dividing line: **timing deferrals are invisible, automatic and lossless; content rejections are final, per-recipient and actionable.** Nothing in this table deletes a job, and nothing in it consumes retry budget except a real send failure, which is the retry matrix's business, not Safe Mode's.

## 3.9 Configuration: tenant, admin, audit

Resolution order, in `packages/domain` (browser-pure, unit-testable):

```
effective = STRICTEST_OF(
    system_profile(profile_key),      -- platform-owned, read-only to tenants
    warmup_tier_limits(tier),         -- time-based ramp
    health_band_multipliers(band),    -- signal-driven tightening
    tenant_tightening(instance)       -- tenant may only make things stricter
) THEN apply admin_relax(instance)    -- explicit, reasoned, expiring, audited
THEN clamp to ABSOLUTE_GAP_MIN_MS / ABSOLUTE_DAILY_CEILING
```

Folding is `Math.min` on caps and ratios, `Math.max` on gaps, window intersection (narrowest wins), and boolean OR on blocks (any layer that blocks, blocks). The result is materialised into `instance_pacing_state.eff_*` columns **in the same transaction** as any profile, warm-up, band or override change, so the reserve statement reads current limits in-statement and a tightening takes effect on the very next reserve — never on a 30-second cache expiry.

| Setting | Tenant may change | Notes |
|---|---|---|
| Turn Safe Mode off | **No** | Not present in UI, API or schema |
| Choose a stricter profile (`conservative`) | Yes | Instant, audited |
| Choose a looser profile | **No** | Platform admin only |
| Lower daily cap, raise min gap, narrow window | Yes | Enforced by the resolver, not by UI validation |
| Raise daily cap, shorten gap, widen window | **No** | Not exposed anywhere |
| Timezone (and window within the profile's) | Yes | One change per 7 days, audited; the old day's `consumed_count` is carried forward with `GREATEST(...)` for 48 h so a timezone change cannot reset a cap |
| Add blocked words / opt-out keywords | Yes | Additive only |
| Remove platform blocked words or keywords | **No** | — |
| Mark instance `engagement_exempt` | Yes + reason | Affects the displayed reason and the warm-up freeze decision only |
| Ack a duplicate fan-out | Yes | Per campaign, audited |
| Resume a paused instance | Yes | The only way out of paused |
| Restore an opt-out | Yes + typed reason | Heavily warned, audited |
| Skip the warm-up ramp | **No** | Not for money, not for a plan tier |

`engagement_exempt` is neutered structurally, not by convention: the flag lives in a type the pacing gate cannot import, and a test asserts `resolveEffective()` returns byte-identical limits with the flag true and false. It never touches the cold-outreach gate, which is our own measurement of sender behaviour rather than a recipient-controlled metric.

**Bounded admin relaxation.** `instance_pacing_overrides(kind='admin_relax')` is the only layer that may loosen. It requires a written `reason`, an `actor_user_id`, and `expires_at ≤ now() + 30 days` (a DB `CHECK` enforces reason and expiry); it is applied **before** the absolute clamp, so `ABSOLUTE_GAP_MIN_MS` and `ABSOLUTE_DAILY_CEILING` (2,000/day) still hold; it writes a `pacing_events` row and notifies the tenant. It is issued through `admin/backend` calling `POST /internal/v1/instances/:id/pacing-override` on `app/backend` — the admin service never writes `pacing_ledger` or `instance_pacing_state` directly (see the repo and ownership section, 1).

**Human-only transitions** (safety-compliance, non-negotiable): `paused → sending` for **every** cause; a restriction pause additionally requires an acknowledgement checkbox confirming the tenant checked the number in the WhatsApp app. `POST /v1/instances/:id/resume` returns 403 for `actor_type='api_key'` and `actor_type='system'` in all cases. Also human-only: loosening beyond the profile, clearing a duplicate fan-out ack, restoring an opt-out. Everything else — tightening, band drops, warm-up advance and rollback, gap changes — is automatic.

Every write to any pacing config table goes through `PacingConfigService.update()`, which in one transaction writes the row, an `audit_logs` row (`action:'pacing.config.change'`, `{field, from, to, reason}`, actor), a `pacing_events` row, and `config_version = config_version + 1`.

## 3.10 Data model, keys, interface and enforcement point

The authoritative grant, one statement, reading its limits in-statement (v1 blueprint, Safe Mode section; `app/backend/src/modules/pacing/gate/reserve.sql.ts`):

```sql
WITH s AS (SELECT * FROM instance_pacing_state WHERE instance_id = $iid AND client_id = $cid),
     d AS (SELECT (now() AT TIME ZONE (SELECT pacing_timezone FROM s))::date AS ledger_date,
                  EXTRACT(hour FROM now() AT TIME ZONE (SELECT pacing_timezone FROM s))::smallint AS hk),
     ins AS (INSERT INTO pacing_ledger (client_id, instance_id, ledger_date, hour_key, next_eligible_at)
             SELECT $cid, $iid, d.ledger_date, d.hk, now() FROM d
             ON CONFLICT (instance_id, ledger_date) DO NOTHING)
UPDATE pacing_ledger l
   SET consumed_count   = l.consumed_count + 1,
       sent_this_hour   = CASE WHEN l.hour_key = (SELECT hk FROM d) THEN l.sent_this_hour + 1 ELSE 1 END,
       hour_key         = (SELECT hk FROM d),
       new_conv_count   = l.new_conv_count + ($is_new_conversation)::int,
       last_reserved_at = now(),
       next_eligible_at = now() + ($gap_ms || ' milliseconds')::interval
  FROM s, d, (SELECT sent_count, (SELECT limit_value FROM effective_client_limits
                                   WHERE client_id = $cid AND limit_key = 'max_daily_sends') AS cap
                FROM client_daily_usage
               WHERE client_id = $cid AND ledger_date = (SELECT ledger_date FROM d)) u
 WHERE l.client_id = $cid AND l.instance_id = $iid AND l.ledger_date = d.ledger_date
   AND l.next_eligible_at <= now()                                          -- min gap
   AND l.consumed_count < s.eff_daily_cap                                   -- daily cap
   AND (CASE WHEN l.hour_key = d.hk THEN l.sent_this_hour ELSE 0 END) < s.eff_hourly_cap
   AND (NOT $is_new_conversation OR l.new_conv_count < s.eff_new_conv_cap)  -- cold-outreach cap
   AND (NOT $is_new_conversation OR l.consumed_count < s.eff_cold_ratio_floor
        OR (l.new_conv_count + 1)::numeric <= s.eff_cold_ratio_max * (l.consumed_count + 1)::numeric)
   AND (u.cap IS NULL OR u.sent_count < u.cap)                              -- plan cap
RETURNING l.consumed_count, l.sent_this_hour, l.new_conv_count, l.next_eligible_at, d.ledger_date;
```

Zero rows is a deny; one cheap follow-up SELECT computes the human-readable reason and `retryAt`. `ledger_date` is computed **inside** the statement from `instance_pacing_state.pacing_timezone`, so no caller-supplied date and no timezone edit can reset a cap. Tables: `pacing_profiles`, `pacing_warmup_tiers`, `instance_pacing_state` (limits and health, **no counters**), `pacing_ledger` (the only counter table), `client_daily_usage`, `instance_pacing_overrides`, `pacing_events`, `opt_outs`, `content_fingerprints` + `content_fingerprint_recipients`, `recipient_send_buckets`, `instance_recipient_contacts` (the single source of `is_new_conversation`). A schema test asserts **exactly one table carries a reserve counter** — that is the guard against pacing dual authority (see the data model section, 2).

Refunds: `release()` is idempotent via `message_jobs.pacing_refunded_at`, joins on the `pacing_ledger_date` returned by the reservation (never a caller-supplied date), carries `client_id`, and restores `next_eligible_at`. `PROVIDER_ATTEMPTED` is **never** refunded — fail-closed, we assume it counted. A losing claim race rolls the whole transaction back rather than compensating. A reservation with no outcome for 5 minutes stays consumed and increments `wp_pacing_orphan_reservations_total`.

Redis, all advisory, all rebuildable, all constructed through `tenantKey()`/`sysKey()` (a raw `wp:` literal outside `platform/redis` is a lint error):

| Key | Type | Value | TTL |
|---|---|---|---|
| `wp:{env}:pace:c:{client}:i:{instance}:next_eligible_ms` | string | epoch-ms mirror of the ledger | 6 h |
| `wp:{env}:pace:c:{client}:i:{instance}:consumed:{yyyy-mm-dd}` | string | mirror counter | `EXPIREAT` next local midnight + 1 h |
| `wp:{env}:pace:c:{client}:i:{instance}:limits:v{version}` | hash | cached `EffectiveLimits` | 300 s |
| `wp:{env}:pace:c:{client}:i:{instance}:hold` | string | short deny hold | 60 s |
| `wp:{env}:pace:c:{client}:i:{instance}:optout:bloom` | bitmap | opt-out hashes; a false positive falls through to Postgres, never a false allow | 24 h, rebuilt nightly |
| `wp:{env}:pace:h:i:{instance}:sig:{name}` | hash | rolling counters for the 5-min tick | 25 h |
| `wp:{env}:pace:events` | pub/sub | `{instance_id, version}` config invalidation | — |

Losing all of Redis costs extra Postgres reads and one cache warm-up. It cannot cause an over-send.

```ts
export type PacingDecision =
  | { ok: true;  reservationId: string; gapMs: number; ledgerDate: string; limits: EffectiveLimits }
  | { ok: false; reason: DenyReason; retryAt: Date | null; terminal: boolean; userMessage: string };

export interface PacingGate {
  admitInstance(ctx: InstanceCtx): Promise<AdmitResult>;                 // cheap, before any job is selected
  reserve(tx: Tx, ctx: InstanceCtx, job: JobCtx, origin: SendOrigin): Promise<PacingDecision>;
  commit(reservationId: string, outcome: SendOutcome): Promise<void>;
  release(reservationId: string, reason: ReleaseReason): Promise<void>;  // idempotent
}
```

**Enforcement point: the gate gates the CLAIM, inside the claim transaction — not the send.** The session-worker loop is: `admitInstance()` (health, window, band, Redis pre-filter — no DB churn when denied) → DWRR band pick → `BEGIN` → select the next eligible job `FOR UPDATE SKIP LOCKED LIMIT 1` → `contentGuards.evaluate()` → `pacing.reserve()` → the canonical claim UPDATE in `db/queries/claim-jobs.sql` → `COMMIT`. Any failure after the reserve rolls the reservation back with the transaction. Gating at send time instead would leave a job sitting in `processing` while the worker sleeps out the gap, holding a claim lease for nothing, making queue-depth metrics lie, and burning a wasted attempt if the worker dies mid-sleep. The review checklist question is: *does the reservation happen in the same transaction as the claim, and does the claim statement itself carry the fence, health, epoch, client and plan predicates?* Anything checked outside the UPDATE is a reject.

Metrics: `wp_pacing_reserve_total{result,reason}`, `wp_pacing_gap_ms_bucket`, `wp_pacing_deferrals_total{reason}`, `wp_health_score{instance}`, `wp_health_band_changes_total{from,to,direction}`, `wp_pacing_band_flaps_total`, `wp_optout_blocks_total`, `wp_content_guard_trips_total{guard}`, `wp_pacing_orphan_reservations_total`, `wp_pacing_ledger_repair_total`. Alerts: any hard-signal pause; >3 flaps/day on one instance; orphan reservations >0.5% of sends; a nightly ledger repair correcting by >5 units; opt-out rate >10 per 1,000 for any client (that is a content problem we should tell them about before WhatsApp does). Nightly reconciliation recomputes `consumed_count` from `message_jobs` and repairs with `GREATEST(ledger, computed)` — it can only move counters **up**, so a repair can never grant extra sends.

## 3.11 Panel UX and exact copy

```
┌ Sales – +91 98xxx xxx21 ──────────────────────── ● Sending ─┐
│ Safe Mode: Standard · Warm-up 3 of 6 (day 9)                │
│ Today   ███████████░░░░░░░░  84 / 150 messages              │
│ New conversations  ████░░░░░  12 / 40                       │
│ Next send  in 00:23   ·   Sending window 09:00–20:00 IST    │
│ Health  82 / 100  HEALTHY   [why?]                          │
│ Queued 1,240 · oldest 6 m · last send 2 m ago               │
└─────────────────────────────────────────────────────────────┘
```

The "why?" drawer lists every signal with its measured value, window, whether it is currently penalising, how many points it costs, and its evidence — e.g. `Delivery ratio 71% (last 24h, 412 of 580) — costing 9 points`, `Reply rate — measured, not yet scored`, `Reply rate — not counted (instance marked notification-only on 12 Aug by Priya)` — plus the score sparkline and the `pacing_events` timeline. Never a bare number without reasons.

All strings live in one `copy.ts` as i18n keys (en/hi) and are tested against `BANNED_CLAIMS`:

```ts
export const PACING_COPY = {
  instance_paused_connection:
    "Sending paused. WhatsApp connection is temporarily unavailable for this number. " +
    "Your {queued} queued messages are safe and will resume when you reconnect. Nothing has been lost.",
  instance_paused_restriction:
    "Sending paused — WhatsApp returned a restriction signal for this number. " +
    "We have stopped all sending on it and kept your {queued} queued messages. " +
    "Please open WhatsApp on the phone for this number, check for any notice from WhatsApp, " +
    "and resolve it there. Sending will not restart by itself — you must resume it here after you have checked.",
  instance_paused_logged_out:
    "This number is logged out of WP. Sending is paused and your {queued} queued messages are preserved. " +
    "Scan the QR code again to reconnect.",
  cap_daily_reached:
    "Daily limit reached — {sent} of {cap} messages sent today. " +
    "The remaining {queued} messages stay queued and will start sending automatically at {resetLocal}.",
  cap_new_conversations_reached:
    "New-conversation limit reached for today ({sent} of {cap}). " +
    "Replies and messages to people you already talk to keep sending normally; " +
    "first messages to new contacts resume at {resetLocal}.",
  cap_outside_window:
    "Outside your sending hours ({windowStart}–{windowEnd} {tz}). " +
    "{queued} messages are queued and will start at {windowStart}.",
  warmup_in_progress:
    "Warm-up {tier} of 6 — day {day}. New numbers send slowly on purpose: " +
    "today's limit is {cap} messages with a {gapMin}–{gapMax}s gap between them. " +
    "Limits increase on {nextStepDate} if this number stays healthy. " +
    "This lowers the risk of spam signals from a cold number; it is not a guarantee.",
  warmup_frozen_watch:
    "Warm-up is on hold while this number's health recovers. Current limits stay in place. " +
    "We will look again in {hours} h.",
  health_watch:
    "We are watching this number. Health {score}/100 — {topReason}. " +
    "Limits have been reduced to {cap} messages a day and the gap between messages increased " +
    "while things settle. No action needed from you yet.",
  health_degraded:
    "This number's health has dropped to {score}/100 — {topReason}. " +
    "We have cut today's limit to {cap}, slowed sending, and stopped new first-time conversations. " +
    "Replies to people who messaged you keep working. Your queued messages are safe. " +
    "Reviewing your recent message content and recipient list is the fastest way to recover.",
  health_critical_paused:
    "Sending paused automatically — this number's health is {score}/100 ({topReason}). " +
    "All {queued} queued messages are preserved. Please review your recent sending, " +
    "then resume when you are ready. We do not restart sending on our own.",
  content_optout_blocked:
    "Not sent — this person asked to stop receiving messages from you on {date}.",
  content_duplicate_ack:
    "{count} recipients are set to receive an identical message. " +
    "Identical bulk text is a common spam signal. Vary the message, or confirm you want to send it as-is.",
  content_link_first_message:
    "Not sent — this is your first message to this contact and it contains a link. " +
    "Links in a first message are a common spam-report trigger. Send an introduction first, " +
    "or wait until Warm-up 4.",
  disclaimer: SAFE_MODE_DISCLAIMER,
} as const;
```

Every string says what happened, what is preserved, when it resumes, and what the user can do. None promises anything about bans.

## 3.12 The tests that prove it

Named before the code (full list and amendments in the testing section, 8):

1. **`reserve_is_atomic_under_50_parallel_claims`** — 50 concurrent reserves on one instance with `daily_cap=10` and `hourly_cap=4` against real Postgres, 200 iterations: exactly 10 grants, 40 denies, `consumed_count = 10`, hourly cap never exceeded. This is the concurrency test Blastup does not have, and it is the proof that caps cannot be exceeded.
2. `two_workers_cannot_double_claim_one_job` — the loser's transaction rolls back and the ledger returns to its pre-claim value.
3. `min_gap_is_never_violated_under_parallelism` — 200 mixed sequential/parallel sends; every inter-reserve delta ≥ `gap_min_ms`, zero below the floor.
4. `drawGapMs_is_bounded` + `applyLongPause_cadence` — seeded RNG, min ≥ `gap_min_ms`, max ≤ `gap_max_ms`, long pause fires within 18-35 sends at 4-9x.
5. `new_conversation_cap_and_cold_ratio_are_atomic`.
6. `deferral_never_increments_attempts_or_fails_the_job` — every deny reason in section 3.8.
7. `daily_cap_resets_at_local_midnight_not_utc` (+ a DST case) and `timezone_change_cannot_reset_the_daily_cap`.
8. `warmup_progresses_on_time_not_on_reply_rate` — 0% replies for 40 simulated days still reaches steady; every step wrote `pacing_events` + `audit_logs`.
9. `warmup_freezes_in_watch_and_rolls_back_in_degraded`.
10. `hard_restriction_signal_pauses_immediately` — zero further claims, all queued jobs still queued, notification + webhook emitted.
11. `paused_instance_never_auto_resumes` — 72 simulated hours with a perfect score after a restriction pause; API-key and system-actor resume attempts both 403.
12. `signal_driven_tightening_reduces_caps`; `tightening_takes_effect_on_the_very_next_reserve`.
13. `hysteresis_and_dwell_prevent_flapping`.
14. `reply_rate_alone_cannot_leave_healthy_or_pause`; `min_evidence_protects_new_instances`.
15. `optout_hard_blocks_at_all_three_points` (including that an exempt `system_reply` origin is still blocked); `optout_keyword_matching_precision`; `optout_cancels_queued_jobs_and_is_idempotent` (asserting `cancelled`, not `failed`).
16. `duplicate_fanout_holds_not_fails`; `blocked_word_and_first_message_link_fail_only_that_job`; `per_recipient_frequency_is_enforced_across_instances` (crossing local midnight).
17. `tenant_can_tighten_never_loosen` — property test over random tenant **and** admin patches: the absolute floor/ceiling always holds, and no tenant-settable field (including `engagement_exempt` and `pacing_timezone`) can raise `dailyCap` or lower `gapMinMs` through any path, including the health band.
18. `send_origin_cannot_be_supplied_by_a_client` — payload, header and DTO variants all rejected; static analysis confirms the exempt enum members appear only under `pacing/internal/`.
19. `pause_preserves_work_end_to_end` — pause mid-batch of 500: 0 lost, 0 failed, 0 duplicated (the core invariant 5 regression test).
20. `postgres_is_authoritative_when_redis_is_wrong`; `redis_outage_degrades_but_never_over_sends`; `postgres_outage_stops_sending_and_loses_nothing`; `orphan_reservation_is_not_refunded`; `reserve_is_rolled_back_when_no_job_is_claimed`; `refund_after_local_midnight_hits_the_right_day`; `first_reserve_of_a_new_local_day_grants_without_a_hold`.
21. `tenant_isolation_on_every_pacing_table` — pgTAP, including the background evaluator's own queries.
22. **`no_forbidden_mechanism_exists`** — a static assertion over the whole backend tree: no identifier or string matching `/rotateNumber|numberRotation|proxyPool|rotateProxy|fingerprintSpoof|deviceSpoof|autoResume|bypassPacing|failoverNumber/i`; no config key can raise a limit; no code path transitions out of `paused` without an `actor_user_id`; the resume handler's authz guard names a user principal. It fails the build, not a nightly report.
23. `copy_contains_no_banned_claims` — every string in `copy.ts`, the panel, the docs and the website, plus the `SAFE_MODE_DISCLAIMER` co-presence assertion; `no_pii_in_pacing_logs` — no E.164, JID or body in any pacing log line.

Load check, part of the scale proof (V1-P8): 1,000 simulated instances on the steady profile for 8 hours, asserting **zero cap violations** and p99 `reserve()` under 25 ms.

## 3.13 What Safe Mode cannot do

For the founder, plainly:

1. **It cannot prevent a ban.** Sender-side pacing addresses only the volume, velocity and coldness subset of ban risk. WhatsApp also acts on recipient reports and blocks, content classification, account and device reputation, IP history and policy changes — none of which we can observe or control. A perfectly paced account sending content people report will still be restricted.
2. **The health score is inferred, not told to us.** There is no reputation API for a linked device. Delivery ratio, disconnect codes and reply rate are proxies; the score can be green the hour before a restriction and red because of a stale recipient list rather than real risk.
3. **v1 scores three signals, not twelve.** The other nine are measured, stored and shown, but not weighted, because the weights are untuned guesses with no ban-outcome dataset. Anyone reading "12-signal health score" in a spec should read "12 signals collected, 3 plus a fast lane scored in v1".
4. **The tier numbers are judgement, not measurement.** They are conservative guesses seeded from a competitor's table and must be revised with our own data, per profile and per country.
5. **A restriction can arrive with no warning.** Our first knowledge is usually the 403 disconnect itself. We pause fast; we cannot pre-empt.
6. **Safe Mode reduces throughput on purpose.** A single steady number sends roughly 600-1,000 messages a day, not tens of thousands. A tenant expecting bulk-blast volume will be disappointed, and that is the correct outcome — the honest answer is more numbers, each properly warmed, not looser limits.
7. **Warm-up cannot rehabilitate a burned number.** Starting Safe Mode on an already-restricted number restores nothing.
8. **Automatic tightening can hurt an innocent tenant.** A bad ISP hour can push a legitimate instance to `degraded` and cut its cap by 60%. Hysteresis limits flapping, not false positives; the only dispute path in v1 is `engagement_exempt` (which covers reply rate only) and an admin relaxation.
9. **We will refuse the things that would "work" short term.** Number rotation after a restriction, proxy pools, fingerprint spoofing, auto-resume — permanently out of scope. If a competitor appears to outperform us on ban rates, this is the most likely reason, and we will not match it.

For product copy, all of the above compresses to `SAFE_MODE_DISCLAIMER`. Nothing stronger is ever written, in any language, on any surface.


---

# 4. Data model, security and tenant isolation

One PostgreSQL 17 database (`db/`) is the sole source of truth. `app/backend` owns every DDL statement and every write to the send path; `admin/backend` connects to the same database as a different role that can read (registry-listed) and mutate only through `/internal/v1` (ADR 0014). Redis is strictly rebuildable. This section specifies the schema table by table, the two SQL statements that make the queue safe (the claim and the reaper), the four isolation layers, envelope encryption, auth, hardening, privacy defaults, the threat model, and an honest answer to the founder's "0 gap, 0 issue".

Everything here is built in phases V1-P1 (data model, migrations, tenant isolation proof) and V1-P3 (encrypted auth state), with the hardening items landing across V1-P2, V1-P4 and V1-P7.

## 4.1 Conventions and ownership

Fixed conventions, enforced by lint and by the migration review checklist (`2026-08-25-v1-architecture-blueprint.md`):

1. `timestamptz` in UTC everywhere; local time exists only as a pacing input, never as a stored instant.
2. `client_id uuid NOT NULL` on every tenant-owned table, and it is the **first column of every tenant index** so the index is usable for the tenant predicate.
3. Enum labels are `lower_snake` in the database and are mirrored into `@wp/domain` with an equality test, so a drifted label is a build failure rather than a silent zero-row claim.
4. Tenant-facing ids are UUIDv7; high-volume internal rows use `bigint identity`. A bigint exposed over the API would leak our total message volume.
5. No `SELECT *` on any table holding a secret or a blob (lint rule), which is one of the four reasons session credentials live in their own tables.
6. `set_config('app.client_id', …, true)` only — a plain `SET` is a lint error, because under PgBouncer transaction pooling a session-level `SET` leaks one tenant's context onto the next tenant's query.

Canonical enums (defined once in `db/`):

```sql
CREATE TYPE job_status AS ENUM
  ('created','queued','processing','sent','failed','cancelled','needs_reconcile','blocked_needs_review');
CREATE TYPE wa_health     AS ENUM ('never_linked','connected','degraded','paused','logged_out');
CREATE TYPE wa_link_state AS ENUM ('unlinked','pairing','linked');
CREATE TYPE attempt_state AS ENUM
  ('prepared','dispatched','acked','failed','reconciled_sent','reconciled_lost','abandoned');
CREATE TYPE job_kind      AS ENUM ('text','media','reply');   -- no 'template': Baileys has none
CREATE TYPE pause_reason  AS ENUM ('user_action','provider_restriction','repeated_send_failure',
  'health_critical','reconnect_failed','pairing_expired','session_replaced','unknown_signal','admin_action');
```

## 4.2 Tenancy and identity

| Table | Key columns | Notes |
|---|---|---|
| `clients` | `id` uuidv7, `name`, `slug citext UNIQUE`, `status` (`pending_verification/active/suspended/closed`), `country_code`, `timezone`, `plan_id`, `onboarding_step`, `deleted_at` | ~1,000 rows at target; retained for the life of the account |
| `users` | `id`, `email citext UNIQUE`, `email_verified_at`, `password_hash`, `mfa_totp_secret_enc bytea`, `failed_login_count`, `locked_until`, `status` | **deliberately not tenant-owned** (one human, many clients — agencies are the norm in India); allow-listed in the isolation suite with a written reason |
| `memberships` | `UNIQUE(client_id,user_id)`, `role owner/admin/agent/viewer`, `status` | the tenant edge; `INDEX(user_id)` serves "which tenants am I in" at login |
| `instance_grants` | `UNIQUE(client_id,user_id,instance_id)`, `can_view/can_send/can_manage` | second permission dimension: an agent sees only assigned numbers. Owner/admin are implicitly all-instances (no rows) |
| `invites` | `token_hash bytea UNIQUE`, `expires_at`, `accepted_at`, `revoked_at` | raw token never stored; delete 90 days after accept/expiry |
| `auth_sessions` | `refresh_token_hash bytea UNIQUE`, `parent_session_id` (rotation chain), `ip inet`, `user_agent_hash`, `revoked_at`, `revoked_reason` | hashed and revocable; UA is hashed, not stored — a raw UA string is both a fingerprinting surface and a log-PII hazard |
| `api_keys` | `key_hash bytea UNIQUE`, `key_prefix`, `key_last4`, `scopes text[]`, `instance_id NULL`, `last_used_at`, `revoked_at` | **there is no `key` column** — the direct fix for Blastup storing the raw key next to its hash (`models/ApiKey.ts:21-24`, `2026-08-25-v1-design-data-and-security.md`) |
| `user_credentials` | WebAuthn `credential_id`, `public_key`, `sign_count` | table created in v1 migrations even though passkeys ship slightly later, so no migration on a live table is needed |
| `staff_users`, `staff_sessions`, `impersonation_grants` | separate tables, separate cookie name, separate domain; `reason text NOT NULL` + `expires_at` on grants | staff sessions must never be interchangeable with tenant sessions; support access is time-boxed, reasoned and visible to the tenant |
| `plans`, `plan_limits`, `client_limit_overrides` | `limit_key ∈ max_instances, max_daily_sends, max_members, max_api_keys` | v1a: created in the initial migration because limits must exist before real tenant data does; billing is v2 |

`clients.onboarding_step ∈ ('verify_email','choose_timezone','accept_pacing_profile','attest_consent','connect_whatsapp','send_test','done')`. "Connect WhatsApp" unlocks only after email verification, a timezone, an assigned pacing profile and a recorded consent attestation — an entitlement check, never a hidden button.

## 4.3 Instances and session credentials

`whatsapp_instances` (FILLFACTOR 80, because status columns update constantly) carries three orthogonal state fields that are never collapsed: `connection_status` (what Baileys says), `health_state` (what WP policy decided) and `desired_state` (`online`/`offline`, the tenant's intent and the lever behind the capacity story in V1-P8). Collapsing the first two — as both reference repos do — makes "the socket is open but we paused you" inexpressible. Plus `link_state`, `session_epoch int`, `current_fence bigint NOT NULL DEFAULT 0`, `owner_worker_id`, `lease_seen_at`, `needs_user_action`/`user_action_reason`, `qr_attempts`, `pairing_started_at`, `pause_reason`/`paused_at`/`paused_by_user_id`, `disconnection_reason_code/label/at`, `last_connected_at`, `last_success_send_at`, `last_error_class`, `capture_groups`, `capture_media`, `deleted_at`.

Indexes: `(client_id, deleted_at)`, `(health_state) WHERE deleted_at IS NULL`, `UNIQUE(client_id, phone_e164) WHERE deleted_at IS NULL`.

`health_score` lives **only** on `instance_pacing_state` and is written only by the pacing evaluator; `health_state` is written only by the health service. A test asserts no other module writes either column — two writers of a health value is how a "paused" instance silently starts sending again.

`session_epoch` is why a job queued against session N cannot be delivered by session N+1 after a relink: the epoch is a predicate inside the claim (4.6), not an application check.

Credentials live in two dedicated tables, not a column on `whatsapp_instances`:

```sql
CREATE TABLE whatsapp_session_credentials (
  instance_id uuid PRIMARY KEY REFERENCES whatsapp_instances ON DELETE CASCADE,
  client_id uuid NOT NULL,
  ciphertext bytea NOT NULL, iv bytea NOT NULL, auth_tag bytea NOT NULL,
  dek_wrapped bytea NOT NULL, dek_iv bytea NOT NULL, dek_tag bytea NOT NULL,
  kek_id text NOT NULL, enc_version smallint NOT NULL DEFAULT 1,
  session_epoch int NOT NULL, cred_version bigint NOT NULL DEFAULT 0,
  owner_fence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(), rotated_at timestamptz);

CREATE TABLE whatsapp_session_keys (
  instance_id uuid NOT NULL, client_id uuid NOT NULL,
  key_type text NOT NULL, key_id text NOT NULL,
  -- identical crypto column set, plus updated_at
  PRIMARY KEY (instance_id, key_type, key_id),
  CHECK (key_type IN ('pre-key','app-state-sync-key','app-state-sync-version')));
```

Four reasons a separate table beats an encrypted column on `whatsapp_instances`: a `SELECT *` on the instances table (which will happen — panel, background job, admin tool) can never return ciphertext or leak blob size; key blobs rewrite constantly and would destroy the hottest small table's HOT-update behaviour; separate tables get separate `GRANT`s, so the API role is denied `SELECT` on credentials outright; and logout is a table-scoped `DELETE`, not a nullable-column dance. FILLFACTOR 70 with aggressive autovacuum on the keys table.

High-churn `session`, `sender-key` and `sender-key-memory` material is **Redis-only**, still envelope-encrypted, TTL 30 days — it is rebuildable by WhatsApp's own protocol, and putting it in Postgres would turn a ~30-60 writes/s workload into thousands. Non-rebuildable material never lives only in Redis. On `logged_out`, both tables are deleted, `session_epoch` is incremented, the health transition is written and the audit row is inserted — one transaction. `setKeys` and `purge` take and enforce a fence, so a stale owner cannot destroy a live session.

## 4.4 The durable queue, and why uniqueness lives in side tables

`message_jobs` is partitioned monthly by `created_at`, PK `(id, created_at)`, `id bigint GENERATED ALWAYS AS IDENTITY`, FILLFACTOR 70. The job reference tuple everywhere is `(message_job_id, message_job_created_at)`; there are **no foreign keys to `message_jobs`** (an FK to a partitioned parent must carry the partition key, which would push a composite into every referencing table).

Columns: `client_id`, `instance_id`, `session_epoch`, `campaign_id`, `recipient_jid`, `recipient_e164`, `recipient_hash`, `payload jsonb CHECK (octet_length(payload::text) <= 2048)`, `payload_kind job_kind`, `priority`, `priority_rank smallint`, `status job_status`, `scheduled_at`, `next_attempt_at`, `attempts smallint CHECK (attempts >= 0 AND attempts <= max_attempts + 1)`, `max_attempts`, `lease_owner`, `lease_id uuid`, `owner_fence bigint`, `leased_at`, `lease_expires_at`, `sent_at`, `failed_at`, `terminal_at`, `cancel_reason`, `last_error_class`, `pacing_reserved_at`, `pacing_refunded_at`, `pacing_ledger_date date`, `pacing_deny_reason`, `pacing_deferrals int`, `is_new_conversation bool`, `content_fingerprint bytea`, `send_origin`, `needs_user_action bool`, `created_by_user_id`, `created_by_api_key_id`, plus `CHECK (status <> 'sent' OR sent_at IS NOT NULL)`.

```sql
CREATE INDEX message_jobs_claim_idx ON message_jobs
  (client_id, instance_id, priority_rank, next_attempt_at, id) WHERE status = 'queued';
CREATE INDEX message_jobs_lease_idx ON message_jobs (lease_expires_at) WHERE status = 'processing';
CREATE INDEX message_jobs_reconcile_idx ON message_jobs (client_id, instance_id, terminal_at)
  WHERE status IN ('needs_reconcile','blocked_needs_review');
CREATE INDEX message_jobs_list_idx ON message_jobs (client_id, instance_id, created_at DESC, id DESC);
CREATE INDEX message_jobs_recip_idx ON message_jobs (client_id, recipient_hash, sent_at DESC);
```

**Every uniqueness authority lives in a non-partitioned side table.** A `UNIQUE` constraint on a partitioned table *must include the partition key*, so `UNIQUE(client_id, idempotency_key)` on `message_jobs` would silently become unique **per month** — a client retrying a POST across a month boundary would get a second real message on a real person's phone. That is not a theoretical defect; it is the single most expensive class of bug this product can produce. The fix is four small, unpartitioned tables:

```sql
CREATE TABLE message_job_refs (              -- API idempotency + content dedupe
  public_id uuid PRIMARY KEY,                -- uuidv7, the ONLY id we expose
  client_id uuid NOT NULL, instance_id uuid NOT NULL,
  message_job_id bigint NOT NULL, message_job_created_at timestamptz NOT NULL,
  idempotency_key text, dedupe_key text, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX mjr_idem_uq   ON message_job_refs (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX mjr_dedupe_uq ON message_job_refs (client_id, instance_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE message_wa_ids (client_id uuid NOT NULL, instance_id uuid NOT NULL,
  wa_msg_id text NOT NULL, message_id bigint NOT NULL, message_created_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, instance_id, wa_msg_id));

CREATE TABLE delivery_event_ids (provider_event_id text PRIMARY KEY, client_id uuid NOT NULL,
  message_job_id bigint, message_job_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
```

`send_attempts` is also **not partitioned** (it is small and its retention is a bounded `DELETE`), which is what makes `UNIQUE(message_job_id, attempt_no)` a real global constraint: `id bigint identity, client_id, instance_id, message_job_id, message_job_created_at, lease_id uuid, owner_fence bigint, attempt_no smallint, content_hash bytea, client_msg_id text NULL, state attempt_state, provider_msg_id, error_class, prepared_at, dispatched_at, resolved_at`, indexed on `(client_id,instance_id,state,dispatched_at)` for in-flight work, `(instance_id, content_hash)` for reconciliation, `(message_job_id, lease_id)` for the reaper join.

Idempotency scope is **per client** — two tenants may legitimately both use `order-123`. `dedupe_key = sha256(instance_id ‖ recipient ‖ normalised_body ‖ floor(now/24h))`, so the dedupe window is baked into the key and expiry is just row cleanup. The insert path is one transaction: job row + ref row + outbox event + audit row; a conflict on `mjr_idem_uq` returns the **original** job rather than creating anything.

Note one honesty correction against the earlier design: `client_msg_id` is **nullable and unused for correctness in v1**. We do not self-mint Baileys message ids unless a spike proves WhatsApp deduplicates on a caller-supplied id and echoes it back. Until that spike passes, no user-facing copy may claim duplicates are impossible.

`delivery_events` is append-only, weekly partitions, 90-day retention, with a real `event_type` enum (evolution-api's free-string status field is the anti-pattern) and `detail jsonb` capped at a ~250-byte normalised subset. `provider_event_id = sha256(instance_id ‖ external_id ‖ event_type ‖ event_ts ‖ participant_jid)` — the participant must be included or group receipts collide. `analytics_rollup_daily` (PK `(client_id, instance_id, day)`) is what the panel charts read; charts never scan `delivery_events`.

## 4.5 Pacing, compliance, inbox, audit

Full pacing design belongs to Safe Mode (V1-P5); the data-model facts that bind this section are: `pacing_ledger` (PK `(instance_id, ledger_date)`) is the **only** counter and the only grantor; `instance_pacing_state` holds warm-up tier, health score/band and *materialised effective limits* but **no counters**; `client_daily_usage` enforces the plan cap through the same statement; tenant tightening and admin relaxation live only in `instance_pacing_overrides`. The deleted `instance_pacing_profiles.enabled` column matters here: an off-switch column is a Safe-Mode bypass one `UPDATE` away, so the column does not exist.

`opt_outs` stores `phone_hash = hmac_sha256(pepper_from_key_ring, e164)` plus an envelope-encrypted display value — **no raw phone number is ever indexed**. Opt-outs are never deleted while the client exists; a DSAR erasure leaves a hash-only tombstone, the standard suppression-list carve-out. `consent_records` records `basis`, evidence reference, attesting user and timestamp.

Inbox tables are bounded by construction: `contacts`/`chats` on `UNIQUE(client_id, instance_id, jid)`, `messages` partitioned monthly storing the **rendered body only** — never `rawMessage`, which both reference repos store forever and both grow unbounded. `media_assets` holds a private object-store key built only by `storage.put()`; there is no static mount.

`audit_logs` is partitioned monthly with a 24-month floor and is never auto-dropped. `metadata jsonb` accepts **allow-listed keys only**, and the row is written **in the same transaction as the change it records** — an audit row that can be lost independently of its change is not an audit row.

Retention defaults, all overridable per client via `retention_policies`, all implemented as partition `DETACH`/`DROP` rather than bulk `DELETE`:

| Table | Default | Mechanism |
|---|---|---|
| `message_jobs` | 13 months | DETACH → Parquet to object storage, then DROP |
| `send_attempts` | 13 months | bounded DELETE (unpartitioned by design) |
| `delivery_events` | 90 days | roll into `analytics_rollup_daily`, DROP partition |
| `messages`, `media_assets` | 24 months | DROP partition / object-store lifecycle |
| `analytics_rollup_daily` | 25 months | DELETE (small) |
| `audit_logs` | 24-month floor | manual policy only, never auto-dropped |
| `auth_sessions` | 30 days past expiry | cron DELETE |
| `webhook_deliveries` | 30 days | DROP partition |
| `instance_health_samples`, `pacing_events` | 90 days / 12 months | DROP partition |
| `opt_outs`, `consent_records` | life of the client | never auto-deleted |
| session credentials | until logout/unlink | DELETE on `logged_out` |

## 4.6 The claim and the reaper

The claim is **one SQL file**, `db/queries/claim-jobs.sql`, referenced and never re-transcribed. It runs inside the claim transaction after the content guards and after `pacing.reserve()` has granted a unit in the same transaction:

```sql
WITH eligible AS (
  SELECT j.id, j.created_at
    FROM message_jobs j
    JOIN whatsapp_instances i ON i.id = j.instance_id
    JOIN clients c            ON c.id = j.client_id
   WHERE j.client_id       = $client_id
     AND j.instance_id     = $instance_id
     AND j.status          = 'queued'
     AND j.priority_rank   = $band
     AND j.next_attempt_at <= now()
     AND j.scheduled_at    <= now()
     AND i.current_fence   = $fence          -- caller currently owns the session
     AND i.health_state    = 'connected'     -- paused/degraded produces zero claims
     AND i.session_epoch   = j.session_epoch -- no wrong-number send after a relink
     AND i.deleted_at IS NULL
     AND c.status          = 'active'        -- suspension stops claims
   ORDER BY j.next_attempt_at, j.id
   FOR UPDATE OF j SKIP LOCKED
   LIMIT 1)
UPDATE message_jobs j
   SET status='processing', lease_owner=$worker, lease_id=gen_random_uuid(),
       owner_fence=$fence, leased_at=now(),
       lease_expires_at = now() + ($claim_expiry_ms || ' ms')::interval,
       pacing_reserved_at = now(), pacing_ledger_date = $ledger_date, updated_at = now()
  FROM eligible e
 WHERE j.id = e.id AND j.created_at = e.created_at AND j.status = 'queued'
RETURNING j.id, j.created_at, j.lease_id, j.instance_id, j.session_epoch,
          j.recipient_jid, j.payload, j.payload_kind, j.attempts;
```

**Why two workers can never claim one job — four independent reasons, any one of which suffices:**

1. `FOR UPDATE … SKIP LOCKED` takes a row-level write lock inside the CTE. A competing transaction does not block and does not see the row; it skips it. Only one transaction holds that lock.
2. The outer `UPDATE … WHERE j.status = 'queued'` re-evaluates the predicate against the *committed* row version at update time. Under READ COMMITTED, if a competitor committed a status change between the CTE snapshot and the update, the update matches zero rows and the claim simply returns nothing.
3. `i.current_fence = $fence` means only the current lease holder can claim at all. The fence is minted in **Postgres** (`UPDATE whatsapp_instances SET current_fence = current_fence + 1 … RETURNING`), not Redis, so a Redis flush costs one takeover cycle rather than allowing a stale owner to keep writing.
4. `lease_id` is regenerated on every claim and every `send_attempts` row carries it under `UNIQUE(message_job_id, attempt_no)`, so a resurrected worker cannot write an attempt row for an attempt number the new claimer already used.

Three rules keep this the only claim: `attempts` is **not** incremented here (it increments exactly once, with the `send_attempts` INSERT, so a prepared-but-never-dispatched attempt does not consume the retry budget); ordering is by `next_attempt_at` within a band chosen by the deficit-weighted selector, and `ORDER BY priority_weight DESC` is banned as starvation; `LIMIT 1`, because per-instance concurrency is 1 and the minimum gap depends on it. The review checklist question is literal: *does the claim statement itself carry the fence, health, epoch, client and plan predicates?* Checked outside the UPDATE means reject.

The reaper runs every 15 s and is the reason a crash never blind-retries. It joins `send_attempts` on `(message_job_id, message_job_created_at, lease_id)` — partition-aligned — and branches on the attempt state for **that exact lease**: no row or `prepared` ⇒ the provider was never contacted ⇒ back to `queued` (with `attempts` decremented for `prepared` only; decrementing the no-row case would drive the counter negative and create an unbounded-retry path); `dispatched` ⇒ outcome unknown ⇒ `needs_reconcile`, never a resend; `acked` ⇒ the send succeeded and only the job update was lost ⇒ repair to `sent` with `sent_at` and a `reconciled` delivery event; `failed` ⇒ `queued` with backoff. A `needs_reconcile` job gets a 10-minute evidence window against the echo of our own `fromMe` messages; ambiguity resolves **nothing** (both candidates go to `blocked_needs_review`); expiry produces a human choice of "Retry (may duplicate)" / "Discard (may have been delivered)" with an `actor_user_id` on the audit row. There is no automatic requeue.

## 4.7 Tenant isolation: four layers, and the paths that actually leak

| Layer | Mechanism | Catches |
|---|---|---|
| 1. App (primary) | `TenantDb`; every repo function takes `ctx: TenantContext` first; a raw `db.select()` outside `platform/db` is a lint error | ~everything in normal code |
| 2. Build-time | `scripts/check-tenant-scope.ts`: a query against a `client_id` table with no `client_id` predicate fails the build unless `file:symbol` is registered in `CROSS_TENANT_QUERIES` with role, reason and projected columns | the missed `WHERE`, before it ships |
| 3. RLS backstop | `ENABLE` + **`FORCE` ROW LEVEL SECURITY**, `USING (client_id = current_setting('app.client_id', true)::uuid)`; `wp_app` has no `BYPASSRLS` | the query that got past 1 and 2 |
| 4. Role separation | `wp_app`, `wp_scheduler` (narrow SELECT on named columns only), `wp_admin_app` (BYPASSRLS **SELECT**, with INSERT/UPDATE/DELETE revoked on all send-path tables), `wp_migrator` (DDL only) | silent insider reads and a second writer |

`current_setting('app.client_id', true)` returns NULL when unset, and `NULL = client_id` is NULL, so **an unset context returns zero rows**. That is the structural answer to Blastup's `req.user?.id || 'default'` pattern: there is no default to fall back to, and absence yields nothing rather than everything.

Context propagation is where both reference repos actually leaked — not on HTTP routes, but on background paths (Blastup's `handleChatbotAutoResponse` ran a query with no instance filter on a socket-event path):

| Origin | Where `clientId` comes from | Fail-closed rule |
|---|---|---|
| HTTP (session) | membership resolved from the session, cross-checked against the route's `client_id` | mismatch ⇒ 404, never 403-with-data (do not confirm existence) |
| HTTP (API key) | `api_keys.client_id` only, never a body/header/query field | a request naming another client ⇒ 404 |
| Send worker | the **claimed job row's** `client_id`; `withTenant` is entered per job, not per loop | a worker may hold a lease only for an instance whose `client_id` matches |
| Baileys inbound events | the instance registry entry the socket was created from, carried on the socket wrapper | an event for an unknown instance is dropped and counted, never processed under a guessed context |
| Cron (reaper, reconciler, retention, rollups) | iterate per client, entering `withTenant` each time; the cross-tenant worklist runs as `wp_scheduler` with an explicit id-only projection | a cron needing a cross-tenant scan must be in `CROSS_TENANT_QUERIES` or the build fails |
| Realtime (SSE) | channel `wp:{env}:rt:c:{client}:i:{instance}`, authorised at connect and re-checked on membership change and `token_epoch` bump | membership revoked ⇒ socket dropped within 5 s |
| Outbound webhook | the endpoint row's `client_id`; payload assembled inside `withTenant` | never from a cached object built elsewhere |

The scheduler role is the honest version of "the worker bypasses RLS": `wp_scheduler` gets `SELECT` on exactly the columns the discovery and worklist queries use (`whatsapp_instances(id, client_id, desired_state, link_state, health_state, lease_seen_at, deleted_at)` and five `message_jobs` columns), asserted by a grant-snapshot test. It cannot read a payload, a recipient, a credential or a message body. Cross-tenant staff reads go through a single `platformRead(ctx, reason, fn)` helper that writes the audit row in the same transaction and is the only code allowed to open a `wp_admin_app` connection. One honesty caveat: triggers do not fire on SELECT, so raw psql access by a staff member is **not** audited unless `pgaudit` is enabled for that role — either we enable it or we do not make the claim.

Redis keys follow one grammar, `wp:{env}:{purpose}:c:{client}:i:{instance}:{rest}`, built only by `tenantKey()`; a raw `wp:` literal outside `platform/redis` is a lint error. The only global keys are `wp:{env}:sys:*` (worker registry, connect token bucket, leader lease) and they contain no tenant data.

Three self-extending suites gate every build (V1-P1 acceptance):

1. **Suite A (pgTAP, inverted).** It enumerates **all** base tables in `public` and asserts each is either (a) in the `client_id` set with a coverage row and both `rowsecurity` and `forcerowsecurity` true, or (b) in `isolation_non_tenant_tables` with a non-empty reason. Per covered table it then sets `app.client_id` to tenant B, runs an intentionally unscoped `SELECT`, and asserts zero tenant-A rows, plus zero-row `UPDATE`/`DELETE` of a tenant-A row from B's context. Forgetting `client_id` on a new table is a red build, not a silent hole. Allow-listed with reasons today: `users`, `user_credentials`, `auth_sessions`, `staff_users`, `staff_sessions`, `plans`, `plan_limits`, `leads`, `migrations`.
2. **Suite B (application, real Postgres + real Redis, two tenants).** Every HTTP route is enumerated from the Fastify route table and called as tenant B against tenant A's ids (expect 404), and — the important half — **every background path runs with both tenants' data present**: send worker, reaper, reconciler, health evaluator, retention job, webhook dispatcher, Baileys inbound handler. Every emitted row, event and webhook body must carry only the owning tenant's ids. This is the suite that would have caught the Blastup leak.
3. **Suite C (Redis).** Enumerate every key written during a two-tenant end-to-end run; assert each matches `^wp:test:[a-z]+:(c:<uuid>|sys):` and that no key contains both tenants' ids. The regex is not loosened to make a test pass.

## 4.8 Envelope encryption

Baileys auth state is not configuration. It is a live, already-authenticated WhatsApp session for the tenant's real number: whoever holds it can read and send as that number with no second factor. Blastup writes it as plaintext JSON on disk (`whatsapp.service.ts:141`); evolution-api writes it as a plaintext text column (`Session.creds`). In both, one DB dump, Redis snapshot, stray backup or mounted volume is simultaneous account takeover for **every** tenant. That is the failure this subsection exists to prevent.

```
KEK (32 B, key ring file, never in the DB, never in an image layer, never in an env var)
  └─ wraps ─> DEK (32 B random, one per record)
                └─ encrypts ─> plaintext (creds blob / signal key / TOTP secret / webhook secret)
```

AES-256-GCM at both layers, fresh 12-byte IV on **every** write, 16-byte tag, per-record columns `ciphertext, iv, auth_tag, dek_wrapped, dek_iv, dek_tag, kek_id, enc_version`. No passphrase derivation and specifically no hardcoded salt (Blastup uses the literal string `"salt"` for every value in the system).

**AAD is split by layer, and this is what makes rotation safe:**

```
DEK-wrap AAD          = enc_version || kek_id || purpose
record-ciphertext AAD = enc_version || table_name || column_name || client_id || record_id
```

The record AAD contains no field that rotation mutates, so KEK rotation unwraps and rewraps the small DEK only and the bulk ciphertext still opens. It also means a ciphertext copied from tenant A's row into tenant B's row **fails to decrypt** — a cut-and-paste cross-tenant attack, or a restore that mixes rows, is caught by the auth tag instead of silently serving the wrong tenant's session.

Purpose-separated KEKs are the cheapest high-value control in the design:

| KEK | Encrypts | Mounted into |
|---|---|---|
| `session` | `whatsapp_session_credentials`, `whatsapp_session_keys`, Redis signal keys | **worker containers only** |
| `tenant-secrets` | webhook signing secrets | api + worker |
| `user-secrets` | `users.mfa_totp_secret_enc`, `staff_users.mfa_totp_secret_enc` | api only |

The public HTTP surface — the most exposed component — therefore has **no ability to decrypt a WhatsApp session, ever**. Neither reference repo separates these.

Key material lives in a file-based key ring behind a `KeyProvider` interface (`wrap()`/`unwrap()`), root-owned `0400`, delivered as a Docker secret / systemd `LoadCredential`, never in an image layer or an env var. Cloud KMS is out (no cloud account in the deploy path; a network call in the connect path is a new failure mode); self-hosted OpenBao/Vault is a documented swap — a config change plus a rewrap job — triggered by the first enterprise customer or external security review. Stated plainly: the file ring defends what actually kills companies (dumps, stolen backups, object-storage misconfiguration, SQL injection, a curious insider) and does **not** defend against root on the worker host — which KMS and Vault barely do either, since both hand the plaintext DEK to the same process.

Decryption happens in exactly one module, `platform/crypto`, exporting `decryptSessionCreds(ctx, instanceId)` and never a generic `decrypt(blob)`. Decrypted material never escapes the function that used it and never reaches a log or error; crypto errors render as a code only (`CRYPTO_DECRYPT_FAILED:{kek_id}`). One symmetric serialisation boundary — `JSON.stringify(value, BufferJSON.replacer)` → seal, open → `JSON.parse(…, BufferJSON.reviver)` exactly once — makes evolution-api's double-parse bug unrepresentable; a round-trip test on a real `initAuthCreds()` object guards it.

Rotation: routine KEK rotation every 12 months or on suspicion, rewrapping DEKs only (~1,000 tiny operations for the whole fleet); the retired KEK stays in the ring until a query proves zero rows reference it. Per-record DEK rotation on suspected compromise or relink. Mandatory test `kek_rotation_preserves_decryptability`: seal a real creds blob under k1, rotate to k2, assert byte-identical plaintext; same for an `enc_version` bump.

**Key loss is data loss, honestly.** If the key ring is lost, every WhatsApp session credential is unrecoverable and every tenant must re-scan a QR code; nothing else is lost, because messages, jobs and contacts are not app-encrypted. Mitigation is a three-copy rule (running host secret store, founder's offline encrypted copy, a sealed second offline copy) and a quarterly restore drill — a key backup that has never been restored is not a backup.

Not encrypted at the application layer, and said plainly: message bodies, contact names and numbers, job payloads. The inbox must render, search and dedupe them, and per-row encryption would kill every list query. They are protected by RLS, disk encryption, encrypted backups (a **different** passphrase from the KEK ring, so a backup leak plus a key leak requires two separate compromises) and bounded retention. WP is a linked device and legitimately sees plaintext; WhatsApp's end-to-end encryption is between devices and cannot hide content from a device the tenant authorised. Any Baileys product claiming otherwise is lying.

## 4.9 Auth

Signup writes `users` + `clients` + `memberships(owner)` in one transaction and issues a hashed 24-hour verification token. Unverified accounts may log in but cannot link an instance or send — an entitlement check on the server, not a hidden button. Passwords are **argon2id** (memoryCost 19456 KiB, timeCost 2, parallelism 1), rehashed on login when parameters change; bcrypt is never used for a new hash. Login is constant-time with a dummy verify on unknown emails, identical messages for wrong-email and wrong-password, an account failure counter **and** an IP-scoped limit (Blastup has only the former, so a distributed attacker enumerates freely), and lockout at 5 failures → 15 min → exponential to 24 h, audited and emailed.

Sessions: a 15-minute access token plus a rotating refresh token in an httpOnly, `Secure`, `SameSite=Strict` cookie, hashed in `auth_sessions`, with reuse detection that revokes the whole chain on replay. **Revocation honesty:** a stateless access token otherwise survives logout for up to its TTL, so every request checks a cheap per-user `token_epoch` (Redis plus a JWT claim) invalidated on logout, role change, membership removal and impersonation revocation — which is what makes "membership revoked ⇒ SSE dropped within 5 s" actually true rather than aspirational. Staff and impersonation access tokens are 2 minutes. TOTP MFA is mandatory for `owner` and for all staff; passkeys follow in v1.1 on the table already created.

API keys are `wp_live_<43 chars>` / `wp_test_…`, **server-generated only** (evolution-api lets the caller supply the token with no entropy check; we never accept a caller-chosen secret), shown once, stored as SHA-256 with a display hint, scoped, optionally restricted to one instance, with `last_used_at` debounced to one write per 60 s so a hot key does not turn the auth path into a write path. A route registered without an explicit scope declaration **fails to register at boot**.

RBAC (v1):

| Capability | owner | admin | agent | viewer |
|---|:--:|:--:|:--:|:--:|
| view dashboard / metrics | Y | Y | granted instances | granted instances |
| create/link instance, view QR | Y | Y | – | – |
| pause instance | Y | Y | granted | – |
| **resume instance** | Y | Y | – | – |
| edit pacing (tighten only) | Y | Y | – | – |
| send message / create job | Y | Y | granted | – |
| cancel queued job | Y | Y | own + granted | – |
| read inbox | Y | Y | granted | granted |
| export data | Y | Y | – | – |
| manage members / invites / API keys / webhooks | Y | Y | – | – |
| change roles, delete client, transfer ownership | Y | – | – | – |

Resume is owner/admin only and **never** an API key or a system actor: `POST /v1/instances/:id/resume` returns 403 for `actor_type IN ('api_key','system')` in all cases and additionally requires an acknowledgement flag when `pause_reason='provider_restriction'`. Staff roles are `support` (tenant metadata, no message bodies, may start an audited impersonation), `ops` (+ suspend, adjust limits), `superadmin` (+ manage staff); impersonation is time-boxed, reason-required, stamped on every audit row it produces and visible in the tenant's own audit view. Silent support access does not exist.

Fail-closed rules, enumerated because each one is a named anti-pattern:

1. No `?? 'default'`, no `|| defaultClientId`, no fallback identity anywhere — Blastup's `req.user?.id || 'default'` (and the `apikey.controller.ts:50` variant where a falsy id widens the filter to *everything*) is the reason this rule is first.
2. A missing `TenantContext` yields zero rows via RLS, not all rows.
3. A route without an auth policy and a scope declaration fails at boot.
4. A required secret unset at boot **stops the process** — no literal fallback (evolution-api ships `'BQYHJGJHJ'` as both the code default and the example env value).
5. An unmapped provider disconnect reason ⇒ `paused` after a short leash, never "assume fine".
6. Any decryption failure ⇒ instance `degraded`, job stays queued, alert raised; never "send without creds".
7. Any authorisation check that throws ⇒ deny. Exception-driven fallthrough to allow does not exist.
8. Redis unavailable ⇒ deny on auth routes; fail-open with an alert only on read routes.

## 4.10 Hardening

**Rate limiting, real and tested.** A Redis token bucket in one atomic Lua script at three simultaneous scopes (IP / client / API key), strictest wins: 10 per 15 min per IP on login/signup/forgot, 300/min per IP overall, 600/min burst 100 per client on `POST /messages`, 10/hour per client on instance creation and QR requests, plan limit per key. Responses carry `RateLimit-*` and `Retry-After`. The control that matters is the test: an integration test fires N+1 requests and asserts a real `429` with the right headers, per route class. Blastup's limiters all carry `skip: () => true` — configured, code-reviewed and completely inert. Only a behaviour test catches that.

**Validate and replace at every boundary.** Zod parses and the handler receives only the parsed object; the raw body is discarded, and a route without a schema fails to register. E.164 via libphonenumber (not a regex), JID normalisation before any write or comparison, MIME allow-list (not extension), 1 MB JSON / 16 MB multipart, 10,000-recipient array cap, escaped and length-capped search input. Responses go through explicit output schemas, so a field not in the schema cannot be returned — that is how "never leak an internal column" becomes structural rather than diligent.

**CORS/CSP per route, from day one.** `/api/**` gets an origin allow-list of the tenant app domains with `credentials: true`, no wildcard, and no `x-api-key` in the allowed headers for browser origins (keys are server-to-server; browsers use cookies). The website's public lead endpoint lives on `admin/backend` with its own narrow policy and limits, so marketing traffic never touches the customer API's budget or the send path. CSP is `default-src 'none'` plus per-app additions with nonce scripts, `frame-ancestors 'none'`, HSTS with preload, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. Both reference repos disable global protections app-wide to serve one public surface; if WP ever ships a widget it gets its own prefix and its own headers, never the API's.

**SSRF-guarded webhooks, checked at every dispatch** (evolution-api's check is literally commented out): https-only in production; we resolve the hostname ourselves and reject loopback, link-local `169.254.0.0/16` including cloud metadata, RFC1918, CGNAT, IPv6 ULA and `::1`; we connect to the **resolved IP** with SNI and `checkServerIdentity` driven from the original hostname (certificate verification is never disabled) to defeat DNS rebinding between check and connect; redirects off; 5 s connect / 10 s total; 1 MB cap; per-client concurrency cap. Signing is `X-WP-Signature: v1,t=<unix>,s=<hmac-sha256>` with a 5-minute window plus `X-WP-Event-Id` for receiver idempotency; 20 consecutive failures auto-disables the endpoint and notifies the tenant. Payloads carry ids and enums; message bodies only via an explicit per-endpoint opt-in that is off by default.

**Authenticated media serving.** No static mount (Blastup serves an upload directory). A tenant-scoped endpoint checks membership plus instance grant and issues a 5-minute signed URL against a private bucket.

**Logging is an allow-list, not a blocklist.** `platform/obs/logger.ts` accepts only a typed union of fields — `request_id, client_id, instance_id, job_public_id, attempt_no, lease_id, event_type, error_class, status_code, duration_ms, actor_type, actor_id, route, worker_id, kek_id`. Anything else is dropped at runtime and fails a lint rule at build. Free-form `meta: any` does not exist. No recipient, phone, body, email, token, creds, API key or QR/pairing payload appears in any log line, metric label or audit metadata value — evolution-api logs the tenant's own API key inside its webhook log object at default settings. Stack traces go to a separate access-restricted sink with 14-day retention. A CI test greps a full end-to-end run's log stream for the seeded tenant's phone number, message body, email and API key and fails on any hit; that test is worth more than the policy.

**Supply chain, containers, secrets.** Semgrep, Trivy (deps/image/config) and a secret scan run in `scripts/ci` — all CLI tools, so ADR 0003's no-git constraint blocks none of them; the build fails on HIGH/CRITICAL with a fixed version available. Runtime images are distroless or `node:24-slim`, non-root, read-only rootfs, `no-new-privileges`, dropped capabilities, no shell, pinned digests rebuilt weekly, `ignore-scripts=true` with a narrow allow-list. Secrets live in `/etc/wp/secrets/` (0700, files 0400), mounted as Docker secrets so neither `docker inspect` nor the process environment exposes them, delivered by rsync over SSH from the founder's encrypted store and never baked into an image. Worker hosts additionally run with `RLIMIT_CORE=0`, `kernel.core_pattern` disabled, swap off or encrypted and production heap snapshots disabled, because a live session is necessarily decrypted into worker memory.

## 4.11 Privacy for v1

**Consent.** WP is a processor for the tenant's messaging. v1 forces a per-import attestation (checkbox, free-text source description, attesting user, timestamp) into `consent_records`, records inbound-initiated conversations with basis `inbound_initiated`, and pretends nothing further. We record who asserted consent and when so a complaint can be traced; we cannot verify the claim, and we do not say we can.

**Opt-out.** A normalised keyword matcher (trim, lowercase, strip punctuation and emoji, Devanagari transliteration) covering English and Hindi/Hinglish (`STOP`, `UNSUBSCRIBE`, `band karo`, `mat bhejo`, `rok do`, `बंद करो`) plus tenant additions — tenants may add platform keywords, never remove them. Enforcement is at three points: API creation (422, no row), the claim-time content guard, and inside the send transaction, because a recipient may opt out while 10,000 jobs sit queued. A matched job becomes `cancelled` with `cancel_reason='opt_out'`, never `failed`, and is excluded from every health denominator. Client-wide is the default; per-instance is opt-in, audited and warned.

**Export and deletion** are both driven by `dsar_requests`. Export assembles a per-client or per-recipient archive (JSON + CSV) into object storage and delivers a 24-hour signed link, then deletes the artefact. Deletion soft-deletes the client, disconnects and purges session credentials immediately, purges message bodies and media within 7 days, and retains `audit_logs`, opt-out tombstones and aggregate counters under the legal-obligation carve-out stated in the DPA. Every step is audited; the action is irreversible and confirmed twice.

**What we tell tenants, in plain language, on the onboarding consent screen and in the ToS:**

1. WP connects as a linked device to *your* WhatsApp account. The account, the number and its standing with WhatsApp are yours.
2. **Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control.**
3. You are responsible for having permission to message every recipient, and you attest to that on import.
4. If WhatsApp signals a restriction, WP stops sending on that number, keeps your queued messages and tells you. WP will not automatically resume, will not switch you to another number and will not attempt to work around the restriction.
5. WP is a linked device, so WP's servers process your message content in the clear. WhatsApp's end-to-end encryption protects messages between devices; it does not hide content from a device you authorised.
6. The retention defaults in 4.5 apply and are configurable; export and deletion are self-service.

The ban risk in v1 lands on the tenant's real number with no appeal path. That is disclosed at onboarding, not buried.

## 4.12 Threat model

| Threat | Mitigation | Where implemented | Test that proves it |
|---|---|---|---|
| Cross-tenant read via a missed `WHERE client_id` | four layers: TenantDb, build lint, RLS FORCE, role separation | `platform/db/*`, `scripts/check-tenant-scope.ts`, RLS migrations | pgTAP suite A (inverted, self-extending) + unscoped-query-returns-zero-rows per table |
| Cross-tenant leak on a **background** path | every worker/cron/socket handler enters `withTenant`; cross-tenant scans registered with a reason | `modules/queue/worker`, `provider/baileys/events`, `roles/cron.ts` | suite B: run every background path with two tenants seeded, assert single-tenant output |
| Session credential theft via DB dump, backup or volume | envelope AES-256-GCM, DEK per record, KEK outside the DB, separate tables with separate GRANTs | `platform/crypto`, `whatsapp_session_*` | dump the table and assert no plaintext Baileys field names; assert API role SELECT is denied; assert AAD mismatch (row moved between tenants) fails to open |
| Session credential theft via an API RCE | purpose-separated KEKs; the `session` KEK is never mounted in the API container | compose file + `KeyProvider` | boot the API without the session key; every decrypt path errors `CRYPTO_KEY_UNAVAILABLE` and no send occurs |
| Account takeover (stuffing, phishing) | argon2id, IP + account limits, lockout, mandatory MFA for owner/staff, refresh rotation with reuse detection, `token_epoch` | `platform/auth` | 11th login returns 429; a reused refresh token revokes the chain; an MFA-less owner cannot reach protected routes |
| Stolen API key | hash-only storage, scopes, instance restriction, per-key limit, one-click revoke | `api_keys`, `requireScope` | schema assertion that no plaintext column exists; a `messages:read` key gets 403 on send; a revoked key gets 401 immediately |
| Webhook spoofing | HMAC-SHA256 + timestamp window + event id | `modules/webhooks/sign.ts` | tampered body fails verification; a 6-minute-old signature is rejected |
| SSRF via tenant webhook URL | scheme allow-list, own DNS resolution, IP-range denial, connect-to-resolved-IP with pinned identity, no redirects, re-checked every dispatch | `platform/http/safe-fetch.ts` | hostile-URL table (`169.254.169.254`, `localhost`, `10.x`, a rebinding host, an https→http redirect) all rejected at dispatch |
| Abusive tenant harming the platform | per-instance caps, claim-time opt-out, content guards, health scoring, plan limits, staff suspend | `modules/pacing`, `modules/compliance`, `/internal/v1` | an opted-out recipient's queued job is `cancelled` at claim; a cap breach leaves the job `queued`; suspending a client stops claims within one poll |
| Insider / staff impersonation | separate staff auth, time-boxed reasoned grants, stamped audit rows shown to the tenant, `platformRead` as the only BYPASSRLS path | `admin/backend`, `impersonation_grants`, `audit_logs` | an impersonated request without a live grant is denied; every impersonated write carries `impersonated_by_staff_id`; grant-snapshot test asserts `wp_admin_app` has no write on send-path tables |
| Duplicate send (retry storm, crash window) | per-client idempotency in `message_job_refs`, `send_attempts` written pre-dispatch, reaper never blind-retries a `dispatched` attempt | `modules/queue` | chaos test: kill the worker between dispatch and result 100×; assert zero jobs lost and no `dispatched` attempt is silently resent |
| Pause loses queued work | pause changes health state only; the claim gate reads health; no job status is touched | `modules/health` | pause mid-batch of 5,000 jobs, assert `count(queued)` unchanged, resume, assert each sends once |
| Media URL leakage | no static mount; authenticated tenant-scoped endpoint, 5-minute signed URLs, private bucket | `modules/inbox/media` | direct object URL 403; tenant A's signed URL used by tenant B 403; expired URL 403 |
| PII or secrets in logs | typed field allow-list, runtime drop plus build lint, separate error sink | `platform/obs/logger.ts` | grep a full E2E log stream for seeded phone, body, email, API key ⇒ zero hits |
| Wrong-number send after relink | `session_epoch` predicate inside the claim; relink to a different JID hard-blocked by default | `db/queries/claim-jobs.sql` | queue jobs, unlink, link a different number, assert zero sends and the jobs are visible for review |
| Safe Mode bypass | no `enabled` column, no `origin` in any DTO, exempt origins constructible only under `modules/pacing/internal/` | `modules/pacing` | `no_forbidden_mechanism_exists` + property test that no config patch can raise a limit |

## 4.13 The honest answer to "0 gap, 0 issue"

What we **can** promise and prove with tests on every build:

1. No plaintext WhatsApp session credential is written to any datastore, filesystem or backup at rest. Both reference products fail this.
2. Every tenant table sits behind four independent isolation layers, and the build goes red when a new table arrives without coverage — the control is the self-extending suite, not the reviewer's memory.
3. Every send begins as a durable row; a pause never loses queued work; a crash never blind-retries a possibly-delivered message.
4. No secret is stored in a readable form where a hash suffices — passwords, API keys, refresh tokens and invite tokens are hashed, never encrypted.
5. Rate limiting, SSRF guards and log redaction are proven by tests that assert **behaviour** (a real 429, a real rejection, a zero-hit grep), because the reference repos prove that configuration alone can be entirely inert.

What we **cannot** promise, and will not claim in any surface, document or sales conversation:

1. **"0 gaps" is not a promise anyone can honestly make.** Unknown vulnerabilities in Node, Postgres, Redis, Baileys and our own code exist by definition. The honest commitment is a short exposure window and a rehearsed response, not zero.
2. We cannot protect a session credential from an attacker with **root on the worker host** while a session is live — it is decrypted in memory by necessity. We make host compromise the *only* path instead of one of six, and we harden core dumps, swap and heap snapshots accordingly.
3. We cannot encrypt message content end-to-end from ourselves. WP is a linked device; anyone claiming otherwise for a Baileys product is lying.
4. We cannot prevent WhatsApp bans, and Safe Mode's disclaimer says so verbatim wherever the feature is named.
5. DPDP/GDPR posture in v1 is good hygiene plus a working DSAR pipeline — not a certification. SOC 2 is a v2 sales investment (V2-P7).
6. Two schema risks remain measured only by derivation: the encrypted signal-key write rate at high session counts (mitigation if it binds: coarser per-instance debounced blobs, benchmarked in V1-P3, not discovered in production), and claim-query cost across many live partitions (the partial index is small, but `status='queued'` does not prune partitions; the escape hatch is splitting hot from cold rows, never un-partitioning).

**Review cadence that keeps the bar where it is:** dependency, image and secret scans on every build; the isolation, rate-limit, log-redaction, idempotency and grant-snapshot suites on every build, because those five are what silently break; a monthly review of `audit_logs` for staff and impersonation actions and of both cross-tenant registries; a quarterly key-restore drill and a quarterly `role_table_grants` diff; a backup restore drill before the first paying tenant; an annual third-party penetration test once real tenant data is at meaningful scale; and a written 72-hour breach-notification drill, using GDPR's clock everywhere so we never run two.


---

# 5. The v1 product panel: modules, screens and flows

## 5.1 Scope, stack and the rules every screen obeys

`app/frontend` is a React 19 + Vite SPA — no SSR process on the box, because the dashboard needs no SEO and an SSR runtime costs ~380 MB RSS we would rather spend on sessions (`2026-08-25-v1-architecture-blueprint.md`, Surfaces). Routing and data are TanStack Router + Query; forms are react-hook-form with `zodResolver` over the same Zod v4 schemas the server validates, imported from `@wp/contracts`, so a client-side rule and a server-side rule cannot drift. Permissions are rendered with `can()` from `@wp/domain` — it greys out a button, it never authorises anything; the server re-checks every call. Design comes from `@wp/design-tokens` + `@wp/ui` (DTCG JSON in OKLCH → CSS custom properties + a Tailwind v4 preset; a raw hex inside `packages/ui` is a lint error).

Seven rules apply to every screen here, and each is a review question, not a preference:

1. **The panel never claims a send it cannot prove.** The UI renders `message_jobs.status`; there is no optimistic "sent". A message the API accepted is `queued`, and it says `queued`.
2. **Deferral is not failure.** Every pacing hold renders in the "waiting" visual family with a reason and a time, never in the error family (`2026-08-25-v1-design-safe-mode.md`).
3. **Realtime carries ids and enums only.** SSE payloads never contain a phone number, body or QR payload; the client refetches through the authorised API, so a cross-tenant leak over the channel is structurally impossible.
4. **Anything that stops sending names four facts in one block, in order:** cause, what is preserved, when it resumes, what the user can do.
5. **Copy is data.** All strings live in one `copy.ts` as i18n keys (en/hi minimum), scanned by `scripts/check-copy.ts` against `BANNED_CLAIMS`; any surface containing "Safe Mode" must ship `SAFE_MODE_DISCLAIMER` beside it or CI fails.
6. **Empty states are the onboarding surface** — no modal tour; each names the single next action.
7. **Lists are virtualised from day one** (TanStack Virtual) with a keyboard path; the `cmdk` command palette is a v1 deliverable, not polish (`2026-08-25-ref-review-evolution-ui.md` names its absence as the reference UI's biggest operator gap).

Two founder open questions bound this section: whether bulk campaigns exist in v1 (open question 3) and whether a working inbox is part of "a real working panel" (open question 6). This section plans the smallest honest version of both — one broadcast screen, one read-only conversation view with manual reply — and marks the cut lines. A "no" to either drops that module with no change to any other.

## 5.2 Module: signup, login, invites and password reset

**Purpose.** Get a real, verified human into a workspace with an owner membership, under auth controls that are tested rather than configured.

**User stories.** As a business owner I sign up with email and password and land in onboarding. As an owner I invite a teammate with a role. As an invited user I accept and land in the existing workspace, not a new one. As any user I reset a forgotten password without contacting support. As an owner I am required to set up TOTP.

**MVP.** Email+password signup (argon2id 19 MiB/t=2/p=1), email verification, login with account **and** IP rate limits and 5-attempt lockout (15 min, then exponential), 15-minute access token + rotating refresh cookie with reuse detection, `token_epoch` revocation so logout is real within 5s, TOTP mandatory for `owner`, invites by token hash with role, password reset by single-use token, session list with "sign out everywhere".

**Screens and states.**

| Screen | Loading | Empty | Error | Success |
|---|---|---|---|---|
| `/signup` | button spinner, form locked | n/a | inline field errors from the shared Zod schema; generic "That email or password isn't valid" on ambiguous failure | redirect to `/onboarding` with `onboarding_step='verify_email'` |
| `/verify-email` | "Checking your link…" | n/a | expired link → "This link has expired" + Resend (rate-limited, 60s cooldown shown as a countdown) | step advances, toast |
| `/login` | button spinner | n/a | constant-time generic error; lockout shows "Too many attempts. Try again in 14:32." with a live countdown | redirect to last route or `/instances` |
| `/login/mfa` | verifying | n/a | "That code didn't match" + attempts remaining | session issued |
| `/invite/:token` | resolving invite | n/a | invalid/expired → "This invite is no longer valid. Ask the workspace owner to send a new one." | joins existing `client_id` |
| `/reset` / `/reset/:token` | sending | n/a | always shows the same "If that email exists, we've sent a link" (no account enumeration) | password set, all sessions revoked |

**Flow — signup.** 1. POST the form. 2. Server creates `users` + `clients` + `memberships(role='owner')` in one transaction. 3. Verification email queued. 4. Client redirects to `/onboarding`. 5. Until `email_verified_at` is set the user can see the panel but cannot create an instance or send — enforced as an entitlement on the server, not by hiding a button.

**Data touched.** `users`, `user_credentials`, `clients`, `memberships`, `invites`, `auth_sessions`, `audit_logs`.
**Realtime.** None, except that a membership change or role change bumps `token_epoch` and drops the SSE connection within 5 seconds; the client shows "Your access changed. Reloading…" and refetches.
**Invariants.** Tenant isolation begins here: every subsequent request carries `TenantContext`; `users` is deliberately not `client_id`-scoped and is listed in `isolation_non_tenant_tables` with a reason.
**Events.** `audit_logs`: `user.signup`, `user.login_failed`, `user.locked_out`, `invite.sent/accepted`, `mfa.enrolled`, `password.reset`.

**MVP vs deferred.** MVP: everything above. Deferred to v2: SSO/SAML, passkeys, per-user IP allowlists, org-level session policies.

## 5.3 Module: onboarding

**Purpose.** Drive a new workspace to one successful, paced, consented send — and refuse to let a user reach the QR screen before the four things that make that send legal and measurable exist.

The gate is `clients.onboarding_step ∈ ('verify_email','choose_timezone','accept_pacing_profile','attest_consent','connect_whatsapp','send_test','done')` (blueprint, Onboarding [R-56]). "Connect WhatsApp" is enabled only after email verification, timezone choice, pacing-profile assignment and a recorded consent attestation. This ordering is not UX taste: `pacing_timezone` decides which local day a cap belongs to, and the consent attestation is the only record that exists if a recipient complains.

**Screens.** `/onboarding` is one route with a persistent left checklist and a right pane per step; the checklist stays visible on `/instances` as a dismissible strip until `done`.

| Step | Right pane | States |
|---|---|---|
| Verify email | "We sent a link to k…@example.com" + Resend | pending / verified / resend cooldown |
| Choose timezone | timezone select defaulted from browser, showing "Your sending window will be 09:00–20:00 in this timezone" | preview of today's window |
| Accept pacing profile | the `safe_default` profile rendered as a table (day-1 cap, steady cap, gap range, window, cold-outreach ratio) with `SAFE_MODE_DISCLAIMER` printed verbatim beneath it, and an "I understand" checkbox | untouched / accepted |
| Attest consent | free-text "Where did these contacts come from?" + checkbox "I have permission to message these recipients" | writes `consent_records` with the attesting user and timestamp |
| Connect WhatsApp | hands off to the connect flow (5.4) | inherits the instance states |
| Send test | one-recipient composer pre-filled with the owner's own number | queued → sent, or the honest deferral reason |

**Flow — first successful send.** 1. Verify. 2. Timezone. 3. Accept profile. 4. Attest. 5. Connect (QR). 6. Send a test to your own number. 7. On `message.job.sent`, the checklist collapses into a "You're live" card that states, in the same block, the current warm-up tier, today's remaining cap and the sending window — so the first thing a tenant learns is that this product is paced.

**Data touched.** `clients.onboarding_step`, `instance_pacing_state`, `consent_records`, `whatsapp_instances`, `message_jobs`.
**Realtime.** `instance.qr`, `instance.health_changed`, `message.job.sent` all drive checklist progress without a poll.
**Invariants.** Nothing on this path can send before a durable job row exists; the test send is an ordinary job at `priority='high'` and is paced like any other (warm-up tier 1 permits it).
**Events.** `audit_logs`: `onboarding.step_completed`, `consent.attested`, `pacing.profile_assigned`.

**MVP vs deferred.** MVP: the six-step checklist, the "You're live" card, contextual empty-state CTAs. Deferred to v2: role-specific onboarding tracks, sample-data workspace, in-app product tour, import-first onboarding.

## 5.4 Module: WhatsApp instances

This is the module the product lives or dies on, and it is the one where the reference UI's patterns are most directly reusable and most in need of upgrading.

**Purpose.** Link a tenant's real WhatsApp number as a linked device, keep it honestly represented, and give the tenant exactly the controls that are safe to give — and none that are not.

**User stories.** As an owner I connect my number by scanning a QR in under a minute. As an owner whose laptop has no camera-facing phone nearby I use an 8-character pairing code instead. As an operator I see at a glance which of my numbers are sending, which are waiting and which need me. As an operator I pause sending before a holiday and resume it afterwards without losing a single queued message. As an owner I disconnect a number and see exactly how many queued jobs that cancels before I confirm.

### 5.4.1 Instance list

Route `/instances`. A responsive card grid (1 → 4 columns) with search, a health filter (all / connected / degraded / paused / logged out / needs action) and a "Connect a number" primary action — the shape borrowed from the evolution manager dashboard (`2026-08-25-ref-review-evolution-ui.md`), with WP's own data on the card.

The **health card** carries, top to bottom: masked number ("+91·····21") and label; the health badge from the real FSM (`connected` / `degraded` / `paused` / `logged_out`, plus a distinct "Action required" treatment driven by `needs_user_action`); a Safe Mode strip showing warm-up tier and day, today's sends against the effective daily cap as a bar, and new conversations against the cold cap; queue depth and oldest-queued age; last successful send; and a hover-revealed action row (Open / Pause / Reconnect). Destructive actions are never in the hover row — they live in instance detail behind a type-to-confirm dialog.

States: skeleton cards while fetching; empty state = an illustration-free card with "No numbers connected yet. Connect your first WhatsApp number to start sending." plus the CTA; error = "We couldn't load your numbers" with Retry and the request id; a stale-data banner if SSE has been disconnected for >30s ("Live updates paused — reconnecting").

### 5.4.2 Connect: dual-path modal with a real terminal state

The reference modal (QR tab + pairing-code tab, self-polling, self-closing) is the right skeleton; its endless refresh loop is not. WP's version is bounded: **maximum 5 attempts in a 5-minute window**, each QR carrying a 45-second visible ring, then a terminal `pairing_expired` state with a "Generate a new code" **button** — never an automatic loop (blueprint, Session lifecycle).

Flow: 1. User picks QR or pairing code. 2. `POST /v1/instances/:id/link` sets `desired_state='online'`, `link_state='pairing'`, `pairing_started_at`, `qr_attempts=0`. 3. Discovery picks the instance up; a worker takes the Redis lease, Postgres mints the fence, the takeover grace elapses, the socket opens. 4. `instance.qr` arrives on the tenant-scoped SSE channel with `{instanceId, expiresAt, attemptsLeft}` plus the challenge — the QR is a bearer credential, never logged, never a metric label, never an audit metadata value. 5. On expiry the modal requests the next challenge while `attemptsLeft > 0` and shows "Code 3 of 5". 6. On scan, creds persist, `link_state='linked'`, `health_state='connected'`, warm-up tier 1 applies, and the modal self-closes into a toast: **"Connected as +91·····21."** 7. A post-pairing `515 restartRequired` is expected and never surfaced — the UI stays on "Connecting…" through one immediate reconnect.

States: `idle` (method choice) · `requesting` (skeleton QR block, no layout shift) · `awaiting_scan` (QR + ring + attempts left + "Open WhatsApp → Settings → Linked devices") · `code_shown` (8-character mono, letter-spaced, copy button) · `connecting` · `connected` · `expired` (terminal: "This pairing session expired. No number was linked. Generate a new code when you're ready." + button) · `error` (classified message + Retry).

The pairing-code path differs only in step 1 (phone input, E.164-validated via libphonenumber) and the challenge type. Both are one `ChannelLink.beginLink({method})` call, which is why a v2 Cloud API `{type:'redirect'}` challenge drops into this screen without a rewrite.

### 5.4.3 Instance detail

Route `/instances/:id`, tabbed: **Overview · Safe Mode · Queue · Activity · Settings**.

Overview: the same health card at full size, a 24-hour sparkline from `instance_health_samples`, last five `delivery_events`-derived activity lines, and the action bar. Queue: depth by band (HIGH/NORMAL/LOW), oldest queued age, the next eligible send time, and a link into a pre-filtered message list. Activity: the audit/pacing timeline (`audit_logs` + `pacing_events`) as a readable feed — "Warm-up advanced to tier 3", "Paused: provider restriction signal", "Resumed by Kartik".

**The action bar, with exact copy.** Every one of these strings lives in `copy.ts` and is CI-scanned:

| Action | Availability | Dialog title | Dialog body | Confirm label |
|---|---|---|---|---|
| Pause sending | health `connected`/`degraded` | "Pause sending on +91·····21?" | "Sending stops immediately. Your queued messages stay queued and nothing is lost. The connection stays open, so you keep receiving replies. You can resume any time." | "Pause sending" |
| Resume sending | health `paused` | "Resume sending on +91·····21?" | "Sending will restart at your current Safe Mode limits. Queued messages will go out in priority order." | "Resume sending" |
| Resume after a restriction signal | `pause_reason='provider_restriction'` | "WhatsApp signalled a restriction on this number" | "We paused sending because WhatsApp returned a restriction signal. Your queued messages are preserved. Resuming may put this number at further risk — bans also come from recipient reports and message content, which pacing cannot control. Only you can decide to resume." + required checkbox "I understand the risk and want to resume sending." | "Resume sending" (disabled until checked) |
| Reconnect | `degraded`, or reconnect budget exhausted | "Reconnect +91·····21?" | "We'll try to re-establish the connection. Queued messages stay queued." | "Reconnect" |
| Disconnect (go offline) | `link_state='linked'` | "Take +91·····21 offline?" | "The connection closes and this number stops sending and receiving. It stays linked — you won't need to scan a QR again. Queued messages stay queued and will resume when you bring it back online." | "Take offline" |
| Unlink from WhatsApp | `link_state='linked'` | "Unlink +91·····21?" | "This logs the linked device out of WhatsApp and deletes the stored session. You'll need to scan a QR again to reconnect. **{n} queued messages will be cancelled.** Received conversations are kept." + type the number's label to confirm | "Unlink number" |
| Delete instance | any | "Delete +91·····21?" | "This removes the number from your workspace, deletes its stored session and cancels **{n} queued messages**. Message history is retained under your retention policy." + type the label to confirm | "Delete number" |

Two behaviours behind that table matter more than the wording. **Pause keeps the socket open** (we keep receiving receipts) and only stops claims; **disconnect** is `sock.end()`, never `logout()`; **unlink** is the only logout path. And **relinking to a different number is hard-blocked by default** — if the scanned JID does not match `owner_jid`, the modal shows a terminal error: "This QR belongs to a different WhatsApp number. To use a different number, add it as a new number instead." Silently accepting it would be number substitution by the back door, which the safety boundary forbids.

The standard pause banner, used verbatim wherever a transient disconnect pauses sending (`.claude/skills/wp-architecture/SKILL.md` §10): **"WhatsApp connection temporarily unavailable. Sending has been paused. Pending messages remain queued."**

### 5.4.4 The Safe Mode panel

The Safe Mode tab is the single most important honesty surface in the product. It renders, all from `instance_pacing_state` + `pacing_ledger` + `pacing_events`:

- **Tier**: "Warm-up tier 3 of 6 · day 9", the next advancement date, and if frozen, why ("Advancement is paused while your health band is Watch").
- **Today's usage**: four bars with raw numbers — sends vs `eff_daily_cap`, this hour vs `eff_hourly_cap`, new conversations vs `eff_new_conv_cap`, cold-outreach ratio vs `eff_cold_ratio_max` — read from the ledger row for the instance's local `ledger_date`.
- **Next eligible send**: a live countdown to `pacing_ledger.next_eligible_at`, or "Outside your sending window — next send at 09:00". Never an error colour.
- **Sending window** and pacing timezone, noting that the timezone changes at most once every 7 days and that changing it does not reset today's counter.
- **Health band** — Healthy / Watch / Degraded / Critical — with the multipliers spelled out ("Watch: caps ×0.70, gaps ×1.5, new conversations ×0.5") and a **"Why?" drawer**.
- `SAFE_MODE_DISCLAIMER`, verbatim, always visible on this tab.

The "Why?" drawer lists each signal with its measured value, evidence window, points cost and last observation — and is honest about what is not scored: v1 collects evidence for all twelve signals but scores only hard restriction, rejected-send rate, delivery ratio and the `rate_limited` fast lane, because the remaining weights are untuned guesses with no ban-outcome dataset (blueprint [R-27s]). Unscored signals sit in a "Collecting — not yet affecting your score" group; an unmeasured instance shows "Not enough data yet", never a bad score.

Tenant controls here are tightening-only: a "Tighten my limits" form that lowers caps and raises gaps, writing `instance_pacing_overrides(kind='tenant_tighten')`. There is no off-switch, no slider that goes up and no plan that buys a higher cap — "pay more, send faster" is a pacing bypass sold rather than coded, and the UI has no affordance for it.

**Data touched.** `whatsapp_instances`, `whatsapp_session_credentials`/`_keys` (never read by the panel), `instance_pacing_state`, `pacing_ledger`, `pacing_events`, `instance_health_samples`, `instance_pacing_overrides`, `audit_logs`.
**Realtime.** `instance.qr`, `instance.health_changed`, `instance.pacing_changed` — each invalidates a query key; the card animates the badge transition so a state change is *felt* rather than discovered.
**Invariants.** `health_state` is written only by the health service and `health_score` only by the pacing evaluator — the panel is a reader. `paused → sending` requires an authenticated **user**; the resume control does not exist for API keys and the endpoint returns 403 for `actor_type` of `api_key` or `system`. A pause never deletes, fails or reorders a queued job, and every dialog above says so in words.
**Events.** `instance.linked`, `instance.paused{reason}`, `instance.resumed{actor_user_id}`, `instance.unlinked`, `instance.deleted`, `pacing.tier_advanced`, `pacing.band_changed`, `pacing.tenant_tightened` — all to `audit_logs`, the pacing ones also to `pacing_events`, and all fanned out by `notify()` where the blueprint marks them mandatory.

**MVP vs deferred.** MVP: everything above. Deferred to v2: multi-number bulk actions, profile-picture/about editing, group capture (`capture_groups`), per-instance webhook configuration UI, scheduled auto-pause windows. Never built, at any layer: proxy settings, number rotation, failover-to-another-number, device fingerprint controls — the reference UI ships a Proxy page and WP has no counterpart to it.

## 5.5 Module: contacts

**Purpose.** Give a tenant a list to send to, an opt-out state they cannot accidentally override, and a consent record that survives a complaint.

**MVP.** CSV import with column mapping and per-import consent attestation; contact list with search, tag filter and opt-out filter; contact detail (identity, tags, notes, opt-out state, last 20 messages, send history count); manual add/edit; tag create/assign/remove; opt-out list view with source and timestamp; export to CSV (audited).

**Fields.** `phone_e164` (required, E.164-normalised on import — rows that fail normalisation are rejected with the row number, not silently dropped), `display_name`, `tags text[]`, `notes`, plus derived `first_seen_at`, `last_message_at`, `blocked_by_recipient_at`, and the joined opt-out state. Custom fields are v2.

**Flow — import.** 1. Drop a CSV; the client parses the header and previews 5 rows. 2. Map columns. 3. Validation shows counts: "1,842 valid · 37 invalid numbers · 61 already on your opt-out list (they will be skipped)". 4. The attestation step cannot be skipped: free-text source description + "I have permission to message these recipients". 5. Import runs server-side in batches with a polled progress bar (an import is not worth an SSE channel). 6. Result screen offers a CSV of rejected rows with reasons.

**States.** Loading: skeleton table with reserved row heights (CLS budget). Empty: "No contacts yet. Import a CSV or add a contact to get started." Error: per-row errors in a table, never one opaque toast. Success: the result screen above.

**Opt-out state in the UI.** Opted-out contacts are visible but visually suppressed and non-selectable in every audience picker. The contact detail shows source (`inbound_keyword` / `api` / `manual` / `import` / `complaint`), the matched keyword if any, and the timestamp. Restoring an opt-out is a human-only, audited action behind a confirm dialog that says: "This person asked to stop receiving messages. Only restore this if you have a new, documented opt-in." Platform keywords cannot be removed; tenant keywords can be added.

**Data touched.** `contacts`, `opt_outs` (hashed storage — no raw number is indexed), `consent_records`, `audit_logs`.
**Realtime.** None; an inbound STOP that creates an opt-out surfaces through the notification centre, not a live table update.
**Invariants.** Tenant isolation on every query; opt-out is enforced at three server points (API creation → 422, claim-time content guard, pre-send inside the send transaction) and the UI is a fourth, weakest layer that exists for clarity, not enforcement.
**Events.** `contact.imported{count}`, `contact.exported`, `optout.created{source}`, `optout.restored{actor_user_id}`, `consent.attested`.

**MVP vs deferred.** MVP as listed. Deferred to v2: segments and saved audiences, custom fields, dedupe/merge, CRM sync, bulk tag editing at scale, contact-level suppression scheduling.

## 5.6 Module: sending

### 5.6.1 Single send

Route `/send`. Recipient picker (contact search or raw E.164), instance selector (only `connected` instances are selectable; others show why), message composer with character count, optional media attachment against the MIME allow-list, priority selector (High/Normal/Low with the honest tooltip: "Priority decides which of your queued messages goes first. It does not make WhatsApp deliver faster and it does not raise your limits"), and a live WhatsApp-style preview pane.

Flow: 1. Submit → `POST /v1/messages` with a client-generated `Idempotency-Key`. 2. Server runs authz, entitlement, opt-out precheck and the plan queue-depth cap, then writes the job + refs + outbox + audit in one transaction. 3. Response is `201 {id, status:'queued'}` — the UI shows "Queued" and a link to the message, never "Sent". 4. If the instance is offline the API returns `202` with `warning: INSTANCE_OFFLINE` and the UI says: "Queued. This number is offline, so nothing will send until you bring it back online." 5. If unlinked, `409` and the composer blocks with a Connect CTA.

### 5.6.2 Broadcast (the deliberately small v1 version)

Route `/broadcasts`. Not a campaign suite: one message, one instance, one audience (a tag or an explicit selection), optional start time, a progress view. Creating a broadcast writes a `campaigns` row; expansion into `message_jobs` is a resumable cursor job in batches of 500, each batch one transaction, deduped by `dedupe_key = sha256(campaign_id ‖ recipient)` against `mjr_dedupe_uq`, so a crash mid-expansion resumes instead of duplicating.

The audience step shows, before Continue is enabled: total selected, minus opted-out, minus invalid, minus recipients blocked by the per-recipient frequency guard, equals "will be queued". Then the projection: **"At your current limits (tier 3: 220/day, 45–90s between sends, window 09:00–20:00 Asia/Kolkata) this will take about 9 days."** That sentence is why a paced product does not generate support tickets. If the audience trips the duplicate fan-out guard (warn at 150 distinct recipients, acknowledgement at 500), jobs are created and stay **queued** with `NEEDS_HUMAN_ACK` behind a banner — never auto-failed.

Progress view: a bar over queued/sent/failed/cancelled fed by `campaign.progress`, per-status filtered lists, Pause (stops claiming, keeps rows) and Cancel (moves remaining `queued` rows to `cancelled` with a reason, stating how many).

### 5.6.3 Message list and the status timeline

Route `/messages`, virtualised, filterable by instance, status, priority, date, recipient and campaign; keyset pagination (`OFFSET` is a lint error server-side). Each row shows recipient (masked to non-owners per role), first line of the body, status chip, instance, and time.

Message detail renders the **status timeline** straight from `delivery_events`, one row per event with its timestamp: created → queued → claimed → dispatched → sent → delivered → read, with `retry_scheduled`, `paused_hold`, `cancelled` and `reconciled` appearing inline where they occurred. Attempts are shown as a nested list (attempt 1 failed `transient` at 14:02, retry scheduled for 14:04). This screen is the product's credibility: a tenant who can see why a message is where it is does not ask us.

**Deferral visibility** is the part that must never look like an error. Each deny reason maps to one copy string in the "waiting" family:

| `pacing_deny_reason` | Chip | Detail line |
|---|---|---|
| `MIN_GAP` | Paced | "Waiting for the gap between sends. Next send at 14:32:10." |
| `DAILY_CAP` | Daily limit reached | "This number has sent 220 of 220 messages today. Sending resumes at 00:00 Asia/Kolkata." |
| `HOURLY_CAP` | Hourly limit reached | "Resumes at 15:00." |
| `NEW_CONV_CAP` / `COLD_RATIO` | New-conversation limit | "This is a first message to this contact. Your new-conversation allowance for today is used up; it resumes tomorrow." |
| `OUTSIDE_WINDOW` | Outside sending window | "Your sending window is 09:00–20:00. Next send at 09:00." |
| `PER_RECIPIENT_FREQ` | Recipient limit | "This contact has already received 3 messages in the last 24 hours. Next eligible at 18:40." |
| `NEEDS_HUMAN_ACK` | Needs your confirmation | "This message goes to a large number of new recipients. Confirm to release it." + button |
| `INSTANCE_PAUSED` / `NOT_CONNECTED` | Waiting on the connection | "Sending is paused on this number. Your message is safe and will go out when you resume." |

Terminal outcomes stay in the error family and stay actionable: `OPT_OUT` → "Cancelled — this contact opted out on 12 Aug"; `BLOCKED_WORD` → "Failed — this message matched a blocked-content rule (category: financial claims)" (the category, never the matched list); `LINK_IN_FIRST_MESSAGE` → "Failed — first messages to a new contact can't contain a link during warm-up. Send an introduction first."

**Retry and cancel.** A `failed` job with a retryable class offers "Send again", which creates a **new** job with a new idempotency key and links back to the original — it never mutates a terminal row. A `queued` job offers Cancel (single or bulk over a filter, with the count in the confirm dialog). A `processing` job offers neither: "This message is being sent right now."

### 5.6.4 Unresolved sends

Route `/unresolved`. Jobs in `blocked_needs_review` — a crash or timeout left us unable to prove whether the message reached WhatsApp. The list explains itself in one paragraph and offers exactly the two blueprint-mandated choices per job: **"Retry (may duplicate)"** and **"Discard (may have been delivered)"**. There is no bulk auto-resolve and no automatic requeue; the chosen action writes an audit row with `actor_user_id`. This screen is small, and it is the most honest thing in the product.

**Data touched.** `message_jobs`, `message_job_refs`, `send_attempts`, `delivery_events`, `campaigns`, `pacing_ledger` (read), `opt_outs` (read).
**Realtime.** `message.job.sent/failed/delivered/read`, `job.needs_user_action`, `campaign.progress` — all ids only, all triggering targeted query invalidation, merged into the cache rather than refetching the whole list.
**Invariants.** Durable-first (the composer cannot send, it can only create a row); idempotency at the storage layer (a double-click produces one job because the key is unique in `message_job_refs`, not because the button disabled itself); pause preserves work; deferral never touches `attempts`.
**Events.** `message.created`, `message.cancelled{reason}`, `campaign.created/paused/cancelled`, `job.unresolved_resolved{choice, actor_user_id}`.

**MVP vs deferred.** MVP: single send, one-audience broadcast, message list + timeline, deferral visibility, retry/cancel, unresolved sends. Deferred to v2: templates and a template editor (no templates exist on a linked device in v1), scheduling calendar, drip/automation, A/B variants, segments, per-recipient variable substitution beyond a simple `{{name}}`.

## 5.7 Module: conversations (lightweight)

**Purpose.** Let a human answer a reply. Nothing more in v1.

**MVP.** A two-pane view at `/chats`: a virtualised conversation list (contact, last message excerpt, unread dot, instance badge) and a thread pane (rendered message bubbles, date separators, delivery ticks from `delivery_events`, an auto-expanding composer with attachment support). Inbound messages arrive over SSE as ids and are refetched. A manual reply is an ordinary durable job with `SendOrigin.inbox_manual` — it is paced like everything else, though replies to an existing conversation are not `is_new_conversation` and so do not consume the cold-outreach allowance.

**States.** Loading: two skeleton panes. Empty list: "No conversations yet. When someone replies to you, it'll show up here." Empty thread: contact header with "No messages yet". Error: per-pane retry. Send failure inside the thread: the bubble shows a failed chip with the classified reason and a retry affordance.

**What explicitly waits for v2's full team inbox** (`2026-08-25-team-inbox-manual-send-features.md`; the reference UI is single-user and must not be the model): assignment and ownership, agent presence and collision detection, internal notes, canned replies, saved views and filters, bulk actions, SLA timers, labels-as-workflow, group chats (`capture_groups` stays `false`), history backfill, and the media pipeline at scale. v1 keeps `syncFullHistory:false` and `markOnlineOnConnect:false` as defaults rather than options — a full history sync is a memory spike, a write burst, a reconnect-storm multiplier and third-party PII we have no consent to store. The panel says so where a user might expect their history: "WhatsApp doesn't send your past conversations to a newly linked device. Conversations here start from the moment you connected."

**Invariants.** Message bodies are not encrypted at rest and the plan says so plainly — WP is a linked device that legitimately sees plaintext; bodies are protected by RLS, disk encryption, encrypted backups and bounded retention. No message body, phone number or JID ever reaches a log line, metric label or audit metadata value.

**MVP vs deferred.** MVP: read + manual reply, per the above. Deferred to v2: everything in the "waits for v2" list. If the founder answers open question 6 with "send-and-track only", this module drops entirely and the media pipeline and per-session memory model both get simpler.

## 5.8 Module: settings

Route `/settings`, grouped into sections from the start rather than one flat form (the reference UI's flat settings page is called out as the pattern that does not survive growth).

| Section | MVP contents | States |
|---|---|---|
| Profile | name, email, password change, TOTP enrolment/reset, language (en/hi), timezone display | inline save with optimistic-off (server confirms) |
| Workspace | workspace name, pacing timezone (rate-limited to one change per 7 days, with the "this will not reset today's counter" note), default sending window | disabled + reason when the 7-day lock applies |
| Team | member list with role chips, invite form, role change, remove, pending invites with resend/revoke | empty = "It's just you right now"; last-owner removal blocked with a reason |
| Roles | read-only matrix of owner/admin/agent/viewer against actions, so nobody has to guess | static |
| API keys | create (scopes, optional instance restriction), shown once with a copy button and "This is the only time you'll see this key", revoke, `last_used_at` | empty = "No API keys yet"; revoke = type-to-confirm |
| Notifications | per-event channel matrix (in-app / email), with the mandatory events marked non-optional and explained: "Pause, logout and unresolved-send alerts can't be turned off — they need a human." | — |
| Webhooks | endpoint URL, secret (shown once), event selection, delivery log with status and response code, manual retry | auto-disabled after 20 consecutive failures, with a banner saying so |
| Danger zone | close workspace (type-to-confirm, states the queued-job count and the retention period) | — |

**Data touched.** `users`, `memberships`, `invites`, `api_keys`, `webhook_endpoints`, `webhook_deliveries`, `clients`, `instance_pacing_state.pacing_timezone`, `audit_logs`.
**Invariants.** API keys are hash-only and can never resume a paused instance; a route registered without an explicit scope declaration fails to register at boot, so the scope list in this UI is generated from the contract rather than hand-maintained.
**Events.** `apikey.created/revoked`, `member.role_changed/removed`, `webhook.created/disabled`, `workspace.settings_changed`, `pacing.timezone_changed`.

**MVP vs deferred.** MVP as listed. Deferred to v2: billing and plan management (there is no billing in v1), SSO, audit-log export UI, custom roles, per-key rate plans, data-residency options.

## 5.9 Module: notifications and alerts

Three surfaces, one source. `notify()` fans out to in-app, email and the customer webhook with a dedupe key so a reconnect storm cannot become an alert storm.

- **Global banner** (top of app, one at a time, highest severity wins): instance paused, logged out, restriction signal, plan cap reached, `INFRA_UNAVAILABLE`, provider-wide outage, SSE disconnected.
- **Notification centre** (bell, unread count): the full feed, filterable by instance, each entry linking to the screen that resolves it.
- **Email**: the mandatory set only — pause (any cause), logged out, reconnect budget exhausted, duplicate fan-out acknowledgement required, unresolved send, plan cap reached. These are not user-disableable because each one requires a human to act.

Every notification follows the four-fact structure from 5.1. Example, verbatim, for a restriction pause: *"Sending is paused on +91·····21. WhatsApp returned a restriction signal at 14:07. Your 412 queued messages are preserved and nothing has been lost. Sending will not restart on its own — review the number and resume when you're ready."*

**MVP vs deferred.** MVP: banner + centre + email + webhook, with dedupe. Deferred to v2: Slack/Telegram destinations, digest scheduling, per-user quiet hours, mobile push.

## 5.10 Borrowed patterns, and how we avoid the template look

Five patterns come straight from the evolution manager review, each with the WP upgrade that makes it ours:

1. **Instance card.** Borrowed: avatar/label, status badge, meta counts, hover-revealed actions, responsive 1→4 grid. Upgraded: the badge maps to the real health FSM plus a distinct "action required" treatment; the card carries queue depth, oldest-queued age, warm-up tier and today's cap usage; destructive actions leave the hover row entirely.
2. **Dual-path connect modal.** Borrowed: QR tab + pairing-code tab, polling that notices success on its own, self-closing with toast feedback. Upgraded: bounded attempts with a visible ring and counter, an explicit terminal `pairing_expired` state with a manual regenerate button, and the challenge delivered over an authenticated tenant-scoped SSE channel instead of a polled endpoint.
3. **Type-to-confirm destructive dialog.** Borrowed nearly verbatim. Upgraded: the dialog states the exact count of queued jobs that the action cancels, computed server-side at dialog-open time.
4. **Socket-into-cache updates.** Borrowed: merge events into the query cache instead of refetching everything. Upgraded: events carry ids and enums only and the client refetches through the authorised API, so the channel cannot leak data across tenants even if authorisation were wrong.
5. **Status badge as one component over one enum.** Borrowed exactly — one component, one mapping, i18n labels.

Making it premium rather than templated is a set of enforceable constraints, not taste (`2026-08-25-ui-ux-design-direction-anti-ai-look.md`): our own DTCG/OKLCH tokens with exactly one signature accent and no purple-to-blue gradient anywhere; Geist or Instrument Sans with a tested Noto Sans Devanagari/Gujarati/Tamil fallback stack, never Inter as the signature face; radius and surface tiered by component class, hairline borders or shadow-as-border instead of one shadow everywhere; compositor-first motion (View Transitions for navigation, staggered action reveals, animated status transitions, `prefers-reduced-motion` honoured, no decoration in an operator tool); the keyboard layer the reference UI lacks (20–30 shortcuts as the v1 benchmark); virtualised lists; empty and error states that name the next action; WCAG 2.2 AA with 4.5:1 contrast, unobscured focus and 44px targets checked at token-definition time. INP ≤ 200 ms and CLS ≤ 0.1 are gates, not aspirations.

## 5.11 Screen inventory

| # | Screen | Route | Phase | Notes |
|---|---|---|---|---|
| 1 | Signup | `/signup` | V1-P2 | |
| 2 | Login + MFA challenge | `/login`, `/login/mfa` | V1-P2 | real-429 tested |
| 3 | Email verification | `/verify-email` | V1-P2 | |
| 4 | Password reset request/confirm | `/reset`, `/reset/:token` | V1-P2 | |
| 5 | Invite acceptance | `/invite/:token` | V1-P2 | |
| 6 | Onboarding checklist (6 steps) | `/onboarding` | V1-P2 (steps 1–4), V1-P3 (connect), V1-P4 (test send) | Playwright acceptance test spans P2→P4 |
| 7 | App shell (nav, notification centre, command palette) | — | V1-P2 | palette actions grow per phase |
| 8 | Instance list + health cards | `/instances` | V1-P3 (cards), V1-P5/P6 (Safe Mode + health strips) | |
| 9 | Connect modal (QR + pairing code) | modal | V1-P3 | bounded, terminal state |
| 10 | Instance detail — Overview | `/instances/:id` | V1-P3 | |
| 11 | Instance detail — Safe Mode + "Why?" drawer | `/instances/:id/safe-mode` | V1-P5 (limits/tier), V1-P6 (band + drawer) | |
| 12 | Instance detail — Queue | `/instances/:id/queue` | V1-P4 | |
| 13 | Instance detail — Activity timeline | `/instances/:id/activity` | V1-P6 | |
| 14 | Instance action dialogs (pause/resume/reconnect/offline/unlink/delete) | modals | V1-P3 (link ops), V1-P6 (resume + ack) | |
| 15 | Contacts list | `/contacts` | V1-P5 | |
| 16 | Contact import wizard (+ consent attestation) | `/contacts/import` | V1-P5 | |
| 17 | Contact detail | `/contacts/:id` | V1-P5 | |
| 18 | Opt-out registry | `/contacts/opt-outs` | V1-P5 | |
| 19 | Single send composer | `/send` | V1-P4 | |
| 20 | Message list | `/messages` | V1-P4 | virtualised, keyset |
| 21 | Message detail + status timeline | `/messages/:publicId` | V1-P4 (timeline), V1-P5 (deferral copy) | |
| 22 | Broadcast create (audience → projection → confirm) | `/broadcasts/new` | V1-P4 (expansion), V1-P5 (projection + fan-out ack) | subject to open question 3 |
| 23 | Broadcast progress | `/broadcasts/:id` | V1-P4 | |
| 24 | Unresolved sends | `/unresolved` | V1-P4 | two-choice resolution |
| 25 | Conversation list + thread | `/chats`, `/chats/:id` | V1-P6 | subject to open question 6 |
| 26 | Settings — Profile / Workspace | `/settings/profile`, `/settings/workspace` | V1-P2 | |
| 27 | Settings — Team + Roles matrix | `/settings/team` | V1-P2 | |
| 28 | Settings — API keys | `/settings/api-keys` | V1-P4 | |
| 29 | Settings — Notifications | `/settings/notifications` | V1-P6 | |
| 30 | Settings — Webhooks + delivery log | `/settings/webhooks` | V1-P4 (delivery), V1-P6 (log UI) | |
| 31 | Settings — Danger zone | `/settings/danger` | V1-P3 | |
| 32 | Global banner + notification centre | — | V1-P6 | |
| 33 | Realtime connection status + degraded-mode surfaces | — | V1-P7 | |

## 5.12 What this panel does not claim

A panel is where a promise gets made by accident, so three limits go on the record with the screens. **First:** no screen may state or imply that Safe Mode prevents a WhatsApp restriction; the disclaimer is verbatim and co-present with every mention, enforced by `check-copy` rather than reviewer memory. **Second:** the deferral copy in 5.6.3 quotes times derived from the tenant's own limits and ledger — a schedule, not a delivery-time guarantee — and no tooltip may turn priority into a speed promise. **Third:** the broadcast projection ("about 9 days") is arithmetic over current caps and will be wrong the moment the health band tightens, so the screen says "about", shows its assumptions and updates on `instance.pacing_changed`.


---

# 6. v1 delivery plan - Part A (V1-P0 - Foundations, guardrails and local CI to V1-P5 - Safe Mode: pacing ledger, warm-up, content guards, opt-out registry)

This section turns sections 2-4 (architecture, data model and security, engine/queue/Safe Mode design) into an executable phase plan. Schema, SQL and interfaces are **referenced, never re-transcribed** - if a table, statement or interface is named here, its authoritative definition is in sections 2-4 and a code review that finds a divergence rejects the code, not the section. Part B (V1-P6 to V1-P10) is section 7.

## 6.0 Rules that apply to every phase

**Sequencing.** Phases are strictly sequential. Inside a phase, work packages are ordered so the repository is never broken between packages: durable schema, then pure domain logic, then service wiring, then UI.

**Evidence (core invariant 7).** Done means: the named tests exist with those exact case names, `scripts/ci` output is pasted verbatim into `.memory/progress/`, and one reviewer verdict is recorded per phase. A red test stops the line.

**Migration ordinals.** Globally unique four-digit, forward-only, `db/migrations/NNNN_slug.sql`. Ordinals 0001-0028 are allocated below; 0029+ belong to section 7. Migrations needing `CREATE INDEX CONCURRENTLY` or pg_partman carry the `-- wp:no-transaction` header and run in the one-shot `ROLE=migrate` container as `wp_migrator` over the direct (non-PgBouncer) connection. Services assert schema version at boot and refuse to start on mismatch; they never migrate.

**One deliberate deviation from the blueprint's phase text, stated up front.** The blueprint lists the pacing tables under V1-P5. This plan creates **every v1 table, including all `pacing_*`, `opt_outs` and content-guard tables, in V1-P1**; V1-P5 ships seeds, additive indexes and logic only. Reason: isolation suite A enumerates *all* base tables and asserts each is either `client_id`-covered with RLS FORCE or registered with a reason. If pacing tables arrive four phases later, that guarantee is aspirational until then.

**Effort convention.** Engineer-days are one competent TypeScript/Postgres engineer. Calendar weeks assume 2-3 people at an effective 2.2 engineers and 4 productive days per week - which is why weeks are not days divided by three. Estimates exclude founder review latency and exclude blocked questions; an unanswered blocking question stops a phase, it is never guessed. **Part A total: 148-185 engineer-days, 13-16 calendar weeks**, and it is a range because no line of this system exists yet and V1-P3's Baileys behaviour is discovered rather than documented.

---

## 6.1 V1-P0 - Foundations, guardrails and local CI

**Goal and why now.** The founder's four-project tree, the shared packages and every mechanical guard exist before any feature code. A tenant-scope lint on day two is free; the same lint in month three has to be argued against 200 existing queries. There is no hosted CI (ADR 0003, no git and no VCS ever), so `scripts/ci` is the only gate that exists and must exist before there is anything to gate.

| In scope | Out of scope |
|---|---|
| Workspace, 4 projects, 7 packages, `db/` skeleton, no VCS | Any route, table or data-bearing screen |
| `scripts/ci.{ps1,sh}` with all guard steps | RLS, roles, prod compose, deploy (V1-P1, section 7) |
| depcruise, tenant-scope, send-origin, copy, guard meta-assertion | Health scorer, pacing math (V1-P5, section 7) |
| `@wp/domain` pure pieces; `@wp/server-kit` shells | Real key ring on a VPS, rotation drill (section 7) |
| Design-token bootstrap, 4 UI primitives, dev Compose | Full design system, animation (section 7, V1-P10) |

**Prerequisites.** ADR 0002/0013/0014/0015/0016 confirmation. No blocking founder questions.

**Work packages.**

1. **Scaffold without git.** Where: the tree in section 2 (`app/{frontend,backend}`, `admin/{frontend,backend}`, `website/`, `packages/*`, `db/`, `infra/`, `scripts/`, `docs/`). How: pnpm workspace + TS project references (`composite: true`); no Turborepo in v1; `VERSION` + `CHANGELOG.md` + `scripts/snapshot.ps1` (stamped archive to `D:\kd\wp-snapshots\`, excluding `node_modules`, `demo/`, `.env*`) replace tags and history. Acceptance: `pnpm -r typecheck` green on an empty tree; a snapshot unzips into a working install. Tests: `scripts/tests/snapshot.test.ts::snapshot_excludes_node_modules_demo_and_env`, `scripts/tests/workspace.test.ts::no_vcs_directory_exists_anywhere_in_the_tree`.
2. **`@wp/config`.** Where: `packages/config/`. Shared tsconfig/eslint/prettier/vitest/tailwind bases; `packages/config/testkit` and `packages/utils/i18n` start nested and are promoted only at a third consumer. Acceptance: no project redefines `strict`.
3. **`@wp/domain` core pieces (browser-pure).** Where: `packages/domain/src/{timing,queue/job-fsm,retry/classify,queue/dwrr,copy/banned-claims}.ts`. How: `TIMING` is one exported object; clock and RNG are injected; `no-restricted-globals` bans `Date.now`/`Math.random` in the package; `BANNED_CLAIMS` includes Hindi/Hinglish ("ban nahi hoga", "block nahi hoga", "100% safe") and `SAFE_MODE_DISCLAIMER` is exported from here. Acceptance: `esbuild --platform=browser --bundle` of the package succeeds in CI. Tests: `packages/domain/tests/timing.test.ts::send_timeout_is_less_than_claim_expiry_minus_reaper_grace`, `::takeover_grace_plus_lease_ttl_exceeds_watchdog`; `packages/domain/tests/dwrr.test.ts::high_flood_does_not_starve_low`; `packages/domain/tests/classify.test.ts::every_send_error_class_maps_to_exactly_one_retry_action`.
4. **`@wp/contracts` skeleton.** Where: `packages/contracts/`. oRPC router shell, Zod v4 error envelope, `.strict()` as the default object mode, OpenAPI generator writing to `docs/api/`. Test: `packages/contracts/tests/envelope.test.ts::unknown_request_fields_are_rejected_by_default`.
5. **`@wp/server-kit` shells.** Where: `packages/server-kit/`. Tenant context (`withTenant` via `set_config('app.client_id', ..., true)`), Zod config loader (the only reader of `process.env`), redacting logger with a **typed field allow-list** (no `meta: any` type exists to abuse), error mapper, metrics registry, `tenantKey()`/`sysKey()`, envelope crypto + `KeyProvider` with the AAD formula written exactly once (section 3). Tests: `packages/server-kit/tests/envelope.test.ts::seal_open_round_trip_preserves_buffers`, `::record_aad_contains_no_field_that_rotation_mutates`; `packages/server-kit/tests/logger.test.ts::logger_drops_fields_outside_the_allow_list`.
6. **Structural guards.** Where: `.dependency-cruiser.cjs`. Rules: `no-cross-project`, `packages-never-apps`, `frontend-never-server`, `no-deep-module-import`, **`api-never-imports-provider`** (the structural form of invariant 1), and **two** `domain-must-be-pure` rules - the core-builtin rule plus an npm rule blocking `pg|ioredis|redis|drizzle-orm|pino|fastify|@wp/(db|server-kit)`, because `dependencyTypes:['core']` can never match an npm package. Test: `scripts/tests/depcruise.test.ts::api_role_importing_provider_fails_the_build`.
7. **Safety guards that make forbidden mechanisms unrepresentable.** Where: `scripts/check-send-origin.ts`, `scripts/check-tenant-scope.ts` + the single `CROSS_TENANT_QUERIES` registry, `scripts/check-copy.ts`. Build order: tenant-scope and send-origin first (invariants 4 and 6). Copy check is a plain glob grep over the whole repo except `demo/` and `.memory/`, and also asserts `SAFE_MODE_DISCLAIMER` co-presence wherever "Safe Mode" appears. The token ban (`rotateNumber|rotateProxy|proxyPool|setProxy|proxyscrape|fingerprint|spoof|forceResume|autoResume|bypassPacing|failoverNumber`) fails the build on sight. Tests: `scripts/tests/check-send-origin.test.ts::exempt_origin_outside_pacing_internal_fails`; `scripts/tests/check-copy.test.ts::hinglish_ban_claim_fails_the_build`; `scripts/tests/check-tenant-scope.test.ts::unregistered_cross_tenant_query_fails`; `app/backend/tests/static/forbidden-mechanisms.test.ts::no_forbidden_mechanism_exists` (Safe Mode suite 30, created here, extended every phase).
8. **Guard meta-assertion and `scripts/ci`.** Every guard asserts its glob matched at least one file and fails with `guard matched zero files` otherwise - without this, a renamed folder silently disarms a guard. `scripts/ci.{ps1,sh}` order: format, lint, depcruise, domain browser build, guard meta-assertion, tenant-scope, send-origin, copy, typecheck, unit, integration, build. Test: `scripts/tests/guard-meta.test.ts::every_guard_reports_a_nonzero_matched_file_count`.
9. **Dev stack and design tokens.** Where: `infra/compose/docker-compose.dev.yml` (postgres 17, redis 7, minio, mailpit, digest-pinned); `packages/design-tokens` (DTCG JSON to CSS custom properties + Tailwind v4 preset, Devanagari/Indic fallbacks because the inbox renders Hindi; a raw hex in `packages/ui` is a lint error); `packages/ui` ships Button, Input, Card, Badge, each interactive one carrying `'use client'`, plus a website smoke build in CI (otherwise the first Button import into a Server Component fails opaquely). Tests: `packages/ui/tests/tokens.test.ts::no_raw_hex_in_ui_package`; `scripts/tests/website-smoke.test.ts::server_component_can_import_ui_primitives`.
10. **`docs/CONVENTIONS.md`.** Layering (`roles/ → modules/<m>/{routes,service,repo,index} → @wp/domain`, `platform/` wires `@wp/server-kit`), routes never touch the DB, repos hold no business rules, `ctx: TenantContext` first on every service function, lower_snake enums, the ordinal registry, and a guard table stating what each guard proves.

**Invariants respected.** 1 (api cannot import provider), 4 (tenant-scope guard), 6 (token ban + send-origin), 7 (CI is the evidence gate).

**UI work.** Tokens and four primitives only. No screens - a screen built before its contract is rework.

**Migrations.** None. `db/migrations/README.md` defines the ordinal registry and the `-- wp:no-transaction` header.

**Observability added.** Metrics registry shell and the log field allow-list. Nothing is emitted yet; the allow-list existing first is what keeps the first phone number out of the first log line.

**Docs.** `docs/CONVENTIONS.md`, `db/migrations/README.md`, `scripts/README.md`.

**Exit criteria.** Verbatim green `scripts/ci` with every guard reporting a non-zero matched-file count; named tests green (`send_timeout_is_less_than_claim_expiry_minus_reaper_grace`, `high_flood_does_not_starve_low`, `seal_open_round_trip_preserves_buffers`, `no_forbidden_mechanism_exists`, `every_guard_reports_a_nonzero_matched_file_count`, `hinglish_ban_claim_fails_the_build`, `api_role_importing_provider_fails_the_build`); one reviewer verdict on the guard set and the package graph. **Demo:** run `scripts/ci.ps1` (green); import `pg` into `@wp/domain` (red, named rule); add "ban nahi hoga" to a copy file (red); rename a guarded folder (red, `guard matched zero files`); revert; green.

**Effort.** 12-15 engineer-days, 1-1.5 calendar weeks.

| Risk | Mitigation |
|---|---|
| Guards configured but inert (exactly the reference repo's dead rate limiters) | Guard meta-assertion plus a violating fixture per guard |
| TS project references misconfigured, incremental builds rot later | Prove the graph now, on an empty tree |
| `ci.ps1` and `ci.sh` drift | Both call identical pnpm targets; a parity test asserts step lists match |

**Founder sees.** One command that refuses to build a repo violating the safety rules. Nothing runs yet - that is the point: the rules are code, not a document.

---

## 6.2 V1-P1 - Data model, migrations and tenant isolation proof

**Goal and why now.** Every table, enum, RLS policy, Postgres role and isolation suite exists **before any tenant data can arrive**. Isolation retrofitted after real data is a migration plus a breach window; isolation built first is a red build. This is also where `db/queries/claim-jobs.sql` becomes a tested file, so the claim is referenced from here on and never re-typed.

| In scope | Out of scope |
|---|---|
| All v1 + v1a tables and enums (section 3), pacing and compliance included | Services or routes that write them |
| pg_partman partitioning, the non-partitioned uniqueness authorities | Parquet archival, partition growth automation (v2) |
| RLS ENABLE + FORCE, four roles, grant snapshot test | pgaudit (section 8) |
| `withTenant`, `TenantDb`, `tenantKey()`/`sysKey()` | Business repos |
| Isolation suites A and C, suite B harness | Suite B's real paths (registered in V1-P3 to V1-P5) |
| `ROLE=migrate`, schema-version assertion, `singleton_leases` | Rolling deploy script (section 7) |

**Prerequisites.** V1-P0 green. **Blocking founder questions: 2** (one user, many clients - decides whether `users` carries `client_id`), **4** (opt-out default scope), **5** (message retention default; expensive to change once data accumulates).

**Work packages.**

1. **Extensions and enums (0001, 0002).** citext, pgcrypto, pg_partman; all enums from section 3, lower_snake, with a TypeScript union generated into `@wp/domain`. Test: `db/tests/schema/enums.test.ts::enum_parity_db_vs_domain` - drift here surfaces as a silent zero-row claim, not an error.
2. **Tenancy, auth and plans (0003, 0004, 0005).** `clients`, `users`, `user_credentials`, `memberships`, `instance_grants`, `invites`, `auth_sessions`, `api_keys`, `plans`, `plan_limits`, `client_limit_overrides`, and the `effective_client_limits` view the pacing reserve reads.
3. **Instances and session credentials (0006, 0007).** `whatsapp_instances` with `connection_status` and `health_state` never collapsed, plus `link_state`, `desired_state`, `session_epoch`, `current_fence`. Session material in two tables with **separate GRANTs**; `whatsapp_instances.health_score` does not exist (the score lives only on `instance_pacing_state`). Test: `db/tests/schema/ownership.test.ts::health_state_and_health_score_have_exactly_one_writer_module`.
4. **Durable queue (0008, 0009, 0010).** `message_jobs` partitioned monthly with its CHECK constraints; the four **non-partitioned** uniqueness authorities; `delivery_events` weekly; `analytics_rollup_daily`. Tests: `db/tests/schema/partitioning.test.ts::no_unique_index_on_a_partitioned_table_without_the_partition_key`, `::there_are_no_foreign_keys_referencing_message_jobs`.
5. **Pacing and compliance (0011, 0012).** All `pacing_*` tables, `client_daily_usage`, `opt_outs`, `opt_out_keywords`, `content_fingerprints(+_recipients)`, `recipient_send_buckets`, `instance_recipient_contacts`, `consent_records`, `retention_policies`. Test: `db/tests/schema/pacing.test.ts::exactly_one_table_carries_a_reserve_counter` - the structural guard against pacing dual authority.
6. **Inbox, audit, admin v1a, leases (0013, 0014).** `contacts`, `chats`, `messages` (rendered body only, never `rawMessage`), `media_assets`, `audit_logs`, `outbox`, `singleton_leases`, `schema_version`, `staff_users`, `staff_sessions`. The admin **UI** and v1b tables are section 7, V1-P9.
7. **Roles, grants, RLS (0015, 0016).** `wp_app`, `wp_scheduler` (column-narrow SELECT), `wp_admin_app` (BYPASSRLS SELECT, writes revoked on all send-path tables), `wp_migrator`. RLS `ENABLE` + `FORCE` with no `|| 'default'` fallback - unset context returns zero rows. 0016 is `-- wp:no-transaction` for concurrent index builds. Test: `db/tests/security/grants.test.ts::role_table_grants_match_the_snapshot`.
8. **`TenantDb` and the Redis key grammar.** Where: `db/src/tenant-db.ts`, `packages/server-kit/src/redis/`. A raw `db.select()` outside `platform/db` is a lint error; keys only via `tenantKey()`/`sysKey()`. Tests: `db/tests/isolation/suite-c.test.ts::every_redis_key_matches_the_tenant_grammar`, `::no_tenant_payload_appears_outside_its_own_namespace`.
9. **Isolation suites A and B harness.** Suite A is **inverted**: enumerate all base tables and assert each is either `client_id`-covered with `rowsecurity` and `forcerowsecurity`, or listed in `isolation_non_tenant_tables` with a non-empty reason. Suite B seeds two tenants and runs a registry of background paths; the registry starts empty but asserted, and every later phase must add its paths. Tests: `db/tests/isolation/suite-a.test.ts::every_base_table_is_tenant_covered_or_explicitly_registered`; `db/tests/isolation/suite-b.test.ts::every_registered_background_path_returns_single_tenant_output`.
10. **`db/queries/claim-jobs.sql` as a file.** The canonical claim from section 4, tested against seeded rows with no worker. Tests: `app/backend/tests/integration/queue/claim-sql.test.ts::claim_returns_zero_rows_for_a_stale_fence`, `::claim_returns_zero_rows_when_health_is_not_connected`, `::claim_returns_zero_rows_when_session_epoch_differs`, `::claim_returns_zero_rows_when_client_is_suspended`, `::claim_orders_by_next_attempt_at_within_a_band`.
11. **Migrate role and boot assertion.** Test: `app/backend/tests/integration/boot/schema-version.test.ts::service_refuses_to_boot_on_schema_version_mismatch`.

**Invariants respected.** 3 (uniqueness authorities are non-partitioned, so a UNIQUE is real), 4 (four isolation layers), 1 and 5 structurally (the claim predicates exist before any caller).

**UI work.** None.

**Migrations.** 0001-0016 as listed; 0017-0018 reserved for V1-P2.

**Observability added.** `wp_schema_version` gauge, migration duration and applied-ordinal gauges.

**Docs.** `docs/DATA-MODEL.md` (pointer to section 3 plus ordinal registry, partition and retention table), `docs/ISOLATION.md` (four layers, two registries, how to add a table).

**Exit criteria.** Verbatim green `scripts/ci`; named tests green (`every_base_table_is_tenant_covered_or_explicitly_registered`, `no_unique_index_on_a_partitioned_table_without_the_partition_key`, `exactly_one_table_carries_a_reserve_counter`, `enum_parity_db_vs_domain`, `role_table_grants_match_the_snapshot`, all five `claim-sql` cases, `service_refuses_to_boot_on_schema_version_mismatch`); deliberate-failure evidence that a `client_id`-less scratch table turns suite A red, pasted then reverted; a db-engineer plus architecture reviewer verdict on the claim file and grant snapshot. **Demo:** bring up dev Compose, run migrate, then in psql as `wp_app` with no tenant context `SELECT` from `message_jobs` and get zero rows; set context for tenant A and see only A's rows; attempt `UPDATE message_jobs` as `wp_admin_app` and be denied.

**Effort.** 20-24 engineer-days, 2-2.5 calendar weeks.

| Risk | Mitigation |
|---|---|
| pg_partman misconfigured; partitions stop appearing months later | Test creates three future months' partitions and asserts them; a cron check lands in section 7 |
| RLS FORCE breaks legitimately cross-tenant background work | `CROSS_TENANT_QUERIES` registry and the narrow `wp_scheduler` role built now, not discovered in V1-P4 |
| Question 2 unanswered when 0003 is written | Build `memberships` (the superset); collapsing later is one migration, splitting later is a data migration |
| Schema drifts from section 3 during implementation | Any deviation edits section 3 in the same task; code comments are not the source |

**Founder sees.** The whole product's shape in a running database, and a live proof that a query without tenant context returns nothing while the admin role physically cannot write the send path.

---

## 6.3 V1-P2 - Identity, onboarding and the panel shell

**Goal and why now.** A real person signs up, verifies, completes onboarding and lands on an honest empty dashboard. It precedes the engine because onboarding **gates** linking: Connect WhatsApp unlocks only after email verification, timezone choice, pacing-profile assignment and a recorded consent attestation. Building QR first means building it twice.

| In scope | Out of scope |
|---|---|
| Signup/login/logout, argon2id, lockout, IP+account limits, refresh rotation with reuse detection, `token_epoch`, TOTP | SSO/SAML, passkeys (section 8) |
| Memberships, invites, `instance_grants`, RBAC `can()` | Impersonation (section 7, V1-P9) |
| Onboarding wizard through to the connect step | The QR itself (V1-P3) |
| App SPA shell, SSE client shell, en/hi i18n | Admin SPA, marketing site (section 7) |
| Real-429 rate-limit tests per route class | Dashboards and alerts (section 7, V1-P7) |

**Prerequisites.** V1-P1 green. **Blocking founder questions: 15** (MFA mandatory for owners at launch) and **23** (ban-risk posture on the record - the attestation screen is where that disclosure lives).

**Work packages.**

1. **Password and session core.** Where: `app/backend/src/modules/identity/`. argon2id 19 MiB/t=2/p=1; constant-time login with a dummy verify on unknown email; lockout 5 → 15 min → exponential, audited; 15-minute access token plus rotating refresh in an httpOnly/Secure/SameSite=Strict cookie, hashed in `auth_sessions`, reuse detection revoking the chain. Tests: `app/backend/tests/integration/identity/login.test.ts::unknown_email_and_wrong_password_take_indistinguishable_time`, `::lockout_escalates_and_writes_an_audit_row`; `.../refresh.test.ts::reused_refresh_token_revokes_the_entire_chain`.
2. **`token_epoch` revocation.** A per-user epoch in Redis plus a JWT claim, checked per request, bumped on logout, role change, membership removal and impersonation revocation. This is what makes "membership revoked, SSE dropped within 5s" true rather than aspirational, since a stateless access token otherwise survives logout for its full TTL. Test: `.../revocation.test.ts::logout_invalidates_an_unexpired_access_token_within_one_request`.
3. **TOTP, API keys, RBAC.** TOTP secret envelope-encrypted under the api-only `user-secrets` KEK; API keys server-generated, shown once, SHA-256 stored, scoped; `can()` in `@wp/domain` so the SPA greys out what the server independently re-checks; a route registered without an explicit scope **fails to register at boot**. Tests: `app/backend/tests/contract/route-policy.test.ts::no_route_registers_without_an_auth_policy_and_a_scope`; `packages/domain/tests/rbac.test.ts::resume_is_owner_or_admin_only_and_never_an_api_key`.
4. **Rate limiting, for real.** Redis token bucket at IP, client and key scope, strictest wins, per route class, asserted by a genuine 429 with headers - the reference repo's limiters were configured, reviewed and inert. Test: `app/backend/tests/integration/http/rate-limit.test.ts::each_route_class_returns_a_real_429_with_headers`.
5. **Signup and tenancy bootstrap.** One transaction creating `users` + `clients` + `memberships(owner)`; unverified accounts cannot link or send, enforced as an **entitlement**, not a hidden button. Test: `.../signup.test.ts::unverified_account_cannot_create_an_instance_via_the_api`.
6. **Onboarding FSM.** `clients.onboarding_step` per section 3; the transition rules live in `@wp/domain` so browser and server run the same machine; the server gates `connect_whatsapp`. The attestation screen records what was shown, including `SAFE_MODE_DISCLAIMER` and the plain statement that restriction risk lands on the tenant's own number with no appeal path. Tests: `packages/domain/tests/onboarding-fsm.test.ts::connect_is_unreachable_until_the_four_prior_steps_complete`; `app/backend/tests/integration/onboarding/gate.test.ts::connect_endpoint_rejects_an_incomplete_onboarding_state`.
7. **Panel shell.** Where: `app/frontend/src/`. TanStack Router + Query, auth provider, SSE client shell (no channels yet), error-envelope rendering, `@wp/ui` growth (Table, Sheet, Toast, EmptyState, form fields), en/hi catalogues. Empty states name the next action and never fake a chart.
8. **E2E harness.** `app/frontend/tests/e2e/onboarding.spec.ts::signup_verify_timezone_profile_consent_reaches_connect_step` - the first half of the v1 acceptance test, completed in V1-P3 and V1-P4.

**Invariants respected.** 4 (every identity query is tenant-scoped or registry-listed), 6 (no copy on these screens may claim protection), plus the fail-closed rule that entitlement, not UI, blocks unverified users.

**UI work.** Auth screens, the five-step wizard with a persistent progress rail, the empty dashboard, account and team settings. All strings are i18n keys and pass `check-copy`.

**Migrations.** 0017 `onboarding_and_email_verification`, 0018 `login_throttle_and_totp`. 0019-0020 reserved for V1-P3.

**Observability added.** `wp_login_attempts_total{result}`, `wp_rate_limit_rejections_total{scope,route_class}`, `wp_onboarding_step_gauge{step}`, `wp_token_epoch_bumps_total{reason}`; audit rows for signup, lockout escalation, invite and role change.

**Docs.** `docs/AUTH.md` (session model, the revocation honesty statement, RBAC matrix), `docs/ONBOARDING.md` (FSM plus the exact attestation copy and where it is stored).

**Exit criteria.** Verbatim green `scripts/ci`; the eight named tests plus the Playwright case green; a reviewer verdict covering auth, RBAC and the attestation copy (reviewed against safety-compliance, not only UX). **Demo:** sign up in a browser, collect the mailpit verification mail, walk the wizard, observe Connect disabled until step four; log in from a second browser, log out of the first, watch the first 401 on its next request; hammer login and get a real 429.

**Effort.** 24-30 engineer-days, 2-3 calendar weeks (frontend and backend parallelise well).

| Risk | Mitigation |
|---|---|
| Auth shipped "good enough" and hardened later - the standard breach path | The hardening tests are gate tests in this phase, not section 7 items |
| Onboarding copy softened to reduce signup friction | `check-copy` plus a named reviewer verdict on the attestation screen |
| SPA grows an unowned `components/` sprawl | The `features/<feature>/{api,components,hooks,schemas}` rule enforced by the deep-import depcruise rule |

**Founder sees.** Signs up as a real customer, walks onboarding, invites a teammate, and sees a dashboard that honestly says nothing is connected. First shareable build.

---

## 6.4 V1-P3 - Baileys session engine: lease, fence, encrypted auth state, QR linking

**Goal and why now.** A tenant scans a QR and the number survives worker crashes, Redis loss and rolling deploys, with no plaintext credential in any datastore, filesystem or backup. Highest-risk phase in v1 and the dependency of everything after it: the queue cannot claim without a fence, and Safe Mode cannot pace what is not connected.

| In scope | Out of scope |
|---|---|
| `MessageTransport` + `ChannelLink` types, Baileys adapter, `disconnect-map` as data | A second adapter (section 8, V2-P1) |
| `EncryptedAuthStore`, Postgres/Redis split, fence-guarded `setKeys`/`purge`, upsert `saveCreds` | KEK rotation drill on a real VPS (section 7, V1-P7) |
| Redis lease, Postgres-minted fence, heartbeat, monotonic watchdog, self-fencing | Rebalancing or consistent hashing (never in v1) |
| Discovery loop, per-worker cap, connect buckets, staggered reconnect, drain | Measured capacity (section 7, V1-P8) |
| QR/pairing over the tenant-scoped SSE channel, health FSM, `needs_user_action` | Signal-driven scoring (section 7, V1-P6) |
| SPIKE-2 (echo replay), SPIKE-4 (encrypted key-write throughput) | SPIKE-1 (V1-P4), SPIKE-3 (V1-P8) |

**Prerequisites.** V1-P2 green; a pinned Baileys version; at least two real numbers the team owns **and accepts losing**. **Blocking founder questions: 10** (relink to a different number), **11** (Redis as an accepted single point of failure - losing it stops the fleet within 10 seconds, safely but totally; needed in writing), **14** (file key ring versus Vault).

**Work packages.**

1. **Provider boundary.** Where: `app/backend/src/provider/provider.types.ts`. Interfaces per section 4; no Baileys type may appear in this file. The absent methods stay absent permanently - there is nowhere for `rotateNumber`, `setProxy`, `setDeviceFingerprint`, `forceResume` or a per-send pacing override to live. Tests: `app/backend/tests/static/provider-boundary.test.ts::no_baileys_type_leaks_into_provider_types`; `no_forbidden_mechanism_exists` is extended to the provider tree.
2. **Encrypted auth state.** Where: `provider/baileys/auth-state.ts`. Postgres holds `creds`, `pre-key`, `app-state-sync-key/version` under the worker-only `session` KEK; high-churn `session`/`sender-key`/`sender-key-memory` live in Redis, encrypted, TTL 30 days. **Exactly one serialisation boundary each way** (`BufferJSON` replacer at seal, reviver at open) makes the reference repo's double-parse bug unrepresentable. `saveCreds` upserts with `cred_version` and `owner_fence` predicates, serialised per instance; a **version** conflict reloads and retries three times without touching health, a **fence** conflict self-fences. Tests: `app/backend/tests/integration/engine/auth-state.test.ts::auth_state_round_trip_preserves_buffers`, `::kek_rotation_preserves_decryptability`, `::first_saveCreds_for_a_new_instance_does_not_throw`, `::concurrent_saveCreds_from_one_owner_does_not_release_the_lease`, `::stale_fence_cannot_setKeys_or_purge`.
3. **Lease and fence.** Redis `SET NX PX` for mutual exclusion; the fence is **minted in Postgres** and written into the lease value, then a takeover grace, then `makeWASocket`. Heartbeat with a 2s command timeout; graceful release writes a `released` marker. Two self-fence triggers: heartbeat zero/throw, and a local monotonic watchdog if no *successful* renewal completed inside the watchdog window. Every state write carries the fence predicate. Tests: `.../lease.test.ts::two_workers_cannot_hold_one_session`, `::hung_redis_connection_self_fences_within_15s`, `::redis_flush_does_not_deadlock_claims` (asserting `wp_fence_regression_total` stays 0), `::stale_fence_cannot_claim_or_write_events`.
4. **Disconnect map as data.** Where: `provider/baileys/disconnect-map.ts`, a table not a switch. **The numeric codes in section 4 are library knowledge and must be re-derived from the pinned enum in this work package** - an explicit task, not an assumption. Test: `.../disconnect-map.test.ts::disconnect_map_covers_every_enum_member`.
5. **Reconnection and pause semantics.** Full-jitter backoff with a permanent per-instance stagger, 8 attempts, counter resetting only after a 60-second `open`; exhaustion pauses with `RECONNECT_FAILED` plus audit, notification and webhook - never a silent stop. Pause keeps the socket open and stops claims; disconnect is `sock.end()`; unlink is logout + purge + `session_epoch++`; relink to a different JID is hard-blocked by default. Tests: `.../reconnect.test.ts::reconnect_budget_exhaustion_pauses_and_notifies`; `app/backend/tests/static/shutdown-path.test.ts::logout_is_unreachable_from_the_shutdown_path`.
6. **Fleet discovery and drain.** Lease-grab every 5s ± jitter, `MAX_SESSIONS_PER_WORKER` default 150 / ceiling 250, no shard index anywhere; connect storms metered per-worker and fleet-wide so a cold start of 1,000 sessions deliberately takes about two minutes; soft yield at 0.9x cap on event-loop lag; SIGTERM drain per section 4 with `stop_grace_period >= 45s`. Tests: `.../fleet.test.ts::kill_dash_9_storm_reconnects_within_bucket_rate`, `::rolling_deploy_causes_zero_re_QR_and_zero_unresolved`, `::unowned_instance_becomes_degraded_with_infra_unavailable_after_three_scans`.
7. **Pairing flow.** QR or 8-character code, bounded at 5 attempts per 5-minute window, terminal `pairing_expired` with a **button** to generate a new code - never an auto-loop. The challenge goes over the tenant-scoped SSE channel; it is a bearer credential and is never logged, never a metric label, never audit metadata. Tests: `.../pairing.test.ts::pairing_attempts_are_bounded_and_terminal`; `db/tests/isolation/suite-c.test.ts::no_pairing_payload_appears_outside_the_owning_tenant_namespace`.
8. **SPIKE-2 and SPIKE-4.** Two days each, each producing a written number in `.memory/research/`: does WhatsApp reliably replay our own `fromMe` messages to a reconnecting linked device (the reconciler's primary evidence in V1-P4), and what is the sustained encrypted signal-key write throughput (the largest unproven performance risk). If SPIKE-2 is weak, the consequence is a higher `blocked_needs_review` rate - recorded honestly, never engineered around.
9. **Suite B registration.** The inbound handler and discovery loop are registered as background paths and run with two seeded tenants.

**Invariants respected.** 2 (unknown or restriction codes pause, never blind-retry), 3 (fence in every write predicate), 5 (pause stops claims and touches no queued row), 6 (no rotation, proxy, spoofing or auto-resume anywhere in the adapter).

**UI work.** The Connect screen: method choice, a 45-second QR ring with attempts remaining, masked success ("Connected as +91·····21"), the terminal expired state with a manual regenerate button, and the instance card's first real fields. Every transition out of connected shows a banner stating what happened, what is preserved and what the user can do.

**Migrations.** 0019 `session_store_indexes`, 0020 `instance_pairing_and_disconnect_fields` (whatever the pinned-enum re-derivation proves missing). 0021-0023 reserved for V1-P4.

**Observability added.** `wp_instance_health_state`, `wp_instance_link_state`, `wp_reconnect_attempts_total{code}`, `wp_lease_takeovers_total`, `wp_lease_lost_total`, `wp_fence_regression_total`, `wp_instances_unowned`, `wp_fleet_capacity_headroom`, `wp_worker_sessions`, `wp_worker_eventloop_lag_p99`, `wp_session_rss_bytes_est`, `wp_connect_bucket_wait_seconds`.

**Docs.** `docs/ENGINE.md` (lifecycle, the three orthogonal state fields, the re-derived disconnect map with the date it was re-derived), and the first `docs/RUNBOOK.md` sections (reconnect, fence regression, Redis loss).

**Exit criteria.** Verbatim green `scripts/ci`; mandatory engine tests 3-14 green by name plus `disconnect_map_covers_every_enum_member` and `logout_is_unreachable_from_the_shutdown_path`; a `kill -9` storm on a worker holding 150 sessions reconnects with **zero re-QR** and zero unresolved jobs, output pasted; SPIKE-2 and SPIKE-4 written up with numbers and confidence; an opus-tier reviewer verdict on lease/fence as built versus section 4. **Demo:** link a real number by QR in under 60 seconds; `kill -9` the worker and watch takeover within 45 seconds with no new QR; `FLUSHALL` Redis and watch one takeover cycle then normal operation; rolling-restart under load with no re-QR; `SELECT` the credential column and show it is unreadable.

**Effort.** 34-42 engineer-days, 3-4 calendar weeks. Most likely phase to overrun, because Baileys behaviour under crash, takeover and restart is discovered rather than documented.

| Risk | Mitigation |
|---|---|
| Pinned enum values differ from section 4's table | Re-derivation is an explicit task with a test that fails on any unmapped member |
| Per-session memory well above the derived 35 MB | `wp_session_rss_bytes_est` from day one; the real answer is section 7, V1-P8, and no capacity or price is quoted before it |
| A takeover races a live socket and duplicates a send | Postgres-minted fence in every predicate plus takeover grace; the two mandatory concurrency tests |
| Team test numbers get restricted mid-phase | Use numbers we own and accept losing; Safe Mode defaults apply to dev instances too; never bulk-register numbers, which is itself a restriction pattern |
| Redis dies during a demo | Demonstrated deliberately - a safe full stop is the correct behaviour and the founder should see it |

**Founder sees.** Connects their own number by QR, watches it survive a deliberate crash and a Redis wipe with no rescan, and sees the encrypted blob in the database. No message can be sent yet; that is V1-P4.

---

## 6.5 V1-P4 - Durable queue: claim, attempts, reaper, reconciler

**Goal and why now.** Every send starts as a durable row, is claimed exactly once, and a crash mid-send never silently duplicates or loses a message. It precedes Safe Mode because the pacing reserve runs **inside** the claim transaction, so that transaction must exist and be proven first.

| In scope | Out of scope |
|---|---|
| `POST /v1/messages` with mandatory `Idempotency-Key`, plan queue-depth backpressure | The pacing reserve itself (V1-P5 slots into the same transaction) |
| DWRR band selection wired to the canonical claim | Priority as a delivery-speed promise (never; section 2) |
| `send_attempts` before the provider call; result recording with the zero-row hard error | Self-minted message ids unless SPIKE-1 proves dedupe |
| Reaper, reconciler, `blocked_needs_review` with the human choice | Automatic requeue of ambiguous sends (forbidden by design) |
| Outbox, relay, SSE fan-out, signed SSRF-guarded customer webhooks | Webhooks v2, event replay (section 8) |
| Campaign expansion cursor, if founder question 3 says yes | Segments, templates, A/B (v2) |

**Prerequisites.** V1-P3 green. **Blocking founder questions: 3** (are bulk campaigns in v1 at all - a "no" drops work package 8 and about 4 engineer-days) and **9** (default `ambiguous_send_policy`).

**Work packages.**

1. **Job creation with idempotency.** Where: `app/backend/src/modules/queue/`. One transaction inserting job + refs + outbox + audit; the idempotency conflict uses `ON CONFLICT DO UPDATE ... RETURNING` because `DO NOTHING` returns zero rows under a race and becomes a 5xx. The only externally visible id is `message_job_refs.public_id`. Offline instance returns 202 with `warning: INSTANCE_OFFLINE`; unlinked returns 409 - so the "park accounts to save RAM" capacity lever can never become a silent delivery failure. Tests: `app/backend/tests/integration/queue/create.test.ts::duplicate_idempotency_key_creates_one_job` (50 parallel identical POSTs, one row, 50 identical responses, **zero 5xx**), `::offline_instance_returns_202_with_a_warning_not_a_silent_success`.
2. **The claim loop.** Where: `roles/session-worker.ts`. `gate.admitInstance()` then DWRR pick (deficit 6:3:1, per-worker in-memory state rebuilt on lease acquisition) then the transaction: content guards, pacing reserve (a granting stub this phase, real in V1-P5) and `db/queries/claim-jobs.sql`, `LIMIT 1` because per-instance concurrency is 1. Zero rows is normal and rolls the whole transaction back. Tests: `.../claim.test.ts::two_workers_cannot_double_claim_one_job`, `::losing_claimant_rolls_back_its_whole_transaction`; `.../fairness.test.ts::high_flood_does_not_starve_low` (end-to-end half).
3. **Dispatch and result.** One transaction writes the `prepared` attempt, increments `attempts` **exactly once here and never in the claim**, and writes the dispatched event; then the send runs under a hard 45s timeout while the lease heartbeat renews the claim expiry. A zero-row result write is a **hard error**, increments `wp_claim_lost_total`, and leaves the outcome on the attempt row so the reaper repairs the job instead of discarding a successful send. Tests: `.../dispatch.test.ts::slow_media_send_does_not_lose_its_result`, `::zero_row_result_write_is_a_hard_error_and_preserves_the_outcome`.
4. **The reaper.** Every 15s, repairs expired claims by attempt state per section 4, with the `attempts` decrement applying **only** to `prepared` (the no-attempt case never incremented, so decrementing it would open an unbounded-retry path). Tests: `.../reaper.test.ts::reaper_never_drives_attempts_negative` (100 workers killed between claim and attempt insert; `min(attempts)=0`; jobs still terminate at `max_attempts`), `::acked_repair_sets_sent_at_and_writes_a_reconciled_event`.
5. **Reconciler and the human choice.** Ten-minute evidence window, echo-matched oldest-in-flight-first with 1:1 assignment; if more than one in-flight attempt shares a content hash, resolve **none** and count `wp_reconcile_ambiguous_total`. Expiry without evidence goes to `blocked_needs_review` with exactly "Retry (may duplicate)" / "Discard (may have been delivered)", and the chosen action writes an audit row with `actor_user_id`. No automatic requeue; the only exception is the per-client audited `ambiguous_send_policy`, default `ask_me`, inert after a restriction pause or logout. Tests: `.../reconcile.test.ts::echo_reconciles_ambiguous_hashes_conservatively`, `::unresolved_job_is_never_auto_requeued_under_default_policy`, `::leaving_blocked_needs_review_requires_an_actor_user_id`.
6. **Retry classes and backoff.** From `@wp/domain/retry/classify.ts`: transient requeues; `not_connected` requeues and degrades; `rate_limited` requeues with retry_after **and raises a health signal** consumed in section 7, V1-P6; invalid recipient/payload fail terminally; `restricted` and `unknown` **pause the instance**. Test: `.../retry.test.ts::unknown_error_class_pauses_the_instance_rather_than_retrying`.
7. **Outbox, relay, customer webhooks.** Where: `roles/relay.ts`, `modules/webhooks/`. SSRF-guarded at **every** dispatch with certificate verification never disabled, signed with a 5-minute window, auto-disabled after 20 consecutive failures (details in section 3). Tests: `.../webhooks/ssrf.test.ts::hostile_url_table_is_rejected_including_dns_rebinding`, `::tls_verification_is_never_disabled`.
8. **Campaign expansion (conditional).** Resumable cursor, batches of 500, one transaction per batch inserting jobs and refs against the dedupe unique index and advancing the cursor. Test: `.../campaigns/expansion.test.ts::campaign_expansion_is_idempotent_across_a_crash`.
9. **SPIKE-1.** Does WhatsApp deduplicate on a caller-supplied message id and echo it back? Until proven, `client_msg_id` stays nullable and unused for correctness and **no user-facing or ToS copy may state that duplicates are impossible**. Two days, written result.
10. **Pause end to end.** `.../pause.test.ts::pause_preserves_work_end_to_end`: pause mid-batch of 5,000, assert zero lost, zero failed, zero duplicated, and that resume drains in band order. This is the invariant-5 regression test and it runs in CI from here on.
11. **Suite B registration.** Send worker, reaper, reconciler and webhook dispatcher are added to the background-path registry.

**Invariants respected.** 1 (the API only creates rows; `api ↛ provider` still holds), 2 (ambiguous sends stop for a human, unknown errors pause), 3 (claim + refs + attempt uniqueness at the storage layer), 5 (pause preserves work, proven), 7.

**UI work.** Queue screen (depth, oldest queued age with its reason, per-band counts), message detail with the `delivery_events` timeline and attempt history in plain language, and the **Unresolved sends** list with the two-button human choice. Copy states what happened, what is preserved, when it resumes and what the user can do.

**Migrations.** 0021 `outbox_webhooks_and_campaigns`, 0022 `send_attempt_indexes_concurrently` (`-- wp:no-transaction`), 0023 `delivery_event_status_rank`. 0024-0028 reserved for V1-P5.

**Observability added.** `wp_send_total{result,error_class}`, `wp_instance_queue_depth`, `wp_instance_oldest_queued_seconds`, `wp_unresolved_jobs_total`, `wp_reconcile_ambiguous_total`, `wp_claim_lost_total`, webhook delivery counters. Alert: unresolved rate above 0.1% of sends per instance per day.

**Docs.** `docs/QUEUE.md` (lifecycle, retry matrix, reaper decision table, the reconciler's evidence rules and its honest failure mode), `docs/WEBHOOKS.md` (tenant-side signature verification example), the runbook section on unresolved sends.

**Exit criteria.** Verbatim green `scripts/ci`; mandatory tests 1, 2, 14-20 green by name; chaos evidence that 100 kills between dispatch and result produce zero lost jobs and zero silent duplicates; SPIKE-1 written up; a reviewer verdict answering the checklist question *"does the claim statement itself carry the fence, health, epoch, client and plan predicates, or is any of them checked outside the UPDATE?"* - outside means reject. **Demo:** send a real message from the panel; POST one `Idempotency-Key` 50 times and see one message with 50 identical responses; `kill -9` mid-send and watch the job land in Unresolved sends with the two-button choice; pause mid-batch, show the queue intact, resume, watch it drain.

**Effort.** 28-36 engineer-days, 2.5-3.5 calendar weeks.

| Risk | Mitigation |
|---|---|
| SPIKE-2 came back weak, so echo reconciliation is unreliable | `blocked_needs_review` plus the human choice already covers it; the metric makes the rate visible; the fallback is more human decisions, never an auto-requeue |
| Unresolved volume pushes tenants toward `resend_once` | Founder question 9 sets the default; either way it is in the ToS and stays inert after a restriction pause |
| The claim is fast in tests, slow at 10,000 queued jobs per instance | An `EXPLAIN` assertion test on the claim path; real numbers in section 7, V1-P8 |
| A refactor moves a predicate out of the claim UPDATE | The named reviewer checklist question plus per-predicate zero-row tests from V1-P1 |

**Founder sees.** Real WhatsApp messages sent from the product at an unpaced rate, a deliberately crashed worker failing honestly instead of duplicating, and a pause that loses nothing. At this point WP is a working sender with no safety limits - which is exactly why V1-P5 is next and why nothing is sold before it.

---

## 6.6 V1-P5 - Safe Mode: pacing ledger, warm-up, content guards, opt-out registry

**Goal and why now.** Every send is paced by **one** atomic authority a tenant cannot loosen, and a self-imposed cap **defers** work instead of failing it. It follows the queue immediately because an unpaced sender is the fastest way to get our own test numbers restricted, and because the reserve statement lives inside the claim transaction built in V1-P4.

| In scope | Out of scope |
|---|---|
| `pacing_ledger` as the only grantor; reserve/deny/release; plan cap via `client_daily_usage` | Any tenant off-switch (does not exist by design) |
| `instance_pacing_state` materialised limits + `PacingConfigService` | Real health bands driving the multipliers (section 7, V1-P6) |
| Warm-up tiers, time- and health-gated | Reply-rate gating (never - it traps transactional senders) |
| Redis advisory pre-filter that can only deny | Redis as a grantor (forbidden) |
| `SendOrigin` with internal-only exemptions | Any client-settable bypass (forbidden) |
| Hashed opt-out registry, 3 enforcement points, Hindi/Hinglish keywords | DSAR automation (v2) |
| Content guards: dup fan-out, link-in-first, two-list blocked words, rolling per-recipient frequency, cold ratio | Content classification or AI scoring (not in v1 or v2) |

**Prerequisites.** V1-P4 green. **Blocking founder questions: 7** (warm-up length versus customer patience), **8** (steady-state daily cap - any real observed number beats our guess), **12** (24-hour window for transactional instances), **13** (group actions during warm-up), **17** (who may grant a looser profile), **18** (high opt-out rate policy). Questions 7 and 8 set the seed data in migration 0024 and are the numbers most likely to cause either churn or restrictions.

**Work packages.**

1. **Profiles, tiers, resolver.** Where: seeds in `db/seeds/`, resolver in `packages/domain/src/pacing/`. Six tiers over roughly 30 days (day 1 about 20 messages, steady about 600-1,000/day/number, 2,000 hard ceiling, no tier unlimited). Strictest-wins fold of profile, tier, band multiplier and overrides, with `ABSOLUTE_GAP_MIN_MS` and `ABSOLUTE_DAILY_CEILING` applied **after** any admin relaxation. Tests: `packages/domain/tests/pacing-resolver.test.ts::tenant_can_tighten_never_loosen` (property test over random tenant **and** admin patches, asserting no tenant-settable field - including `engagement_exempt` and `pacing_timezone` - can raise a cap or lower the gap through any path including the health band), `::admin_relax_is_bounded_by_absolute_constants_and_expires`.
2. **`PacingConfigService`.** Any profile, warm-up, band or override change rewrites the `eff_*` columns **in the same transaction** and bumps `config_version`, so the reserve statement never reads a cached cap. Test: `app/backend/tests/integration/pacing/config.test.ts::tightening_takes_effect_on_the_very_next_reserve`.
3. **The reserve statement.** Where: `db/queries/` + `modules/pacing/`. One conditional UPDATE reading limits in-statement and computing the local ledger date and hour **inside** the statement, seeding ledger rows with `ON CONFLICT DO NOTHING` so the first send of a day is not a false alarm. Zero rows means deny; a cheap follow-up SELECT produces the human reason and `retryAt`; `UNKNOWN` is fail-closed. Tests: `.../reserve.test.ts::reserve_is_atomic_under_50_parallel_claims` (extended to the hourly cap, 200 iterations against real Postgres), `::min_gap_is_never_violated_under_parallelism`, `::new_conversation_cap_and_cold_ratio_are_atomic`, `::daily_cap_resets_at_local_midnight_not_utc` (including a DST zone), `::timezone_change_cannot_reset_the_daily_cap`, `::first_reserve_of_a_new_local_day_grants_without_a_hold`, `::plan_daily_cap_is_enforced_by_the_same_statement`.
4. **Refund and rollback discipline.** `release()` joins on the ledger date returned by the reservation, never a caller-supplied date; `PROVIDER_ATTEMPTED` is never refunded; a losing claim race rolls back rather than compensating. Tests: `.../reserve.test.ts::reserve_is_rolled_back_when_no_job_is_claimed`, `::refund_after_local_midnight_hits_the_right_day`, `::orphan_reservation_is_not_refunded`.
5. **Redis advisory pre-filter.** A Lua script returning "definitely not eligible" or "ask Postgres"; it can never grant, so Redis loss costs latency, never correctness. Tests: `::postgres_is_authoritative_when_redis_is_wrong`, `::redis_outage_degrades_but_never_over_sends`, `::postgres_outage_stops_sending_and_loses_nothing`.
6. **Deferral semantics.** Gap, cap, window, frequency, ack, paused and not-connected reasons leave the job **queued** with `attempts` untouched and `pacing_deferrals` incremented; `OPT_OUT` **cancels** with `cancel_reason='opt_out'` and is excluded from every health denominator; blocked word and link-in-first fail that job only with actionable copy. Test: `.../deferral.test.ts::deferral_never_increments_attempts_or_fails_the_job` (trips every reason and asserts `next_attempt_at` to the second).
7. **Warm-up ramp.** A `ROLE=cron` step requiring elapsed days, no hard restriction signal in 24h and band at least watch; it writes `pacing_events` + `audit_logs` + a notification and bumps `config_version`. WATCH freezes, DEGRADED rolls back one tier, and skipping the ramp is not purchasable. Tests: `.../warmup.test.ts::warmup_progresses_on_time_not_on_reply_rate` (0% reply rate for 40 simulated days still reaches steady tier), `::warmup_freezes_in_watch_and_rolls_back_in_degraded`.
8. **`SendOrigin` and the absence of a bypass.** An enum parameter, never a payload field; exempt members constructible only under `modules/pacing/internal/`; request schemas `.strict()` with no `origin` field. Exempt sends are still counted, still opt-out-blocked, still content-guarded, still window-bound and still write a `pacing_events` row. Test: `.../origin.test.ts::send_origin_cannot_be_supplied_by_a_client` (covering `origin`, `__systemReply` and header variants); the static half already lives in `no_forbidden_mechanism_exists`.
9. **Opt-out registry.** Hashed phone with an encrypted display value and **no raw number indexed anywhere**; normalised keyword matching including `band karo`, `mat bhejo`, `rok do`, `बंद करो`; tenants may add keywords but never remove platform ones; enforced at API creation, at claim-time guard and pre-send inside the send transaction. One confirmation per contact per 30 days, exempt from caps and gap but **still window-bound**, so a 03:00 STOP defers its confirmation to window open. Tests: `.../compliance/optout.test.ts::optout_hard_blocks_at_all_three_points` (including that the exempt system origin is still blocked), `::optout_keyword_matching_precision` (with the negatives "please don't stop sending updates" and "stopwatch order"), `::optout_cancels_queued_jobs_and_is_idempotent`, `::optout_confirmation_respects_the_sending_window`.
10. **Content guards.** Duplicate fan-out counted by distinct recipients with `ON CONFLICT DO NOTHING` (never an increment, so re-evaluation cannot inflate it), warning at 150 and requiring a human ack at 500 while jobs stay **queued**; link-in-first blocked in weeks 1-2, warned in week 3, allowed from week 4; blocked words from a non-removable platform list plus an additive tenant list, showing the category and never the matched list; per-recipient frequency as true rolling windows across instances of the same client; up to 25 terminal-guard disposals per pass so a 1,000-row opted-out list drains immediately. Tests: `.../guards.test.ts::duplicate_fanout_holds_not_fails`, `::blocked_word_and_first_message_link_fail_only_that_job`, `::per_recipient_frequency_is_enforced_across_instances` (crossing local midnight), `::guard_disposals_are_batched_up_to_25_per_pass`.
11. **Jitter.** `drawGapMs` (bounded log-uniform) and `applyLongPause` split into two functions with a seeded RNG so the distribution test is deterministic. Tests: `packages/domain/tests/jitter.test.ts::jitter_distribution_is_log_uniform_and_bounded`, `::long_pause_fires_within_18_to_35_sends`.
12. **Copy, PII, isolation.** The full `copy.ts` using `SAFE_MODE_DISCLAIMER` verbatim; a log capture across every pacing path; pgTAP isolation across every pacing and compliance table including the background evaluator's own queries. Tests: `app/backend/tests/static/copy.test.ts::copy_contains_no_banned_claims`; `.../pacing/logs.test.ts::no_pii_in_pacing_logs`; `db/tests/isolation/pacing.test.ts::tenant_isolation_on_every_pacing_table`.

**Invariants respected.** 3 (one conditional UPDATE is the grant, not an in-memory check), 4 (every pacing table is tenant-scoped and RLS-covered), 5 (a cap defers, never fails or deletes), 6 (no bypass path exists, proven by property test and static analysis), 7.

**UI work.** The Safe Mode card: profile, tier and day, today's count against cap, new conversations against cap, next-send countdown, sending window, health score with a "why?" drawer (fully populated in section 7, V1-P6), queue depth, oldest queued age, last send. Paced state reads "paced - next window HH:MM", never an error. Plus the duplicate-fan-out acknowledgement dialog, opt-out list management, and tenant tightening controls that can only tighten.

**Migrations.** 0024 `pacing_profile_and_tier_seeds`, 0025 `pacing_effective_limits_backfill` (populate `eff_*`, then add NOT NULL), 0026 `optout_platform_keywords_seed`, 0027 `content_guard_indexes_concurrently` (`-- wp:no-transaction`), 0028 `pacing_events_retention`. 0029+ belong to section 7.

**Observability added.** `wp_pacing_reserve_total{result,reason}`, `wp_pacing_deferrals_total{reason}`, `wp_pacing_gap_ms`, `wp_pacing_orphan_reservations_total`, `wp_pacing_ledger_repair_total`, `wp_content_guard_trips_total`, per-client opt-out rate. Alerts: orphan reservations above 0.5% of sends; ledger repair above 5 units; opt-out rate above 10 per 1,000 for a client (a content problem worth telling the tenant about before WhatsApp does).

**Docs.** `docs/SAFE-MODE.md` (the grant model, the deferral table, the founder-confirmed warm-up ladder, and the honest-limits list verbatim), the tenant help page, and ToS clauses covering deferral, warm-up and ban-risk disclosure.

**Exit criteria.** Verbatim green `scripts/ci`; the amended Safe Mode suite green by name - tests 1, 3-9, 16-23, 25-29, 31, 32 plus `tightening_takes_effect_on_the_very_next_reserve`, `timezone_change_cannot_reset_the_daily_cap`, `first_reserve_of_a_new_local_day_grants_without_a_hold`, `refund_after_local_midnight_hits_the_right_day`, `reserve_is_rolled_back_when_no_job_is_claimed` (tests 10-15, 24 and 30's dynamic half are section 7, V1-P6 gates); an opus-tier reviewer verdict answering one question: is there **any** path - config, header, payload, feature flag, plan entitlement, timezone, health flag - by which a tenant can raise or bypass a limit? **Demo:** queue 500 messages and watch them leave at a paced, jittered rate with the countdown running; set a daily cap of 10 and watch send 11 stay **queued** as "paced - next window", not failed; change the instance timezone and watch the cap not reset; send `band karo` from a test recipient and watch that contact's queued jobs cancel with exactly one confirmation reply; queue 600 identical bodies and watch them hold for a human ack; POST `origin: "SYSTEM_REPLY"` and get a 400.

**Effort.** 30-38 engineer-days, 3-3.5 calendar weeks. About a third is tests: the atomicity test alone runs 200 iterations against real Postgres, and the property test over config patches is the control that makes "no bypass exists" defensible.

| Risk | Mitigation |
|---|---|
| Warm-up and cap defaults are judgement, not measurement; no credible public source states a safe per-day number for an unofficial linked device | Stated plainly in docs and in the panel; founder question 8 asks for any real observed number; revised from our own data after section 7, V1-P8 |
| Tenants experience Safe Mode as the product being slow | The panel always shows cause, count, cap and next window; the offered fix is more numbers each properly warmed, never looser limits |
| Commercial pressure for a "faster tier" | Founder question 17; "pay more, send faster" is a pacing bypass sold rather than coded, and absolute floors/ceilings bound every relaxation |
| Reserve latency becomes the fleet bottleneck | p99 under 25 ms is a gate in section 7, V1-P8; the advisory pre-filter keeps denied instances off the database entirely |
| Band multiplier plumbing ships before the scorer exists | This phase pins the band to `healthy` and tests the multiplier path with injected bands; V1-P6 supplies real bands with **no change** to the reserve statement |

**Founder sees and must hear.** The product refusing to send too fast, too cold, or to someone who opted out - and **deferring** rather than failing, with the queue intact and the panel explaining itself. Stated in the same session, in the demo and in the docs: Safe Mode reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold; **it cannot prevent or guarantee against WhatsApp restrictions**, because bans also come from recipient reports, message content and account reputation, which no sender-side pacing controls. In v1 that residual risk lands on the tenant's real number with no appeal path, and it is disclosed at onboarding rather than hidden.

---

## 6.7 Part A summary and what is deliberately still missing

| Phase | Engineer-days | Calendar weeks | Gate in one line |
|---|---|---|---|
| V1-P0 Foundations, guardrails and local CI | 12-15 | 1-1.5 | CI red on every forbidden construct, no guard matching zero files |
| V1-P1 Data model, migrations and tenant isolation proof | 20-24 | 2-2.5 | Suite A turns red when a `client_id`-less table is added |
| V1-P2 Identity, onboarding and the panel shell | 24-30 | 2-3 | Playwright signup-to-connect green; no route without policy and scope |
| V1-P3 Baileys session engine | 34-42 | 3-4 | `kill -9` storm reconnects with zero re-QR; engine tests 3-14 green |
| V1-P4 Durable queue | 28-36 | 2.5-3.5 | 100 kills between dispatch and result: zero lost, zero silent duplicates |
| V1-P5 Safe Mode | 30-38 | 3-3.5 | Amended Safe Mode suite green; no bypass path exists |
| **Part A total** | **148-185** | **13-16** | |

At the end of Part A the product can sign a customer up, link their WhatsApp number, send paced messages, survive crashes without duplicating or losing work, and refuse unsafe sending in ways a tenant cannot switch off. It still cannot: score its own health from real signals or pause itself on them; show a full real-time panel with an operator runbook; state a **single measured** capacity or price number - every figure in section 5 is derived, and quoting one before the scale proof would be a claim we cannot support; offer staff a console; or present a marketing site. Those five phases are section 7.


---

# 7. v1 delivery plan - Part B (V1-P6 - Health, signals, pause/resume and notifications to V1-P10 - Marketing website (Next.js))

Part A (section 6) delivered the machine: guardrails, schema, identity, the Baileys session engine, the durable queue and the Safe Mode ledger. At the end of V1-P5 the system can accept a durable job, pace it, claim it exactly once and send it - but it is deaf. It does not yet read what WhatsApp is telling it, it cannot show an operator what is happening, and nobody has weighed a single session. Part B closes those three gaps, then adds the two surfaces the founder deliberately sequenced last: the admin panel and the marketing website.

Every phase below uses the same structure as Part A: **Goal · Dependencies and effort · Scope boundary · Work breakdown · Key implementation decisions · Tests that gate this phase · Exit gate · Risks and honest limits.** Each phase ends with verbatim green `scripts/ci` output plus its named gate; nothing else counts as done (core invariant 7). Phases are sequential - V1-P8 in particular cannot be pulled forward, because it measures the system that P6 and P7 complete.

Effort figures are estimates for one full-time implementer working the TDD loop described in section 6, not commitments. They are stated so the plan can be scheduled, and they are the least reliable numbers in this document.

---

## V1-P6 - Health, signals, pause/resume and notifications

**Goal:** real WhatsApp signals tighten or pause an instance automatically, and only an authenticated human being can start it sending again.

**Dependencies:** V1-P5 (the pacing ledger and `instance_pacing_state` must exist, because the health band is an input to the effective limits that the reserve statement reads in-statement). **Estimated effort:** 2.5-3 weeks.

### Scope boundary

| In V1-P6 | Not in V1-P6 |
|---|---|
| Evidence collectors for **all twelve** signals (`2026-08-25-v1-design-safe-mode.md` §3.1) | Scoring all twelve - v1 scores three plus the `rate_limited` fast lane |
| `HealthEvaluator`: score, four bands, hysteresis, dwell, flap suppression | Any auto-resume, any timer-based recovery, any "retry in 24h" |
| `hard_signal_pause` evidence row (the future labelled dataset) | Re-tuning weights from outcome data - there is no outcome data yet |
| Resume endpoint with actor-type rejection and restriction acknowledgement | Staff-initiated resume (that arrives in V1-P9, and is still a staff *user*) |
| `notify()` fan-out: in-app, email, customer webhook, with a dedupe key | SMS/WhatsApp alerting to the tenant (v2; alerting a tenant about their WhatsApp problem over WhatsApp is circular) |
| Instance card, health "why?" drawer, Unresolved sends list | The full analytics dashboards (V1-P7 owns metrics; section 8 owns the product spec) |

### Work breakdown

1. **Signal collectors**, one file per signal under `app/backend/src/modules/pacing/signals/`, each exporting `collect()` and `severity()`. Sources are already flowing after P3-P5: `connection.update` close codes, worker outcome classes, `message-receipt.update`, `onWhatsApp` misses, `opt_outs` inserts, `messages.upsert` inbound, and our own `pacing_ledger`. Each collector writes only counts and ratios - never a phone number, JID or body - into `instance_health_samples`.
2. **Windows and evidence storage.** Windows are 1h/6h/24h/72h per signal, computed from `delivery_events` and `send_attempts` roll-ups rather than table scans, because at V1-P8 volumes a per-tick full scan of `delivery_events` would become the most expensive query in the system. Each evaluation writes `instance_pacing_state.last_evidence` as the raw numerator/denominator per signal.
3. **`HealthEvaluator`** on a 5-minute tick per connected instance: `health_score = clamp(0, 100, 100 - Σ weight_i × severity_i)`, weights summing to 120, per-signal EWMA α = 0.3, per-signal **minimum evidence** below which the penalty is exactly 0 (an instance with 4 sends is unmeasured, not unhealthy).
4. **Fast lanes**, evaluated on every send outcome rather than on the tick: the hard-restriction override (403/402/406/`loggedOut`) which pauses immediately, the transient-failure signal, and provider `rate_limited` responses which force at least WATCH within one tick **[R-14w]**.
5. **Bands and transitions.** HEALTHY ≥70 (×1.00 cap, ×1.0 gap) · WATCH 55-69 (×0.70, ×1.5, new conversations ×0.5, warm-up frozen) · DEGRADED 35-54 (×0.40, ×2.5, zero new conversations, one warm-up tier rolled back) · CRITICAL <35 (instance paused). Tightening applies on the first tick that crosses the threshold. Loosening requires all of: +8 points of hysteresis (WATCH→HEALTHY needs 78, DEGRADED→WATCH needs 63), a dwell period (2h and 6h respectively), no hard signal in 24h, and at most one improvement per 6h / two per 24h **derived from the `pacing_events` timeline, not from a counter column** [R-20s].
6. **Band change writes limits, atomically.** A band change calls `PacingConfigService`, which rewrites the materialised `eff_*` columns on `instance_pacing_state` and bumps `config_version` **in the same transaction**, so the next `pacing.reserve()` reads the new caps in-statement [R-28w]. There is no worker-side cache to invalidate.
7. **`hard_signal_pause` evidence row.** Every restriction pause writes one `pacing_events` row containing the complete signal vector, effective limits, warm-up tier, account age and 30-day send history [R-10s]. This row is the only asset that will ever make the score tunable; it is written before the notification, inside the pause transaction, so a notification failure cannot lose it.
8. **Pause and resume.** Pause is a health-service write to `whatsapp_instances.health_state` + `pause_reason` + `paused_at` + `needs_user_action`; the claim SQL predicate does the rest, so sending stops without any worker-side coordination. `POST /v1/instances/:id/resume` returns 403 for `actor_type='api_key'` and `actor_type='system'` in **all** cases, requires `owner`/`admin` role, and additionally requires an acknowledgement flag when `pause_reason='provider_restriction'` [R-7c] [R-15].
9. **`notify()` fan-out** with a dedupe key (`instance_id ‖ kind ‖ bucketed_time`) so a reconnect storm cannot become an alert storm. Mandatory, non-suppressible notifications: pause of any cause, logged out, reconnect budget exhausted, duplicate-fan-out ack required, unresolved send, plan cap reached.
10. **Panel surfaces:** instance card (band, score, tier, today vs cap, next send countdown, window, queue depth, oldest queued age), the health **"why?"** drawer showing every signal with measured value, window, whether it is currently penalising and its evidence, and the **Unresolved sends** list wired to the P4 `blocked_needs_review` flow with its exact two-button copy: "Retry (may duplicate)" / "Discard (may have been delivered)".

### Key implementation decisions

- **Ship the evidence machinery for twelve signals, score three.** v1 scores hard restriction, rejected-send rate and delivery ratio, plus the `rate_limited` fast lane [R-27s]. The other nine weights are hand-set guesses with no labelled ban-outcome dataset behind them; scoring them would produce confident-looking numbers that punish innocent tenants. They collect evidence from day one so that a month of data can activate them with a config change and a re-run of the evaluator over stored samples.
- **`health_score` lives only on `instance_pacing_state`**, written only by the pacing evaluator; `health_state` lives only on `whatsapp_instances`, written only by the health service [R-51]. A test asserts no other module writes either column - two writers of a health field is how a paused instance silently resumes.
- **`engagement_exempt` is display-only.** It changes the shown reason and the warm-up-freeze decision. It never changes the score feeding a band multiplier and never touches the cold-ratio gate [R-19c]. Enforced structurally: the flag lives in a type the pacing gate cannot import, and a test asserts `resolveEffective()` returns identical limits with the flag true and false.
- **Band flapping is our bug, not the tenant's.** `wp_pacing_band_flaps_total` > 3/day on one instance raises an ops alert that means "the thresholds are wrong", and the third change within an hour is applied only in the tightening direction.

### Tests that gate this phase

| Test | Asserts |
|---|---|
| `hard_restriction_signal_pauses_immediately` (10) | injected 403/402/406/`loggedOut` → `paused` within one tick, zero further claims, **all queued jobs still `queued`**, notification + webhook emitted |
| `paused_instance_never_auto_resumes` | 72 simulated hours of clean signals on a paused instance → still paused, zero claims, zero state writes toward sending |
| `resume_rejects_non_user_actors` (11, amended) | API-key actor → 403; system actor → 403; user without acknowledgement on a restriction pause → 422; user with acknowledgement → 200 + audit row with `actor_user_id` |
| `signal_driven_tightening_reduces_caps` (12) | delivery ratio 55% + opt-out 12/1,000 → WATCH within 2 ticks, `eff_daily_cap` = 0.7×, gap ×1.5, evidence recorded |
| `hysteresis_and_dwell_prevent_flapping` (13) | score oscillating across a threshold for 6h → ≤2 improvements in 24h, tightenings immediate, flap counter bounded |
| `reply_rate_alone_cannot_leave_healthy_or_pause` (14) | 0% reply rate, everything else perfect → score ≥90, HEALTHY, never CRITICAL |
| `min_evidence_protects_new_instances` (15) | 4 sends, 1 failure → 0 penalty from that signal |
| `band_change_and_effective_limits_are_one_transaction` | kill the evaluator between the band write and the limits write → no state where band and `eff_*` disagree |
| `no_forbidden_mechanism_exists` (30, extended) | static scan: the resume handler's authz guard names a user principal; no timer, cron or system actor can reach a resume path |
| `notification_storm_is_deduped` | 40 reconnect events in 60s → one notification per kind per bucket |

### Exit gate

Tests 10-15, 24 and 30 green; `paused_instance_never_auto_resumes` green over 72 simulated hours; a manually injected restriction on a seeded instance produces a `hard_signal_pause` row containing the full signal vector, a panel banner, an email and a webhook - and produces **zero** sends until a seeded user clicks Resume with the acknowledgement.

### Risks and honest limits

The health score is a well-instrumented heuristic wearing a number. There is no ground truth to fit it against: we have no dataset of accounts that were later restricted, which is precisely why the `hard_signal_pause` evidence row exists. Automatic tightening **will** produce false positives - a bad ISP hour can push an innocent instance to DEGRADED and cut its cap by 60%, and hysteresis limits flapping but not that. WhatsApp typically gives no graduated warning before restricting an unofficial client; our first knowledge is often the 403 disconnect itself. We pause fast; we cannot pre-empt. None of this may be softened in tenant-facing copy - the `SAFE_MODE_DISCLAIMER` ships verbatim on every surface that mentions Safe Mode.

---

## V1-P7 - Realtime, observability and the operator runbook

**Goal:** the panel tells the truth in real time, and an operator can diagnose the fleet without SSH access to a box.

**Dependencies:** V1-P6 (there is nothing honest to display until health state is real). **Estimated effort:** 2-2.5 weeks. This phase is also the instrumentation prerequisite for V1-P8: every number the scale proof publishes comes from a metric wired here.

### Scope boundary

| In V1-P7 | Not in V1-P7 |
|---|---|
| SSE channels, per-tenant, authorised at connect and re-checked on membership change and `token_epoch` bump | WebSocket, bidirectional realtime, presence (ADR 0010; v2) |
| Every metric in the observability table, wired and asserted present | Distributed tracing across every hop (OTel SDK is installed and the send path is traced; full Tempo coverage is v2) |
| Grafana + Prometheus + Loki + Alertmanager + Uptime Kuma + GlitchTip in `infra/observability/` | A managed APM vendor (`2026-08-25-infra-deploy-ops-costs.md` §5: self-hosted LGTM on the box at this tier) |
| `docs/RUNBOOK.md` with rehearsed procedures | On-call rotation tooling, paging vendor |
| Log-grep PII test in CI | Log-based anomaly detection |

### Work breakdown

1. **SSE transport.** One connection per authenticated session, served by `ROLE=api`, fed by the outbox `relay`. Channel authorisation at connect, re-checked on membership change and on `token_epoch` bump, so a revoked membership drops the socket within 5 seconds - and that claim is a test, not a sentence [R-35]. Events carry **ids and enums only**; the client refetches through the authorised API.
2. **Event catalogue wired end to end:** `instance.qr` (the challenge payload is a bearer credential: never logged, never a metric label, never an audit metadata value [R-8c]), `instance.health_changed`, `instance.pacing_changed`, `message.job.sent|failed|delivered|read`, `job.needs_user_action`, `campaign.progress`.
3. **Metrics.** All of: `wp_instance_health_state`, `wp_instance_link_state`, `wp_instance_queue_depth`, `wp_instance_oldest_queued_seconds`, `wp_send_total{result,error_class}`, `wp_pacing_reserve_total{result,reason}`, `wp_pacing_deferrals_total{reason}`, `wp_pacing_gap_ms`, `wp_health_score`, `wp_health_band_changes_total{from,to}`, `wp_pacing_band_flaps_total`, `wp_reconnect_attempts_total{code}`, `wp_lease_takeovers_total`, `wp_lease_lost_total`, `wp_fence_regression_total`, `wp_instances_unowned`, `wp_fleet_capacity_headroom`, `wp_worker_sessions`, `wp_worker_eventloop_lag_p99`, `wp_session_rss_bytes_est`, `wp_unresolved_jobs_total`, `wp_reconcile_ambiguous_total`, `wp_claim_lost_total`, `wp_pacing_orphan_reservations_total`, `wp_pacing_ledger_repair_total`, `wp_connect_bucket_wait_seconds`. A test enumerates the exported registry and fails if a named metric is missing - a metric that exists only in a design document is not observability.
4. **Cardinality discipline.** `client_id`/`instance_id` are labels only on gauges that are already per-instance and bounded by the fleet size; they are **never** labels on counters or histograms, where 1,000 instances × error classes would multiply series past what a single Prometheus on a shared box can hold. Per-instance detail comes from the database, not from the metric store.
5. **Dashboards** in `infra/observability/`, checked into the repo as JSON: Fleet (sessions, unowned, headroom, takeovers, event-loop lag, RSS/session), Send path (send rate by result and error class, queue depth, oldest queued, claim latency, reserve p50/p99), Safe Mode (band distribution, deferrals by reason, gap histogram, warm-up tier distribution), Honesty (unresolved, ambiguous, claim-lost, orphan reservations, ledger repair), Infra (PG, Redis, disk, backup age).
6. **Alerts**, routed to email plus a chat webhook: any hard-signal pause · `wp_instances_unowned` > 0 for 2 min · unresolved rate > 0.1%/day/instance · > 3 band flaps/day · orphan reservations > 0.5% of sends · opt-out rate > 10/1,000 for a client · ledger repair > 5 units · fleet headroom < 20% · any `wp_fence_regression_total` · backup age > 30 min · schema-version mismatch on boot.
7. **`docs/RUNBOOK.md`**, one rehearsed procedure per section, each ending in a verification step: pause/resume an instance · a tenant says "nothing is sending" (the decision tree: paused? deferred by cap or window? unowned? client suspended? plan cap?) · reconnect budget exhausted · unresolved sends triage · Redis loss and recovery · Redis flush and the expected single takeover cycle · fence regression investigation · KEK rotation · restore drill · rolling deploy and rollback to the retained tag · adding a worker box · draining a worker for maintenance.
8. **PII enforcement in CI.** The log-grep test drives a full end-to-end flow with a seeded tenant, then greps the entire log stream, all metric labels and all audit metadata values for that tenant's phone number, message body, email and API key, and fails on any hit. The logger's field allow-list (ids, enums, counts, durations, error classes) makes free-form `meta: any` structurally impossible.

### Key implementation decisions

- **Queue lag is reported in two numbers, never one.** `oldest_queued_seconds` mixes two causes that mean opposite things: infrastructure lag (we are behind - our problem) and pacing deferral (we are deliberately waiting - working as designed). The panel and the dashboards separate `wp_instance_oldest_queued_seconds` from `wp_instance_oldest_eligible_queued_seconds` (jobs whose `next_attempt_at` and pacing window have already passed). Only the second is an alert. Conflating them would make every healthy Safe Mode instance look broken.
- **The observability stack runs on the same box at v1 proof scale** and moves to a 2 vCPU / 4 GB box the moment it competes for RAM with sessions - which V1-P8 will show. Grafana + Prometheus + Loki is comfortable in ~8 GB; that is 230 sessions' worth of RAM, so this split is a scale-proof output, not a preference.
- **Uptime Kuma is external-perspective only** (is the API answering, is the site up) and lives off the app box, because a monitor sharing a failure domain with the thing it monitors reports "all green" while the box burns.

### Tests that gate this phase

| Test | Asserts |
|---|---|
| `log_stream_contains_no_tenant_pii` | full flow → zero hits for phone, body, email, API key across logs, metric labels, audit metadata |
| `qr_payload_never_leaves_the_tenant_channel` (suite C) | Redis key enumeration + log scan: no pairing payload outside the owning tenant's namespace [R-8c] |
| `revoked_membership_drops_sse_within_5s` | membership removal → socket closed, `token_epoch` bumped, reconnect rejected |
| `every_declared_metric_is_exported` | registry enumeration vs the canonical list |
| `unowned_instance_alert_fires` | stop a worker holding leases → `wp_instances_unowned` > 0 → alert fires within 2 min → instance goes `degraded` with `INFRA_UNAVAILABLE` after 3 scan cycles [R-37] |
| `pacing_deferral_is_not_an_alert` | an instance sitting on `DAILY_CAP` for 6h raises zero alerts and shows "paced - next window HH:MM" in the panel |

### Exit gate

Log-grep test green; the `wp_instances_unowned` alert demonstrated live by stopping a worker and screenshotting the fired alert plus the tenant-visible `INFRA_UNAVAILABLE` banner; every runbook procedure executed once against the staging box by someone following only the document, with the verification step passing.

### Risks and honest limits

Observability on one box is a single failure domain: if the box dies, so do the dashboards that would explain why. The mitigation at v1 is Uptime Kuma running elsewhere plus alert delivery by email, not a second observability cluster. Prometheus retention on a shared box is measured in weeks, not years; long-horizon capacity analysis after V1-P8 depends on exporting the run's results to a file, which is why V1-P8 has a results template rather than "check Grafana later".

---

## V1-P8 - Scale proof: synthetic and real-account measurement

**Goal:** replace every derived capacity number in this plan with a measured one, and answer the founder's 1,000-account question with evidence instead of arithmetic.

**Dependencies:** V1-P7 (nothing can be measured before it is instrumented). **Estimated effort:** 1.5 weeks of build plus **9-10 calendar days of run time** that cannot be compressed - the 7-day drift run is the point. **This is the phase that unblocks any pricing or capacity claim.**

### What is actually being asked, and what is currently known

The founder's question is "will roughly a thousand accounts run on one or two small boxes?" The plan's current answer is derived, not measured: at an assumed ~35 MB RSS per idle connected session, 1,000 concurrent sessions is ~35 GB for sockets alone, plus worker overhead, plus 2-5 GB of Redis and Postgres - roughly **45-50 GB RAM and 10-12 dedicated vCPU**, i.e. two 8 vCPU / 32 GB worker boxes plus a third 8/32 for Postgres and Redis, about **USD 400-560/month**. If a session actually costs 60-80 MB - entirely plausible for accounts with large contact sets, because the Signal working set scales with distinct contacts - the fleet and the cost roughly double. That single unmeasured number carries the entire cost model.

The escape hatch is real and it is what makes a small fleet possible: **not every registered account needs to be connected.** 1,000 registered accounts at a realistic 30% concurrency is ~300 connected, ~11 GB, which genuinely fits one 8 vCPU / 32 GB box. The caveats are equally real: a parked linked device receives nothing while offline (it syncs on reconnect, and WhatsApp's offline buffer is neither unlimited nor documented), and cycling accounts hourly to save RAM is not something we build. **"1,000 registered" and "1,000 connected simultaneously" are different products at different prices**, and V1-P8 is where the plan stops guessing which one v1 can sell.

**Nothing measured below has been measured yet. Every capacity figure and every price in this document is derived and may not be quoted to a customer before this phase completes.**

### Pre-registered pass/fail thresholds

These are written down **before** the runs, so that a disappointing result is a finding rather than a negotiation. Each threshold names the consequence of failing it.

| # | Metric | Pass | Investigate | Fail (triggers the named action) |
|---|---|---|---|---|
| 1 | RSS delta per idle connected session | ≤ 45 MB | 45-70 MB | > 70 MB → re-price the capacity table and open the per-session-memory workstream (v2 lever 1) before any pricing page ships |
| 2 | RSS delta per actively-sending session (Safe Mode steady pace) | ≤ 70 MB | 70-100 MB | > 100 MB → `MAX_SESSIONS_PER_WORKER` drops below 150 and the box order changes |
| 3 | 7-day RSS drift per session (hour 12 → hour 168) | ≤ 10% growth | 10-25% | > 25% → leak; phase does not pass, debugger workstream opens |
| 4 | CPU per idle session | ≤ 0.5% of a vCPU | 0.5-1.0% | > 1.0% → vCPU model rewritten; the 10-12 vCPU fleet figure is wrong |
| 5 | Event-loop lag p99 at target session count | ≤ 200 ms | 200-400 ms | > 400 ms → sessions-per-worker cap reduced until it is met (this is already the soft-yield threshold) |
| 6 | Redis memory per session | ≤ 5 MB | 5-8 MB | > 8 MB → Redis gets its own box earlier than planned; signal-key TTL and eviction re-tuned |
| 7 | Connection stability: fraction of sessions connected at any 1-minute sample over 168h | ≥ 99.0% | 97-99% | < 97% → not shippable; reconnect logic re-opened |
| 8 | Unexpected logout rate (401/411/500) per session per 7 days, **synthetic** | 0 | any | any → mock or auth-state bug; must be explained before Phase B |
| 9 | Lease takeover after `kill -9` | ≤ 45s median, ≤ 60s p95 | 60-90s p95 | > 90s → `TIMING` values re-derived |
| 10 | Full reconnect of 150 sessions after a worker kill | ≤ 3 min p95 | 3-6 min | > 6 min → connect-bucket rates re-tuned (and the tenant-visible impact documented) |
| 11 | Infra queue lag: eligible-to-claimed latency p99 | ≤ 5s | 5-15s | > 15s → claim loop or scheduler is the bottleneck |
| 12 | `pacing.reserve()` p99 at 1,000 simulated instances | < 25 ms | 25-50 ms | > 50 ms → ledger indexing or contention problem |
| 13 | Cap violations across every run | **0** | - | any → hard fail; Safe Mode is not correct |
| 14 | Lost jobs, silent duplicates | **0** | - | any → hard fail; invariants 1, 3, 5 broken |
| 15 | Unexplained `blocked_needs_review` (no injected chaos to account for it) | **0** | - | any → hard fail |
| 16 | `wp_fence_regression_total`, `wp_claim_lost_total` outside injected chaos | **0** | - | any → hard fail |
| 17 | Postgres write rate at target session count | ≤ 200 writes/s | 200-500 | > 500 → auth-state split re-examined (the design targets ~30-60/s) |

A useful sanity check for reading these results: at 150 sessions each sending a steady-state ~1,000 messages/day, aggregate send throughput is about **1.7 messages/second**. The queue is not the constraint at v1 scale and was never going to be - a 2013-era 4-vCPU Postgres benchmark does thousands of jobs/second. **Memory per session is the constraint**, and thresholds 1, 2, 3 and 6 are the ones that decide the product.

### Ramp schedule

**Phase A - synthetic, zero real WhatsApp accounts.** Real Baileys sockets, real Noise handshake, real crypto, real `EncryptedAuthStore` writes, driven against a mock WebSocket endpoint that speaks enough of the protocol to complete a handshake, accept sends, emit receipts and occasionally disconnect with a chosen `DisconnectReason`. One worker, one 4 vCPU / 16 GB box carrying app + Postgres + Redis, exactly as in the proof tier.

1. Step to 10 sessions. Settle 30 min. Measure 30 min.
2. Step to 50. Settle 30 min. Measure 30 min.
3. Step to 100. Settle 30 min. Measure 30 min.
4. Step to **150** (the current default cap). Settle 30 min. Measure 60 min.
5. Step to 200. Settle 30 min. Measure 60 min.
6. Step to 250 (the configured ceiling). Settle 30 min. Measure 60 min. Record where event-loop lag p99 crosses 200 ms - that crossing, not the config default, is the real cap.
7. Drop back to the highest level that met thresholds 1-6 (expected: 150) and **hold for 168 hours**. Sample every 60s. A 24-hour test proves nothing about a 30-day session; drift is the number that catches leaks, and leaks are what turn a 35 MB session into a 70 MB one at day 20.
8. In parallel with step 7, run a **1,000 simulated instances × 8 hours** pacing and queue load with no sockets at all (jobs, claims, reserves, deferrals, reaper, health ticks). This deliberately separates the socket cost from the ledger cost so that thresholds 11-13 and 17 are attributable.

**Phase B - real linked numbers.** 10-20 real numbers, held for 7 days at the Safe Mode steady pace against a consenting recipient set. Not 250: bulk-registering hundreds of numbers for a test is itself the kind of pattern that triggers restrictions [R-55], and it is not schedulable. Before Phase B starts, the plan records **who buys the SIMs, what they cost, who physically holds the handsets for the QR scans, and who is accountable if a number is restricted during the test** - a restricted test number is an expected outcome of this phase, not an incident.

**Phase C - chaos, at the Phase A hold level.**

1. `kill -9` a worker holding 150 sessions. Measure takeover time, reconnect completion, connect-bucket saturation, and the count of jobs landing in `needs_reconcile`.
2. `FLUSHALL` Redis mid-run. Expect exactly one takeover cycle, then normal operation, with `wp_fence_regression_total` = 0 [R-9c].
3. Hang Redis (half-open TCP, not a clean close). Expect self-fencing within 15s via the monotonic watchdog.
4. Stop Postgres for 60s. Expect: everything degrades, nothing is lost, sending resumes automatically.
5. Rolling deploy under full load, one worker at a time. Expect **zero re-QR and zero unresolved sends** (engine test 12).
6. Saturate the send path with a 5,000-job batch, pause mid-batch, resume. Expect zero lost, zero failed, zero duplicated, drain in band order.

### Synthetic versus real: what each can and cannot prove

| Question | Phase A (synthetic) | Phase B (real accounts) |
|---|---|---|
| RSS/CPU/Redis per session | **Yes** - the socket, crypto and auth-state paths are the real code | Validates the multiplier on real traffic shapes |
| 7-day drift and leaks | **Yes**, and this is where it must be caught | Too few sessions to see a leak |
| Queue, claim, reserve, reaper behaviour under load | **Yes**, at 1,000 simulated instances | No |
| Real `DisconnectReason` distribution | **No** - we choose what the mock emits | **Yes**, and it is the only source |
| Real reconnect and re-sync behaviour after a long offline period | No | **Yes** |
| Echo replay of our own `fromMe` messages (the reconciler's primary evidence, SPIKE-2) | No | **Yes** - and if it fails here, the reconciler design changes |
| Real receipt volume and delivery/read ratios feeding health signals | No | **Yes** |
| Whether WhatsApp restricts an account at our pace | **No** | **Not really** - 10-20 numbers over 7 days is anecdote, not evidence, and must be reported as such |
| Signal-key working-set growth with a large distinct-contact set | Partially - the mock can be driven to many distinct JIDs, which is the highest-value synthetic scenario | Yes, but at a sample size of 10-20 |

The honest boundary: **Phase A answers the cost question. Phase B answers the behaviour questions. Neither answers the ban question**, and no result from this phase may be presented as evidence that Safe Mode prevents restrictions.

### Measurement methodology (so the numbers mean something)

1. **RSS per session is a steady-state delta, not a division.** Measure worker RSS after settle at N and at N+50, divide the difference by 50. Dividing total RSS by session count silently attributes the ~120-180 MB Node baseline to the sessions and inflates small-N results.
2. Set `MALLOC_ARENA_MAX=2` and a fixed `--max-old-space-size` on the worker for the whole run, and record both. glibc arena behaviour can move RSS by tens of percent between runs and would otherwise make the drift measurement noise.
3. Record RSS **and** Node heap used **and** external/ArrayBuffer bytes separately. A leak in Buffers (very plausible for a crypto-heavy socket workload) does not show in heap-used.
4. CPU from cgroup accounting over the measurement window, not from `top` snapshots.
5. Redis from `INFO memory` deltas plus `MEMORY USAGE` on a sample of signal-key entries; record `used_memory_rss` too, because fragmentation is what actually fills a box.
6. Postgres from `pg_stat_database` xact counters and `pg_stat_statements` over the window; capture the top ten statements by total time at every step.
7. Every step writes a row into a results file in `docs/measurements/` as it completes. A run whose numbers only exist in Grafana is a run that has to be repeated when retention rolls over.

### Results template

The following table is filled in and copied into this plan, replacing the derived capacity numbers everywhere they appear.

```
WP v1 scale proof - results
Run id:                    Date:                 Image tag:
Box:            vCPU        RAM        Provider/region:
Baileys version (pinned):            Node:            PG:            Redis:

Phase A, per-step measurements
step  sessions  RSS/session  CPU/session  loop lag p99  Redis MB/session  PG writes/s  notes
  1        10
  2        50
  3       100
  4       150
  5       200
  6       250

Phase A hold (168 h at N =    )
  RSS/session hour 12:            hour 72:            hour 168:            drift %:
  sessions connected, 1-min samples: mean %       min %        
  unexpected logouts:            reconnects:            unmapped disconnect codes:
  error-class histogram: transient     not_connected     invalid_recipient
                         invalid_payload     rate_limited     restricted     unknown

Pacing/queue run (1,000 simulated instances, 8 h)
  reserve() p50/p99:          /          ms    cap violations:
  eligible-to-claimed p99:              s      lost jobs:            duplicates:

Phase B (real accounts, N =    , 7 days)
  sessions:        messages sent:          delivered %:        read %:
  disconnects by code:
  echo replay observed (SPIKE-2): yes/no        reconciler resolved / ambiguous:
  restrictions during the test:            (expected outcome, not an incident)

Phase C (chaos)
  kill -9 takeover median/p95:        /        s     full reconnect p95:        min
  needs_reconcile after kill:              redis flush fence regressions:
  rolling deploy: re-QR count:         unresolved sends:
  pause/resume of 5,000 jobs: lost:      failed:      duplicated:

DERIVED OUTPUTS (these replace the estimates in section 7 and the capacity table)
  MAX_SESSIONS_PER_WORKER (new default):
  Sessions per 8 vCPU / 32 GB box:
  RAM for 1,000 concurrent sessions:            GB
  vCPU for 1,000 concurrent sessions:
  Box count and monthly cost for 1,000 concurrent:
  Box count and monthly cost for 1,000 registered at 30% concurrency:
  Confidence after this run: High / Medium (state which, and why)
```

### What the results change, by name

1. `MAX_SESSIONS_PER_WORKER` default in `platform/config.ts` (currently 150 by assumption, ceiling 250).
2. The capacity and cost table in this plan (proof / pilot / 1,000 / comfortable / 5,000+ tiers).
3. The answer to open question 1 - whether v1 sells "1,000 registered" or "1,000 connected" - which then decides the pricing page and the box order.
4. The confidence marker on the capacity section: currently **Low-Medium**, raised to High only for the figures actually measured.
5. Whether the observability stack must move off the app box immediately.
6. ADR 0013 gets an addendum recording the measured per-session cost; the derived figures stay in the record, superseded rather than deleted.

### Exit gate

Zero cap violations, zero lost jobs, zero silent duplicates, zero unexplained `blocked_needs_review`, `reserve()` p99 < 25 ms, the 168-hour hold completed with drift within threshold 3, and the results template filled in and committed to `docs/measurements/`. Until this gate passes, **no capacity figure and no price may be quoted to any customer** - that constraint is on the record as founder acknowledgement 24.

### Risks and honest limits

The synthetic harness is a mock: if it is more forgiving than WhatsApp's real endpoint (smaller frames, fewer receipts, cleaner disconnects), Phase A will report memory numbers that are too good. Phase B is the corrective, and its sample size is small enough that it validates a multiplier rather than establishing one. Seven days is the longest run this plan schedules; a 30-day drift could still differ. Some restriction behaviour is only observable at volumes and durations v1 will not reach before launch - which is the honest reason the first thirty days after release (below) are treated as a continuation of this phase rather than as business as usual.

---

## V1-P9 - Admin panel (admin/frontend + admin/backend)

**Goal:** staff can see the platform, support a tenant and stop abuse - without ever writing the send path directly.

**Dependencies:** V1-P8. The founder's sequencing is deliberate: the admin panel is a tool for operating a proven system, and building it before the system is proven would mean building views of numbers that are about to change. **Estimated effort:** 3-3.5 weeks. **Product specification (screens, views, workflows, entitlement model): section 8.** This phase covers delivery only.

### Scope boundary

| In V1-P9 (v1b) | Not in v1 |
|---|---|
| Staff auth: mandatory TOTP, IP allowlist, 2-minute access tokens, `staff_sessions` | SSO/SAML for staff (V2-P7) |
| `wp_admin_app` read role + the audited `platformRead()` helper | Any direct staff write to a send-path table - structurally forbidden, forever |
| `/internal/v1` S2S API on `app/backend`, six routes, signed tokens, mandatory idempotency | A general-purpose admin write API |
| Cross-tenant instance / queue / health views | Cross-tenant message-body browsing (default no; see below) |
| Client suspend/reactivate, plan and limit overrides, pacing `admin_relax` with reason and expiry | "Pay more, send faster" as a purchasable entitlement - refused by design |
| Time-boxed audited impersonation, metadata only by default | Billing, invoices, wallet, dunning (V2-P2) |
| v1b tables: leads CRM, DSAR workflow, retention policy editor | Parquet archival at scale, automated DSAR (V2-P7) |

The v1a tables (plans, plan_limits, retention_policies, audit_logs, staff_users, staff_sessions) already exist from V1-P1 because they must be in place before real tenant data arrives [R-28s]; V1-P9 builds the UI and workflow on top of them.

### Work breakdown

1. **`admin/backend` service**, its own deployable (`admin-api` in compose, ~150 MB RSS), its own Fastify app, sharing `@wp/server-kit`, `@wp/contracts` and `@wp/domain` - never importing anything from `app/backend` (dependency-cruiser enforces `app/* ↮ admin/*`).
2. **Staff authentication:** `staff_users` with argon2id, **mandatory** TOTP for every staff account with no opt-out, an IP allowlist checked before password verification, 2-minute access tokens with the same `token_epoch` revocation as tenant users, and `staff_sessions` with the same hashed rotating-refresh design.
3. **The read path.** `admin/backend` connects as `wp_admin_app`: `BYPASSRLS` for SELECT, with INSERT/UPDATE/DELETE **revoked** on `message_jobs`, `whatsapp_instances`, `delivery_events`, `pacing_ledger` and `send_attempts` [R-33]. Every cross-tenant read goes through a single `platformRead(ctx, reason, fn)` helper that writes the audit row in the same transaction and is the only code permitted to open a `wp_admin_app` connection [R-6s]. Every such query is registered in `CROSS_TENANT_QUERIES` with role, reason and projected columns [R-44].
4. **The write path is the S2S API.** `/internal/v1/*` on `app/backend`, network-restricted so it is not internet-reachable, authenticated by a signed service token (HMAC, secret from the key ring - not mTLS, which costs ops effort for no gain on one box), carrying `X-Actor: staff:<staff_user_id>` and a mandatory `Idempotency-Key` on every mutation. Every handler writes an audit row with `actor_type='staff'` and `actor_staff_id` taken from the token, never from the body. v1 routes: `instances/:id/pause`, `instances/:id/resume`, `campaigns/:id/cancel`, `clients/:id/suspend`, `clients/:id/limits`, `instances/:id/pacing-override`. The contract lives in `@wp/contracts` as `internalContract` [R-53].
5. **Resume is still human-only.** The internal resume route **rejects non-user actors**; a staff resume is a staff *user* acting with a named identity and a written reason, recorded as such. There is no service-account resume, no bulk resume and no scheduled resume [R-15].
6. **`admin_relax` is bounded.** A pacing override is applied and then clamped by hard platform constants (`ABSOLUTE_GAP_MIN_MS`, `ABSOLUTE_DAILY_CEILING`), carries `expires_at ≤ now() + 30 days` and a written reason, writes a `pacing_events` row, and **notifies the tenant** [R-5w]. Overrides cannot be created from the tenant-facing API at all.
7. **Impersonation:** `impersonation_grants`, time-boxed (default 30 minutes), reason required, tenant-visible in their own audit view, metadata-only by default. Message-body access during impersonation is a separately audited elevation, off unless the founder rules otherwise (open question 19). Revoking a grant bumps `token_epoch` and drops the session within 5 seconds.
8. **v1b tables and workflows:** `leads` (written by `admin/backend`'s public endpoint, which V1-P10 consumes [R-52]), the DSAR request pipeline (intake, verification, export, deletion, with the export produced by a job rather than a synchronous request), and a retention-policy editor writing `retention_policies` that the `cron` role already enforces.
9. **`admin/frontend`:** React 19 + Vite SPA, identical structure to `app/frontend`, same `@wp/ui` and `@wp/design-tokens`, different features. Every mutation routes `admin/frontend → admin/backend → /internal/v1`. The SPA has no direct database concept at all.

### Key implementation decisions

- **Two writers of `message_jobs` or health state would break invariants 1-5**, which is the entire reason for the S2S indirection rather than a shared data layer [R-14, ADR 0014]. The grant snapshot test is what makes this real: it diffs `information_schema.role_table_grants` and fails the build if `wp_admin_app` ever gains a write grant.
- **The audit claim is scoped honestly.** Triggers do not fire on SELECT, so a staff member with raw `psql` access is **not** audited by this design. Either `pgaudit` is enabled for that role, or the claim "every staff read is audited" is not made. v1 ships the honest version of the sentence [R-33].
- **The admin panel is a separate deployable because the founder instructed it** (ADR 0014, binding). It costs one container and ~150 MB RSS. Open question 20 asks only whether it may later become a role inside `app/backend` without re-litigating the folder layout; the folder layout itself is not in question.

### Tests that gate this phase

| Test | Asserts |
|---|---|
| `admin_role_cannot_write_send_path_tables` (grant snapshot) | `information_schema` diff: zero INSERT/UPDATE/DELETE for `wp_admin_app` on the five named tables |
| `every_internal_mutation_writes_a_staff_audit_row` | contract-level sweep of all six routes: mutation without an audit row is impossible |
| `internal_api_rejects_unsigned_and_replayed_tokens` | bad HMAC → 401; replayed `Idempotency-Key` → the original result, no second effect |
| `staff_resume_is_still_a_human_user` | service-token-only actor → 403; staff user + reason → 200 + audit row naming the staff user |
| `admin_relax_cannot_exceed_absolute_bounds` (property test) | any override patch → resolved limits within `ABSOLUTE_*` constants, `expires_at` ≤ 30 days, tenant notified |
| `impersonation_is_time_boxed_and_revocable` | grant expiry and manual revocation both drop access within 5s |
| `cross_tenant_read_without_platformRead_fails_the_build` | `check-tenant-scope` + `CROSS_TENANT_QUERIES` registry |

### Exit gate

The grant snapshot test proves admin cannot write any send-path table; every internal mutation produces a staff audit row; impersonation of a seeded tenant appears in that tenant's own audit view within one refresh.

### Risks and honest limits

The admin panel concentrates cross-tenant read access in one service, which makes it the highest-value target in the system. Mandatory TOTP, an IP allowlist, 2-minute tokens, read-only grants and per-read audit rows are the controls; **root on the box still defeats all of them**, and so does raw database access by a staff member unless `pgaudit` is enabled. That is stated, not hidden.

---

## V1-P10 - Marketing website (Next.js)

**Goal:** a fast, honest, high-craft marketing site that never over-claims - shipped last, when there is a working product to describe truthfully.

**Dependencies:** V1-P9. **Estimated effort:** 2-2.5 weeks. **Product specification (page inventory, positioning, information architecture, SEO plan): section 8.** This phase covers delivery only.

### Scope boundary

| In V1-P10 | Not in v1 |
|---|---|
| Next.js 16 App Router, **static export**, deployed as files behind Caddy | Any SSR or CMS process on the production box |
| Animated hero (GSAP + Lenis) confined to the hero, islands elsewhere | Site-wide scroll-jacking or motion |
| MDX content: marketing pages, docs, blog, pricing, legal | A headless CMS (v2, and only if content velocity demands it) |
| Lead form posting to the rate-limited public endpoint on `admin/backend` | Lead capture through the customer API - marketing traffic must never share the send path's rate-limit budget [R-52] |
| SEO, OG, JSON-LD, analytics, sitemap, robots | Paid-acquisition landing-page tooling, A/B testing infrastructure |
| Legal: ToS, DPA, privacy, and the six plain-language tenant statements | Localised legal for jurisdictions beyond the launch market |

### Work breakdown

1. **Project setup:** `website/` as the fourth project, consuming `@wp/ui` and `@wp/design-tokens` so the site and the product cannot drift visually. Static export (`output: 'export'`), no server runtime, no image optimisation server - images are pre-processed at build.
2. **The `'use client'` discipline.** Every interactive `@wp/ui` component carries `'use client'`; purely presentational ones do not. Because this is the kind of error that fails opaquely on the first Server Component import, `scripts/ci` runs a **website smoke build importing three `@wp/ui` components** as its guard [R-30s].
3. **Hero and motion:** GSAP and Lenis are loaded only on the route that uses them and are confined to the hero. `prefers-reduced-motion` is honoured with a static composition, not a slowed one. The animation budget is subordinate to the LCP budget - if the hero misses, the hero changes.
4. **Performance budget in CI.** Lighthouse CI against the built static output on an India-4G profile (≈1.6 Mbps down, 150 ms RTT, 4× CPU throttle), asserting **LCP ≤ 2.5s** on the home route and no route above a fixed JS transfer budget. This is a build failure, not a warning. Next.js was the founder's choice over Astro; Astro would ship a measurably lighter animated hero on Indian mobile networks (open question 21), so this budget is the mechanism that keeps the choice honest.
5. **Content in MDX**, colocated in `website/content/`, so a copy change is a rebuild-and-rsync, not a database migration.
6. **Lead capture:** a narrow, rate-limited, bot-guarded public endpoint on `admin/backend` (per-IP token bucket, honeypot field, invisible challenge, strict Zod schema, no free-text field longer than the form needs) writing `leads`. The website never talks to `app/backend`.
7. **Legal and disclosure pages**, including the six plain-language tenant statements and the ban-risk posture: v1 places an unappealable restriction risk on the tenant's own number, Safe Mode reduces sender-side velocity signals and cannot prevent restrictions, and recipient reports and message content dominate outcomes. This is a launch blocker, not a nice-to-have (founder acknowledgement 23).
8. **SEO and analytics:** per-page metadata, OG images generated at build, JSON-LD for organisation and product, sitemap and robots, and a privacy-respecting analytics script with no third-party cookie.

### Key implementation decisions

- **`check-copy` runs across the whole site**, including Hindi and Hinglish. The `BANNED_CLAIMS` array is exported once from `@wp/domain` and includes "ban nahi hoga", "block nahi hoga" and "100% safe" alongside the English forms [R-7w]. Any surface string containing "Safe Mode" must ship with `SAFE_MODE_DISCLAIMER` present - asserted, not reviewed by eye.
- **No pricing page ships before V1-P8's results are in.** Prices printed on a marketing site are the hardest claim to retract, and the capacity numbers behind them are derived until measured. The pricing route is built with real content only after the results template is filled.
- **Static export means the site cannot take the app down.** A marketing traffic spike touches Caddy and a directory of files. This is the main reason to accept the static-export constraint rather than reaching for SSR features.

### Tests that gate this phase

| Test | Asserts |
|---|---|
| `lighthouse_lcp_under_budget` | LCP ≤ 2.5s on the India 4G profile, home route, in CI |
| `copy_contains_no_banned_claims` | whole-site scan including Hindi/Hinglish; zero hits |
| `safe_mode_disclaimer_co_presence` | every surface mentioning "Safe Mode" ships `SAFE_MODE_DISCLAIMER` |
| `website_smoke_build_imports_ui_components` | three `@wp/ui` components build inside the site (the `'use client'` guard) |
| `lead_endpoint_rate_limits_and_rejects_bots` | real 429 with headers; honeypot submission rejected; oversized payload rejected |
| `no_website_dependency_on_app_backend` | dependency-cruiser: `website/* ↛ app/*` |

### Exit gate

LCP ≤ 2.5s on the India 4G profile in CI; `check-copy` green across the whole site including Hindi copy; `SAFE_MODE_DISCLAIMER` present on every surface mentioning Safe Mode; the lead form writes a `leads` row end to end on staging.

### Risks and honest limits

An animated hero and a 2.5s LCP on a throttled Indian mobile profile are in genuine tension. If the budget cannot be met with GSAP, the correct response is a lighter hero - not a relaxed budget, and not a "desktop-only" measurement that hides the problem. The site is also where over-claiming is most tempting and most consequential; the copy guard is mechanical for exactly that reason.

---

## v1 release-readiness checklist

Nothing here is a formality. Each item is either demonstrable or it blocks the release.

**Engineering gates**

- [ ] `scripts/ci` green end to end, verbatim output captured, every guard reporting a non-zero matched-file count
- [ ] All 23 mandatory send-path and engine tests green
- [ ] The amended Safe Mode suite (tests 1-32 plus the seven added ones) green
- [ ] Isolation suites A, B and C green; suite A goes red when a `client_id`-less table is added (demonstrated, not assumed)
- [ ] Role-grant snapshot test green
- [ ] Playwright `signup → onboarding → QR → send` green against staging
- [ ] `enum_parity_db_vs_domain` green (a drifted enum is a silent zero-row claim)

**Scale and capacity (V1-P8 outputs)**

- [ ] Results template filled and stored in `docs/measurements/`
- [ ] `MAX_SESSIONS_PER_WORKER` set from measurement, not assumption
- [ ] Capacity and cost table in this plan rewritten with measured figures and its confidence marker updated
- [ ] Open question 1 answered in writing: v1 sells "N registered" or "N connected"
- [ ] 168-hour hold completed with drift within threshold; zero cap violations, zero lost jobs, zero silent duplicates

**Security and data**

- [ ] No plaintext WhatsApp credential in any datastore, filesystem or backup - proven by test, not by inspection
- [ ] `kek_rotation_preserves_decryptability` green; a rotation rehearsed on staging
- [ ] Key ring exists in exactly three places (host secret store, founder's offline encrypted copy, sealed second offline copy) and a **restore has actually been performed** - an untested key backup is not a backup
- [ ] pgBackRest to B2 configured; **timed restore drill completed before the first paying tenant**, RPO ≤ 5 min and RTO ≤ 60 min recorded as achieved, not designed
- [ ] Rate-limit tests assert real 429s with headers per route class
- [ ] SSRF hostile-URL table green including DNS rebinding and a TLS-verification negative
- [ ] Log-grep PII test green across logs, metric labels and audit metadata
- [ ] `no_forbidden_mechanism_exists` static scan green; the CI token ban active
- [ ] Worker hosts: `RLIMIT_CORE=0`, core pattern disabled, swap off or encrypted, production heap snapshots disabled
- [ ] `ulimit -n 65536` set in the container config (the 1024 default breaks a worker at ~800 sessions)

**Operations**

- [ ] `docs/RUNBOOK.md` complete, and every procedure executed once by someone following only the document
- [ ] All alerts firing correctly, verified by inducing at least: an unowned instance, a hard-signal pause, and a backup-age breach
- [ ] Rolling deploy and rollback to the retained tag both rehearsed under load
- [ ] Redis-as-SPOF accepted **in writing** by the founder (open question 11) - the failure is safe but total
- [ ] Snapshot script (`scripts/snapshot.ps1`) running on schedule to the agreed location; no git remote anywhere in the deploy path (ADR 0003)

**Honesty and copy**

- [ ] `check-copy` green across app, admin, website and docs, including Hindi and Hinglish
- [ ] `SAFE_MODE_DISCLAIMER` present verbatim on every surface mentioning Safe Mode
- [ ] Ban-risk posture stated in onboarding copy **and** the ToS (founder acknowledgement 23)
- [ ] No price or capacity figure published anywhere that is not traceable to the V1-P8 results file (founder acknowledgement 24)
- [ ] Consent attestation recorded in onboarding before "Connect WhatsApp" is enabled

**Founder decisions on the record**

- [ ] Open questions 1-6 answered (they shape the schema and are expensive later)
- [ ] Open questions 7-13 answered (they shape the first send and the first restriction)
- [ ] Open questions 14-22 answered (they shape the panel and the commercial launch)
- [ ] Acknowledgement 25: ADR 0004 superseded by 0013, evasion-token bans still in force

---

## The first 30 days after v1

Treat the first month as a continuation of V1-P8 with real tenants attached, not as business as usual. The system has been measured synthetically for seven days and observed on 10-20 real numbers; a real tenant is a workload nobody has seen.

### Daily, for the first 14 days

Watch these and write the numbers down each morning, because a trend is only visible against yesterday:

| Signal | Healthy | Act when |
|---|---|---|
| `wp_session_rss_bytes_est` per session | within 15% of the V1-P8 measurement | above it for 3 consecutive days → memory workstream; the capacity table is wrong |
| `wp_worker_eventloop_lag_p99` | < 200 ms | > 200 ms sustained → reduce sessions per worker before it becomes a queue problem |
| `wp_instances_unowned` | 0 | > 0 for 2 minutes → capacity or worker health; the tenant already sees `INFRA_UNAVAILABLE` |
| `wp_fleet_capacity_headroom` | > 20% | < 20% → order the next box (lead time is days, not minutes) |
| `wp_unresolved_jobs_total` rate | < 0.1% of sends/day/instance | above it → the reconciler or the echo assumption is weaker than SPIKE-2 suggested |
| `wp_reconnect_attempts_total{code}` distribution | dominated by 428/408/515 | any 403/402/406 → a real restriction; harvest the `hard_signal_pause` evidence row immediately |
| `wp_pacing_band_flaps_total` | ≤ 3/day/instance | above it → **our thresholds are wrong**, not the account |
| Opt-out rate per client | < 10/1,000 | above it → contact the tenant about their content before WhatsApp does |
| Redis `used_memory_rss` | < 60% of maxmemory | above it → Redis gets its own box now |
| Backup age | < 30 min | any breach → stop and fix; this is the one failure with no recovery path |

### Scaling triggers, decided in advance

1. **Fleet headroom < 20% for 3 consecutive days** → provision the next worker box. Do not wait for saturation; a cold start of a full worker takes ~2 minutes by design, but box provisioning takes days.
2. **Measured RSS per session > 15% above the V1-P8 figure** → re-run the Phase A ramp against production-shaped traffic before adding capacity, because adding boxes to a leak is expensive.
3. **Postgres write rate > 500/s sustained** → revisit the auth-state Postgres/Redis split; the design targets 30-60/s.
4. **Redis > 60% of maxmemory, or any eviction of a signal key** → dedicated Redis box (this was already planned for ~2,000 sessions; a real workload may bring it forward).
5. **Any tenant asking for more than 2,000 messages/day/number** → that is a policy conversation and a platform-admin bounded override with a written reason and an expiry, never an entitlement to sell.
6. **Session concurrency approaching 300 on a 8/32 box** → the "1,000 registered at 30% concurrency" model is being tested for real; recheck the assumption rather than assuming it holds.

### Feedback to collect, deliberately

1. **Onboarding funnel drop-off** per `clients.onboarding_step`. The consent attestation and the timezone step are the two most likely places to lose people, and both are non-negotiable.
2. **Warm-up impatience.** Track how many tenants ask to send faster in week one, and what they ask for. This is open question 7 answered by data: ~30 days to ~1,000/day is the number most likely to cause either churn or bans, and we currently have no evidence for which.
3. **Deferral complaints.** Every "why is my campaign slow" ticket should be checkable against `wp_pacing_deferrals_total{reason}`. If the panel's "paced - next window HH:MM" copy were doing its job, that ticket would not exist; if it keeps arriving, the copy is failing, not the pacing.
4. **Every restriction event, in full.** The `hard_signal_pause` row plus what the tenant was actually sending, their list source and their content. Thirty days of these rows is the beginning of the labelled dataset that makes the health score more than a heuristic - and the first opportunity to activate the nine unscored signals with evidence rather than guesses.
5. **Unresolved-send decisions.** How often tenants choose "Retry (may duplicate)" versus "Discard (may have been delivered)". This informs open question 9 and belongs in the ToS either way.
6. **Real per-tenant concurrency**: how many of a tenant's registered numbers they actually keep online. This is the single input that decides whether the fleet model is the cheap one or the expensive one.

### The stop conditions

Two outcomes end the sales conversation until they are resolved, and saying so now is cheaper than deciding it under pressure: a **cap violation or a duplicate send that reaches a real recipient** (invariants 3 and 5 are broken, and duplicates to real people are the report vector no pacing controls), and a **restriction rate across tenants that the evidence rows cannot explain** - because at that point we do not know what our own product is doing to their numbers, and continuing to sell it while we find out is not a defensible position.


---

# 8. Admin panel and marketing website (end of v1)

These two surfaces are deliberately the **last** things built in v1 (phases V1-P9 and V1-P10), after the scale proof. The founder's ordering is right for a reason that is worth stating: an admin panel built before the send path is stable encodes screens for a data model that is still moving, and a marketing site built before V1-P8 has nothing honest to say about capacity or price. Both phases inherit a frozen schema, measured numbers, and a copy guard that is already green in CI.

Neither surface may weaken an invariant. The admin panel is a **second reader of the database and never a second writer of the send path**; the website is a **static artifact that makes no claim the tests cannot back**.

## 8.1 Admin panel: architecture, and the rule that keeps it safe

`admin/` is its own project pair — `admin/backend` (Node 24 + Fastify 5 + oRPC, single `ROLE=api`) and `admin/frontend` (React 19 + Vite SPA) — sharing the one database with `app/backend` and sharing code only through `packages/` (ADR 0014). The founder's instruction is binding and is implemented literally; the one deliberate limit added on top is the write ownership rule, because two writers of `message_jobs` or `whatsapp_instances` would break invariants 1-5 outright.

```
admin/
├── backend/
│   ├── src/
│   │   ├── main.ts                     # single role: api (no worker, no scheduler, no sockets)
│   │   ├── modules/
│   │   │   ├── auth/                   # staff_users, TOTP, IP allowlist, staff_sessions
│   │   │   ├── overview/               # fleet + platform dashboard reads
│   │   │   ├── tenants/                # clients, users, memberships, usage, suspend (via S2S)
│   │   │   ├── instances/              # cross-tenant instance view; pause/resume via S2S
│   │   │   ├── ops/                    # queue depth, workers, leases, errors, cron, audit search
│   │   │   ├── plans/                  # plans, plan_limits, client_limit_overrides
│   │   │   ├── leads/                  # public capture endpoint + staff CRM screens
│   │   │   ├── webanalytics/           # Umami proxy + first-party web_events rollups
│   │   │   └── support/                # impersonation grants, notes, DSAR intake
│   │   ├── platform/                   # ~80 lines wiring @wp/server-kit (config, log, errors, db)
│   │   └── internal-client/            # the ONLY place /internal/v1 is called from
│   └── tests/
└── frontend/
    └── src/  routes/ · features/<f>/{api,keys,components,hooks,index} · components/ · lib/ · providers/ · styles/
```

`admin/backend` imports `@wp/server-kit`, `@wp/db`, `@wp/domain`, `@wp/contracts`, `@wp/utils`. `admin/frontend` imports `@wp/ui`, `@wp/design-tokens`, `@wp/contracts`, `@wp/domain`, `@wp/i18n`, `@wp/utils`. `app/* ↔ admin/*` imports are a dependency-cruiser error in both directions, forever (`2026-08-25-v1-design-repo-structure.md` §2.2-2.3). Shared logic is shared through packages; nothing is copy-pasted.

### How it shares the database without becoming a second writer

Four mechanisms, all mechanical:

1. **Role separation.** `admin/backend` connects as `wp_admin_app`: `BYPASSRLS` for **SELECT only**, with INSERT/UPDATE/DELETE revoked on `message_jobs`, `whatsapp_instances`, `delivery_events`, `pacing_ledger` and `send_attempts`. The role-grant snapshot test diffs `information_schema.role_table_grants` and fails the build if a grant appears. A developer who "just updates the row" gets a permission error in integration tests, not a review comment six weeks later.
2. **The registry.** Every cross-tenant query is registered in `CROSS_TENANT_QUERIES` (`file:symbol`, DB role, reason, projected columns) and `scripts/check-tenant-scope.ts` fails on any unregistered query against a `client_id` table. The registry is the readable answer to "what can staff see?" — it is a file, not a claim.
3. **`platformRead(ctx, reason, fn)`.** The single helper allowed to open a `wp_admin_app` connection. It writes the audit row in the same transaction as the read, so an un-audited cross-tenant read is structurally hard to write. Honest limit: SELECT does not fire triggers, so **a staff member with raw psql access is not audited by this mechanism**. Either `pgaudit` is enabled for the role, or we do not make the "every read is audited" claim — v1 makes the narrower, true claim and puts psql access behind the same break-glass procedure as the key ring.
4. **`/internal/v1` for every mutation.** Described next.

Admin **owns** a small set of tables outright and may write them freely because nothing in the send path reads them: `staff_users`, `staff_sessions`, `impersonation_grants`, `support_notes`, `leads`, `lead_activities`, `lead_tasks`, `announcements`, `web_events`. They live in the same `db/migrations` sequence, run by the same one-shot `ROLE=migrate` container — one migration runner for the whole system, never two. Because isolation suite A enumerates every base table in `public` and demands either a `client_id` with RLS FORCE or an entry in `isolation_non_tenant_tables` with a written reason, each of these tables ships with its reason line in the same commit.

### The `/internal/v1` S2S contract

Every side-effecting staff action is an HTTP call from `admin/backend` to `app/backend`, so the send-path invariants, the health FSM and the audit trail keep exactly one owner.

| Property | v1 decision | Why |
|---|---|---|
| Transport | HTTPS on a network-restricted route prefix `/internal/v1/*` | not exposed to the internet; one box, one Docker network |
| Auth | signed service token (HMAC, secret from the key ring), short expiry | mTLS is ops cost for no gain on a single box |
| Actor | mandatory `X-Actor: staff:<staff_user_id>` header | the audit row must name a human, not "the admin service" |
| Idempotency | mandatory `Idempotency-Key` on every mutation | a retried suspend must not produce two audit rows |
| Audit | every handler writes `audit_logs` with `actor_type='staff'`, `actor_staff_id` | inside the same transaction as the change |
| Contract | `internalContract` in `@wp/contracts` (oRPC + Zod v4) | typed on both sides; drift is a compile error |

v1 route list, and nothing beyond it: `instances/:id/pause`, `instances/:id/resume`, `campaigns/:id/cancel`, `clients/:id/suspend`, `clients/:id/limits`, `instances/:id/pacing-override`.

Two rules that outrank convenience:

- **`resume` rejects non-user actors.** A staff resume is a staff *user* acting, recorded as that user; the service token alone cannot resume. When `pause_reason='provider_restriction'` the acknowledgement flag is required as well. There is no staff shortcut around the human-only transition rule, because a staff-triggered auto-resume is exactly the forbidden mechanism wearing a uniform.
- **`pacing-override` is `admin_relax` only within absolute bounds.** The patch is clamped after resolution by `ABSOLUTE_GAP_MIN_MS` and `ABSOLUTE_DAILY_CEILING`, requires a written reason and `expires_at ≤ now() + 30 days`, writes a `pacing_events` row, and notifies the tenant. "Pay more, send faster" is not an entitlement we build.

## 8.2 Admin information architecture

```
Overview
Tenants
 ├─ All tenants (search, filter: status · plan · health · onboarding step)
 └─ Tenant detail
     ├─ Summary (plan, limits, onboarding, 30-day usage)
     ├─ Users & memberships
     ├─ Instances
     ├─ Usage & queue
     ├─ Audit trail
     ├─ Notes
     └─ Actions (suspend · limits · impersonate · DSAR)
Instances (cross-tenant fleet table)
Operations
 ├─ Queue & scheduler
 ├─ Workers & leases
 ├─ Errors & unresolved
 ├─ Background jobs (cron, reaper, reconciler, retention)
 ├─ Audit log search
 └─ Announcements & maintenance banner
Growth
 ├─ Leads
 └─ Website analytics
Configuration
 ├─ Plans & limits
 └─ Pacing profiles (read-only in v1)
Security
 ├─ Staff users & roles
 ├─ Impersonation grants
 └─ Access review
```

Navigation is a persistent left rail with a Cmd-K palette wired to the same actions; the panel reuses `@wp/ui` primitives so staff screens and tenant screens share one design system (no AdminJS, Retool or Refine — a templated internal-tool look cannot be reconciled with the design direction in 8.7, and the component library already exists by V1-P9).

## 8.3 Admin modules, module by module, with v1 MVP scope

| Module | v1 MVP (build in V1-P9) | Explicitly v2 |
|---|---|---|
| Overview | fleet + platform gauges, 24h incident list | trend forecasting, cohort retention |
| Tenants & users | search, detail, usage, suspend, impersonation, notes | ticketing integration, NPS, health scoring of accounts |
| Instances | cross-tenant table with health band, warm-up tier, queue lag; pause/resume/relax | bulk actions across instances, saved views |
| Operations | queue/worker/lease/error views, audit search, announcements | replay tooling, per-worker profiling UI |
| Leads | capture endpoint, list, stages, notes, convert-to-client link | kanban drag-drop, sequences, scoring model, CRM sync |
| Plans & entitlements | plans/plan_limits/client_limit_overrides CRUD with audit | billing, wallet, invoices, subscription mirror, feature-flag platform |
| Website analytics | Umami embed/proxy + first-party funnel from `web_events` | session replay, multi-touch attribution |
| Staff & security | staff auth, RBAC, impersonation grants, access review export | SSO/SAML, passkeys, approval workflows |

### 8.3.1 Overview dashboard

One screen answering "is the platform healthy, and is anything on fire?": instance counts by `health_state` and by health band; `wp_instances_unowned` and `wp_fleet_capacity_headroom`; total queued jobs and the worst `oldest_queued_seconds` with its tenant; hard-signal pauses in the last 24h (each linking to its `pacing_events` evidence row); unresolved sends (`blocked_needs_review`) count and rate; send volume and error-class mix for 24h from `analytics_rollup_daily`; new signups, instances linked, first-send conversions; leads today. Gauges read from Postgres rollups, not by scanning `message_jobs` — a dashboard query that competes with the claim loop is a self-inflicted outage. No revenue widgets exist in v1 because there is no billing (v2, ADR 0008).

### 8.3.2 Tenants and users

List over `clients` joined to plan, instance count, 30-day sends, worst instance health, `onboarding_step`, `created_at`, `status`. Search by slug, company name, user email and instance label; every search executes through `platformRead` with the staff's stated reason, and the audit row records the search term class (not the raw term when it is an email — the log field allow-list forbids PII in logs; the audit row stores the matched `client_id`s).

Tenant detail shows: plan and effective limits (resolved through the same `effective_client_limits` the reserve statement reads — one resolver, not a re-implementation), users and roles, instances with health and warm-up tier, usage sparkline, open `needs_user_action` items, the last 200 audit rows, and free-text support notes.

**Suspend** calls `clients/:id/suspend`. It sets `clients.status='suspended'`, which is a predicate inside the canonical claim, so claims stop within one poll interval. It **does not** touch queued jobs: nothing is deleted, failed or reordered (invariant 5). The confirm dialog states the exact queued-job count that will be held and the copy the tenant will see. Reactivation is the same route with the inverse action, audited.

**Impersonation** is the highest-risk feature in the panel and is built with the brakes on:

1. Staff opens a request with a written reason and optional ticket reference.
2. The tenant **owner approves in the product panel** (in-app + email). Consent-first is the default; a break-glass path exists for abuse investigations and requires a second staff approver (`superadmin`) and writes a distinct audit action.
3. `impersonation_grants` records staff id, client id, reason, approver, scope, `expires_at` (default 30 minutes, hard ceiling 2 hours).
4. The impersonated session is **metadata only by default** — instance state, job statuses, health and pacing evidence, but **not message bodies or contact names**. Reading bodies requires a separately-audited elevation on the grant, and the tenant sees that it was granted. (Founder decision pending; the default is "no".)
5. Access tokens for impersonation are 2 minutes and re-check `token_epoch`, so revocation drops the session within seconds. A persistent banner is shown in the impersonated UI. Every mutating action during impersonation writes an audit row with actor = staff and acting-as = tenant user, and mutations still go through `/internal/v1` where they touch the send path.

### 8.3.3 WhatsApp instances across all tenants

The fleet table is the screen support will live in. Columns: tenant, label, masked phone (`+91·····21` — never the full number, matching the panel's own masking), `link_state`, `health_state`, health band and score, warm-up tier and day, today's consumed vs `eff_daily_cap`, new conversations vs cap, queue depth, `oldest_queued_seconds`, last error class, `pause_reason`, `owner_worker_id`, `lease_seen_at`. Filters: band, state, unowned, warm-up tier, tenant, "has queue lag > N minutes".

Row actions, all S2S, all audited: pause (with reason), resume (staff user + acknowledgement when required), pacing `admin_relax` (bounded, expiring, reason mandatory, tenant notified), and a read-only "why?" drawer showing the same signal vector, evidence JSON and effective limits the tenant sees — staff and tenant look at the same numbers, which removes an entire class of support argument.

Staff **cannot** resolve a tenant's `blocked_needs_review` job. The choice between "Retry (may duplicate)" and "Discard (may have been delivered)" is a decision about messages to real people and belongs to the tenant; admin shows the list and the counts, read-only.

### 8.3.4 System operations

Queue and scheduler: queued/processing/needs_reconcile/blocked counts by band, claim throughput, `pacing_reserve` deny-reason breakdown (this is the screen that explains "why is this tenant slow?" without SSH), DWRR band fairness sample, scheduler leader identity from `singleton_leases`.

Workers and leases: worker registry with sessions held vs `MAX_SESSIONS_PER_WORKER`, event-loop lag p99, estimated per-session RSS, lease takeovers, `wp_fence_regression_total` (any non-zero value is a red banner, not a chart), unowned instances with age.

Errors and unresolved: `wp_send_total{result,error_class}` mix, reconnect attempts by `DisconnectReason` code, unmapped disconnect codes (drives the disconnect-map test), unresolved and ambiguous reconcile counts.

Background jobs: last run, duration and rows touched for reaper, reconciler, retention, warm-up stepper, rollups; a failed or skipped run is surfaced, because a silently dead cron is how retention violations happen.

Audit log search: filter by actor (staff or user), client, action, target type, date range; index-friendly over the monthly-partitioned `audit_logs` with allow-listed metadata keys; export to CSV writes its own audit row.

Announcements and maintenance banner: `announcements(title, body, audience, severity, starts_at, ends_at)` rendered as an in-app banner in the product panel. Deliberately minimal — no CMS, no rich text beyond a constrained MDX subset, and the text passes `check-copy` like every other surface string.

### 8.3.5 Leads

Leads are admin-owned by design: the website posts to `admin/backend`, so marketing traffic never touches the customer API's rate-limit budget or the send path. v1 MVP is a list, not a CRM product: source, source detail, name, email, phone, company, stage (`new|contacted|qualified|demo|won|lost`), owner staff user, first-touch and last-touch UTM, consent record reference, notes/activities, `converted_client_id`. Dedupe on lowercased email plus normalised E.164. Conversion joins `leads → clients` to give a real funnel (visit → lead → signup → linked instance → first send) that no third-party CRM could compute without exporting our tenant data. Kanban drag-drop, lead scoring and sequences are v2; a `stage` dropdown covers founder-led sales at the expected volume of low hundreds per month (`2026-08-25-admin-panel-analytics-leads-entitlements.md` §5).

### 8.3.6 Plans and entitlement configuration — what v1 truly needs

v1 needs far less than the entitlement research proposed, because there is no billing in v1. The send path already reads exactly two commercial limits: the plan daily cap (`max_daily_sends`, inside the reserve statement) and the plan queue-depth cap (at job creation). Everything else is a UI affordance.

| Table | In v1? | Reason |
|---|---|---|
| `plans` | yes (v1a, created in the initial migration) | a client row points at a plan from signup |
| `plan_limits` | yes (v1a) | the claim and reserve statements read resolved limits |
| `client_limit_overrides` | yes (v1a) | grandfathering and support exceptions with reason + expiry |
| `effective_client_limits` (view/resolver) | yes | one resolution order: override → plan limit → hard default (deny/0) |
| `plan_features` / boolean feature gates | **no** | v1 has one product surface; a feature matrix with one row is theatre |
| `feature_usage_counters` | **no** | `client_daily_usage` and `pacing_ledger` already count what matters |
| subscriptions / invoices / wallet | **no** (v2, ADR 0008) | no payments in v1; plan assignment is a staff action |
| OpenFeature provider / flag platform | **no** (v2) | env-driven config plus a redeploy is sufficient at this size |

The admin screen is a plans × limits matrix with editable cells, plus a per-tenant overrides tab. Every edit writes an audit row with the before/after values, and limit changes invalidate the cached resolution (Redis, rebuildable). Honest note for the founder: **without billing, "plan" in v1 means "the limits a staff member assigned"**. That is enough to run a pilot and nothing more.

### 8.3.7 Website traffic analytics

Two data sources, one screen:

1. **Umami, self-hosted** for pageviews, referrers, UTM campaigns and top pages — the lightest option that reuses Postgres and needs no ClickHouse (`2026-08-25-marketing-website-seo-conversion.md` §3; PostHog's self-host minimum of 4 vCPU / 16 GB is not affordable next to a session fleet). Umami runs in **its own database** on the same Postgres instance, never in the WP application database: isolation suite A enumerates every base table in `public` and would otherwise go red on a dozen foreign tables with no `client_id` and no reason line. Admin reads Umami through its API and renders in our own components; the Umami UI is not exposed publicly.
2. **First-party `web_events`** written by the same `admin/backend` public endpoint that receives leads — the funnel events that must join our own `leads` and `clients` tables (see 8.13). No third-party analytics tool can do that join.

Cost of honesty: Umami's funnels are shallow. v1 answers "where did leads come from and how many converted"; it does not answer "which scroll depth predicts conversion". That is acceptable at launch traffic.

### 8.3.8 Staff roles and security

- `staff_users` is a separate table from `users` — no shared credential, no shared session cookie, no path where a customer account can become staff.
- **TOTP is mandatory** for every staff account; there is no "remind me later".
- **IP allowlist** per staff user (CIDR list), enforced fail-closed at the edge proxy *and* in `admin/backend` (belt and braces: the proxy config is one rsync away from being wrong).
- `admin/backend` is not published on the public interface; it is reachable over the VPN / SSH tunnel only.
- Access tokens are 2 minutes; refresh tokens are hashed in `staff_sessions` with rotation and reuse detection; `token_epoch` invalidation on role change or revocation drops sessions within seconds.
- **Access review**: a quarterly job produces a report of staff users, roles, last login, impersonation count and IP allowlist, and an unreviewed account older than 90 days is flagged on the Security screen. One sealed break-glass `superadmin` credential is stored offline with the key-ring copies and its use raises an alert.

### RBAC matrix

| Capability | superadmin | ops | support | marketing | auditor |
|---|---|---|---|---|---|
| View overview / fleet / ops screens | ✅ | ✅ | ✅ | ❌ | ✅ (read) |
| View tenant list & detail (metadata) | ✅ | ✅ | ✅ | ❌ | ✅ |
| View tenant message content | ❌ by default; elevation only | ❌ | ❌ by default; elevation only | ❌ | ❌ |
| Pause instance (S2S) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Resume instance (S2S, human + ack) | ✅ | ✅ | ✅ | ❌ | ❌ |
| Pacing `admin_relax` | ✅ | ❌ | ❌ | ❌ | ❌ |
| Suspend / reactivate client | ✅ | ✅ | ❌ | ❌ | ❌ |
| Edit plans & limits / overrides | ✅ | ❌ | ❌ | ❌ | ❌ |
| Request impersonation | ✅ | ❌ | ✅ | ❌ | ❌ |
| Approve break-glass impersonation | ✅ | ❌ | ❌ | ❌ | ❌ |
| Leads CRM | ✅ | ❌ | ✅ (read) | ✅ | ❌ |
| Website analytics | ✅ | ✅ | ❌ | ✅ | ✅ |
| Announcements / maintenance banner | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage staff users & roles | ✅ | ❌ | ❌ | ❌ | ❌ |
| Audit log search & export | ✅ | ✅ | ✅ (own actions + assigned tenants) | ❌ | ✅ |
| DSAR intake / export trigger | ✅ | ❌ | ✅ | ❌ | ❌ |

Roles are rows in `staff_role_permissions`, resolved by the same `can(actor, action, resource)` function from `@wp/domain` that the product panel uses — one authorisation implementation, two consumers. The server re-checks on every request; the UI only greys buttons out. There is no `finance` role in v1 because there is no money movement to guard.

## 8.4 Marketing website: goals and KPIs

v1's site has three jobs and no others: (1) make the product credible to someone who has never heard of it, (2) capture qualified leads, (3) set expectations honestly enough that a signup is not a future refund. It is not a growth engine yet — there is no billing, no self-serve purchase and no measured capacity to sell.

| KPI | v1 target | How measured |
|---|---|---|
| Lead form submissions | baseline established in month 1 (no target invented) | `leads` table |
| Spam share of leads | < 5% | manual triage flag on `leads` |
| Lead → signup conversion | tracked, not targeted | `leads.converted_client_id` |
| LCP p75, India 4G profile | ≤ 2.5s | Lighthouse CI in `scripts/ci`, build fails above budget |
| INP p75 / CLS | ≤ 200 ms / ≤ 0.1 | Lighthouse CI + field data once traffic exists |
| Banned-claim strings | exactly 0 | `check-copy` across `website/` including Hindi |
| Pages with a Safe Mode mention lacking `SAFE_MODE_DISCLAIMER` | exactly 0 | co-presence assertion in `check-copy` |
| Accessibility | WCAG 2.2 AA on nav, forms, pricing table | axe in CI + one manual keyboard/screen-reader pass |

## 8.5 Sitemap and per-page section outlines

| Page | Ship in V1-P10? | Sections |
|---|---|---|
| Home | yes | hero (headline + one-line promise + primary CTA + real product screenshot) · "what actually happens when you send" (durable job → paced worker → result, three panels) · Safe Mode with the full disclaimer inline · pause/resume story ("your queue survives a pause") · what we deliberately do not do (no rotation, no proxies, no auto-resume) · honest risk disclosure block · who it is for / who it is not for · CTA |
| How it works | yes | linked-device model in plain language · durable queue · priority bands and what priority does *not* mean · retry and reconciliation · health and pause · what breaks and what we do about it |
| Safe Mode | yes | what it does (pacing, warm-up, windows, opt-out, content guards) · what it cannot do (verbatim disclaimer) · warm-up ramp table · why there is no off switch · why we will not sell a faster tier |
| Reliability | yes | the invariants stated as promises we test · failure behaviour table (abridged) · what "we lost nothing" means · what we do not promise (no uptime SLA at launch) |
| Pricing | yes, shape only | plan shapes, what a plan limits, "talk to us" CTA, FAQ. **No numbers derived from unmeasured capacity**; per-message price is zero and that is stated plainly |
| Security & trust | yes | encryption of session credentials, tenant isolation layers, data we can and cannot encrypt (linked-device reality stated), backups, sub-processors, incident contact |
| Legal | yes | Privacy (DPDP + GDPR framed), Terms (including the ban-risk disclosure and the ambiguous-send policy), DPA, WhatsApp policy statement, the six plain-language tenant statements |
| Docs | minimal | getting started, connect a number, send your first message, webhooks, error classes. Full API reference is v2 |
| Contact / demo | yes | form (see 8.9) + response-time expectation |
| Blog (en, hi) | 3-5 posts | WhatsApp sending discipline, what actually causes restrictions, warm-up explained, India compliance basics |
| Status | link only | v1 links to a hosted status page; no uptime percentage is published until it is measured |
| About | yes | founder, why the product exists, contact |
| Comparisons (vs Wati / Interakt / AiSensy / Gupshup) | **deferred** | competitors are Meta-BSP products and we are not; an unfair comparison is a credibility risk, and each page needs a dated verification and a maintenance owner |
| Programmatic industry × use-case pages | **deferred** | thin pages before real content is a quality penalty, not an SEO strategy |

## 8.6 The honest copy policy

`BANNED_CLAIMS` lives in `@wp/domain`, `check-copy` scans `website/` (and every other surface) including Hindi and Hinglish, and the build goes red on a hit. The policy is not a style guide; it is a test.

| Allowed (and true) | Forbidden (and why) |
|---|---|
| "Safe Mode paces your sending and watches your account's real signals. It reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold. It cannot prevent or guarantee against WhatsApp restrictions — bans also come from recipient reports, message content and account reputation, which no sender-side pacing can control." | "Ban-proof WhatsApp sending" / "Your number will never get blocked" — unprovable and false |
| "When sending pauses, queued messages are not lost, failed or reordered. They wait." | "Guaranteed delivery" — we control dispatch, not WhatsApp |
| "Every message becomes a durable row before anything is sent. A crash cannot silently drop it." | "Zero message loss, guaranteed" — no system earns an unqualified guarantee |
| "Priority decides which message goes next. It is not a speed promise." | "Instant bulk sending" / "Blast 10,000 messages in minutes" |
| "This connects your own WhatsApp number as a linked device. The restriction risk lands on that number, and there is no appeal path." | omitting the risk, or burying it in the ToS only |
| "We do not rotate numbers, use proxies, or resume a restricted account automatically. Those are the mechanisms that get accounts and providers into trouble." | "Smart failover keeps you sending" — that is number rotation |
| "Capacity and pricing figures will be published once measured." | any sessions-per-server or accounts-supported number before V1-P8 |
| "बंद होने पर आपके queued messages सुरक्षित रहते हैं।" | "ban nahi hoga" / "block nahi hoga" / "100% safe" |
| "No customer logos yet — we are new. Here is the engineering instead." | invented logos, fake counters, "trusted by 500+ businesses" |

Two rules that follow from this: **no unmeasured number appears anywhere on the site** (capacity, throughput, uptime, deliverability), and **every surface that says "Safe Mode" ships the disclaimer within the same view** — asserted mechanically, not by review.

## 8.7 Visual direction: deliberately designed, not templated

The failure mode is well documented and has a specific look: purple-to-blue gradients, glassmorphism, Inter with no hierarchy, centered hero with three symmetric cards, emoji icons, uniform 12px radius everywhere, and "streamline your workflow" copy (`2026-08-25-ui-ux-design-direction-anti-ai-look.md` §1). The counter-moves are decisions, not tricks:

1. **One signature accent hue in OKLCH**, chosen deliberately away from both generic SaaS violet and literal WhatsApp green (a deep teal-ink family), with near-black `#171717`-class ink and near-white surfaces. Gradients appear as a rare accent, never as a page background. All colours come from `@wp/design-tokens` (DTCG JSON → CSS custom properties + Tailwind v4 preset); a raw hex in `packages/ui` is a lint error.
2. **A committed type pairing**: a dense functional sans for UI (Geist or Instrument Sans), a warmer display face for marketing headlines (Satoshi or a serif), Geist Mono for data and code, and **Noto Sans Devanagari as a first-class member of the type scale** — the Hindi track and the product's Hindi copy must not look like a fallback. A visual QA pass with real Hindi copy next to the Latin face is a checklist item, not an assumption.
3. **Editorial, asymmetric layout.** Offset hero copy, a bento-irregular feature grid, screenshots bleeding off-grid. No page is a centered column of three equal cards.
4. **Shadow-as-border and tiered radius**: 4px on dense controls, larger radii reserved for marketing surfaces. Blur is reserved for exactly one surface (the command palette overlay in the apps) and does not appear on the website.
5. **Real product screenshots with masked data** instead of illustrations; a bespoke single-stroke icon set (a consistently customised Lucide/Phosphor subset), never emoji and never marketplace Lottie packs.
6. **Voice**: direct, specific, Hinglish-aware where appropriate, technical where it earns trust. Banned words in marketing copy: revolutionize, seamless, leverage, effortless, game-changing.

A short anti-AI-look checklist gates the design review of every page: one accent hue? real screenshots? asymmetry? deliberate radius? typographic hierarchy visible at a glance in greyscale? a sentence only we would write?

## 8.8 Animation plan, budget and fallbacks

Founder direction is "high-end animation". The constraint is an India 4G LCP budget of 2.5s enforced in CI, on a Next.js 16 static export — React already costs ~40-60 kB of baseline JS where Astro would cost ~0, so the animation budget is what is left after that choice, and it is spent in one place.

| Section | Technique | Library | Loading | Reduced-motion fallback |
|---|---|---|---|---|
| Hero | one signature scroll-choreographed sequence (product UI assembling itself) | GSAP + ScrollTrigger | dynamic import **after** LCP, desktop + fine-pointer only, skipped on `saveData` or ≤2 CPU cores | static end-state frame, no motion |
| Optional smooth scroll | Lenis | Lenis | hero page only, gated | disabled entirely; native scroll always available to keyboard and screen-reader users |
| Section reveals (all pages) | CSS scroll-driven animations (`animation-timeline: view()`) | none — native | zero JS | opacity/transform set to final state via the reduced-motion media query |
| Route/page transitions | View Transitions API | native | zero JS | instant transition |
| Interactive islands (pricing toggle, form states, tabs) | Motion (Framer Motion successor) | Motion | island-scoped chunk | duration → 0, state changes only |
| Feature icons / empty states | static SVG in v1; Rive considered in v2 | — | inline | n/a |
| 3D hero (Spline / Three.js) | **not built in v1** | — | — | — (2-8 MB payload and 2-4s FCP delay on 3G is incompatible with the budget) |

Performance budget, enforced by Lighthouse CI in `scripts/ci` on a throttled India 4G profile:

- Home page JS ≤ 120 kB gzip total; the GSAP chunk ≤ 45 kB and never on the critical path.
- The LCP element is static text or a pre-sized image and is **never** animated in — no fade-up on the headline.
- CLS 0 by construction: every image, embed and animated container has reserved dimensions.
- Any animation touching the interaction path stays on the compositor (transform/opacity only); JS work per frame ≤ 10 ms.
- `prefers-reduced-motion: reduce` is implemented as an early return at the animation-controller level, not per-component CSS, so a missed component cannot leak motion.

If the animated hero cannot hold LCP ≤ 2.5s, the escalation order is: drop Lenis → make the hero sequence desktop-only → replace it with a produced demo video with a poster frame → revisit Astro for the site. That order is written down now so it is not argued about at launch.

## 8.9 SEO plan

- **Static export means real HTML** for every route: no client-rendered content, correct `<title>`/meta/canonical per route via the metadata API, OG images generated at build.
- **Schema.org**: `Organization` and `SoftwareApplication` on home, `FAQPage` on pricing and Safe Mode, `Article` on blog posts, `BreadcrumbList` sitewide.
- **XML sitemap + robots.txt** generated at build; no orphan pages; no thin generated pages.
- **GEO layer**: every explanatory page carries a scannable comparison table and an FAQ block written as direct-answer sentences. This serves featured snippets and AI-answer inclusion simultaneously and costs nothing extra. The claimed 4-5× conversion advantage for AI-referred traffic comes from vendor blogs with no independent audit — the tactic is cheap and dual-purpose, so we do it, but the multiplier is not a planning input.
- **Hindi track**: human-written Hindi content (never machine translation), `hreflang` en / hi-IN / x-default added **only once Hindi pages actually exist**. Hindi keyword difficulty is materially lower than the English equivalents in this category (single-source, directional), and it matches the product's own bilingual copy.
- **Deferred deliberately**: comparison pages and programmatic industry × use-case matrices. Both need maintained, factually current content and an owner; publishing them stale is a credibility and legal risk that outweighs the traffic at launch volume.

## 8.10 Lead capture, consent and spam protection

```
website form (static page, island)
  └─ POST https://<admin-host>/public/v1/leads     ← admin/backend, CORS locked to the site origin
       ├─ IP token bucket (5/hour/IP) + global bucket, real 429 with headers (tested)
       ├─ Cloudflare Turnstile token verified SERVER-SIDE (Managed mode; never a forced interactive challenge)
       ├─ honeypot field + minimum time-to-submit check
       ├─ Zod .strict() + E.164 via libphonenumber + email normalisation
       ├─ consent checkbox (unchecked by default) → consent_records row: text version, timestamp, ip_hash
       ├─ UTM first-touch (first-party cookie, 90d) + last-touch, both stored
       ├─ dedupe on (lower(email)) and normalised phone
       └─ INSERT leads + web_events('lead_submitted'); no PII in any log line
```

Why this endpoint lives on `admin/backend` and not `app/backend`: marketing traffic — including bot traffic — must never consume the customer API's rate-limit budget or sit adjacent to the send path. A scraped form is then an admin-side annoyance, not a delivery incident.

Consent specifics: India's DPDP regime requires granular opt-in, withdrawal and auditable consent logging; the checkbox text is versioned and the stored record references the version, so we can prove what a person agreed to. If we ever follow up **on WhatsApp** we use our own product, under our own opt-out registry, with the consent record as the lawful basis — dogfooding, with the same rules we sell.

Turnstile caveat, honestly: an interactive challenge measurably costs real demo submissions in at least one documented case. Managed mode only, monitored against the spam-share KPI, and removable if it costs more leads than it blocks.

## 8.11 Content and CMS with no git host

There is no git anywhere in the deploy path (ADR 0003), which disqualifies every git-backed CMS (Keystatic and friends) outright. v1 ships **MDX in `website/content/`**, built into the static export, deployed as an image tag by the same `docker save` → rsync → `docker load` path as everything else.

| Option | Verdict for v1 |
|---|---|
| MDX in the workspace | **chosen** — zero extra processes, zero extra attack surface, content is versioned by the snapshot script alongside code |
| Payload CMS 3 (self-hosted, Postgres) | **v2 candidate** — a real editor GUI with no git exposure, but it is another Node process, another database and another auth surface on the same box |
| Directus / Strapi | same objection as Payload, weaker fit |
| Sanity / Contentful | SaaS content store; acceptable but adds a vendor for content we can hold ourselves |

The honest cost of MDX: **publishing a blog post requires a developer-run build and deploy** (about two minutes of work plus the deploy). That is fine while the founder writes the content and a developer deploys it. The moment a non-technical editor needs to publish weekly, Payload on a separate database with a build trigger is the upgrade — planned for v2, not pre-built.

## 8.12 Analytics events

| Event | Fields | Destination |
|---|---|---|
| `page_view` | path, referrer, utm_*, device class, country | Umami |
| `cta_click` | cta_id, page, position | `web_events` |
| `pricing_view` | plan_shape_seen, currency_toggle | `web_events` |
| `lead_form_start` | form_id, page | `web_events` |
| `lead_form_submit` / `_error` | form_id, error_class (never field values) | `web_events` |
| `demo_request` | lead_id | `web_events` + `leads` |
| `doc_view` | doc_slug | Umami |
| `signup_click` | source_page, utm first-touch | `web_events`, joined later to `clients` |

`web_events` is append-only, monthly-partitioned, cookieless-by-default (an anonymous id in first-party storage, no cross-site identifier), listed in `isolation_non_tenant_tables` with its reason, and carries no free-form payload. Because v1 ships **no third-party pixels and no GA4**, a cookie-consent banner is not required for analytics; the consent record that matters is the one attached to the lead form. Adding any third-party tag later reintroduces the banner requirement — that trade is made explicitly or not at all.

## 8.13 Hosting

The site is a static export served by the same Caddy/nginx that fronts the apps, from a versioned volume or a tiny static container — **no SSR process on the production box** (that decision is worth roughly 380 MB RSS on a box that is otherwise spending its memory on WhatsApp sessions). Assets are content-hashed with immutable cache headers; HTML is short-cached. Image tags follow `v1.<YYYYMMDD>.<n>`; rollback is redeploying the retained previous tag. A CDN in front (Cloudflare) is optional and useful for TLS, caching and Turnstile, and introduces no git dependency. Lighthouse CI runs against a locally served production build inside `scripts/ci`, so a regression fails the build rather than being discovered by a customer on a train.

## 8.14 Launch checklist (V1-P10 gate)

1. `scripts/ci` green verbatim, including `check-copy` across `website/` with Hindi and Hinglish patterns.
2. Every surface mentioning Safe Mode ships `SAFE_MODE_DISCLAIMER` in the same view — asserted, not eyeballed.
3. No capacity, throughput, uptime or price figure appears anywhere that is not backed by V1-P8 measurements.
4. Ban-risk disclosure present on the home page, the Safe Mode page, the ToS and the onboarding flow — four places, same substance.
5. Legal set complete and reviewed: Privacy (DPDP + GDPR), Terms (including ban risk and the ambiguous-send policy), DPA, WhatsApp policy statement, sub-processor list.
6. Lead endpoint: rate limits produce a real 429 with headers under test; Turnstile verified server-side; honeypot and timing checks active; 1,000-request abuse run leaves the customer API untouched.
7. PII log-grep test green across the lead path (no email, phone or name in any log line).
8. Consent record written with a versioned text and retrievable for a given lead.
9. Lighthouse CI: LCP ≤ 2.5s, INP ≤ 200 ms, CLS ≤ 0.1 at the India 4G profile, on home and pricing.
10. `prefers-reduced-motion` pass: every animated section renders its end state, Lenis disabled, no autoplay motion.
11. Keyboard and screen-reader pass on navigation, the lead form and the pricing table; WCAG 2.2 AA contrast, focus-not-obscured and 44px target checks.
12. 404 and 500 pages exist, are branded and are in the sitemap exclusion list.
13. Sitemap, robots, canonicals, OG images and schema.org validated.
14. Analytics verified end to end: a test lead appears in the admin panel with correct first-touch and last-touch UTM.
15. Admin panel gates re-confirmed alongside launch: role-grant snapshot proves `wp_admin_app` cannot write any send-path table; every `/internal/v1` mutation produced a staff audit row in the smoke run.
16. Deploy and rollback rehearsed on the production box; previous image tag retained; snapshot archive written.
17. Status page linked, with no uptime percentage published.
18. One founder read-through of every page against the forbidden-sentence list, out loud.

## 8.15 What remains honestly unresolved

- **No customer proof at launch.** No logos, no case studies, no testimonials, because there are no customers yet. The site compensates with engineering transparency, and inventing social proof is off the table.
- **No uptime SLA.** We have not run long enough to have a number. Publishing one before measuring it is the same category of error as quoting capacity before V1-P8.
- **Admin reads compete with the send path.** One Postgres serves both. At around 1,000 clients, heavy platform analytics can contend with claim and reserve traffic; the cheap fix is a read replica that only `admin/backend` connects to, and it changes no folders. It is a v2 item, and until then admin dashboards read rollups, never raw partitions.
- **Impersonation auditing covers application paths only.** A staff member with direct psql access is outside that guarantee unless `pgaudit` is enabled. We say the narrow true thing.
- **The Next.js + GSAP hero is the biggest measured risk on the site**, and Astro remains the lighter alternative that changes no other folder. The escalation order in 8.8 exists precisely so this is a decision, not a fight.
- **Two backends cost real money**: roughly 150-250 lines of duplicated bootstrap, a second image and deploy step, and ~120-180 MB RSS. This is built because the founder was explicit, and it does buy genuine blast-radius isolation — an admin bug cannot crash the customer API. If the instruction is ever relaxed, merging admin into `app/backend` as a role-gated router is a contained change.


---

# 9. v2 scope: everything deferred, in order

v1 is a proof plus a usable panel: signup → onboarding → QR → send → measured scale, then the admin panel, then the marketing site (ADR 0016). Everything else is v2. This section is deliberately at outline depth — goals, dependencies, effort bands and triggers — not work packages. Writing v2 task lists now would be fiction: the phase that decides v2's order (V1-P8, the scale proof) has not run, and its numbers are the input to the sequencing.

Two founder decisions are restated here because they bound the whole section. **The Meta Cloud API returns as a v2 adapter, not a v1 fallback** — v1 builds the transport boundary and implements exactly one adapter (`baileys`); the Cloud API was explicitly rejected as a v1 fallback on scope grounds, with the boundary kept as the cheap insurance (ADR 0013, ADR 0016). **AI features are deferred and not planned** — not in v1, not in v2, unless the founder asks (ADR 0011, status "DEFERRED"). Nothing in this plan assumes either arrives.

## 9.1 The rule that governs v2

Three rules follow from ADR 0016 and are enforced during v1, not during v2:

1. **v1 builds no feature whose only justification is v2.** A table, column or module that exists solely to make a v2 phase easier is scope creep wearing a planning hat. The exceptions are structural, listed in 9.11, and each one is load-bearing for an invariant we need in v1 anyway.
2. **Nothing in v1 may be structured so that a v2 item requires a rewrite.** That is a shape constraint, not a feature constraint: the transport boundary, the durable job table, tenant scoping, and the design-token/UI packages are named explicitly in ADR 0016.
3. **The forbidden-mechanism list does not relax in v2.** No number rotation, no failover to another number after a pause, no proxy pools or connection masking, no device fingerprinting, no auto-resume after a restriction, no client-settable pacing bypass, and no "pay more, send faster" entitlement (open question 17, section 10). v2 adds surface area; it does not add evasion.

## 9.2 The gate: v2 does not open until V1-P8 has numbers

The capacity figures throughout this plan are derived, not measured. Until the scale proof runs, we do not know per-session RSS, the real sessions-per-worker ceiling, the encrypted signal-key write throughput, or the production restriction rate on real linked numbers. Those four numbers decide whether v2 opens with **V2-P6 (reliability and scale hardening)** or with breadth. ADR 0016 says exactly this: revisit the order after V1-P8.

The honest statement of the dependency: if measured per-session cost lands near 35 MB and the fleet is stable across a 7-day drift run, v2 can open with breadth (billing first, since it is what makes v1 sellable). If a session costs 60-80 MB, or the fleet needs babysitting, V2-P6 jumps to the front and breadth waits — because selling breadth on an unstable engine converts a technical problem into a refund problem.

## 9.3 The ordered list at a glance

| Phase | Goal in one line | Effort band | Trigger to start |
|---|---|---|---|
| V2-P1 Meta Cloud API / BSP adapter | A second transport for tenants who need an official, appealable channel | L | A tenant segment whose ban-risk tolerance is zero, or a measured v1 restriction rate we cannot live with |
| V2-P2 Billing, wallet and entitlements | Turn the panel into a business that collects money | L | First paying tenant beyond hand-invoicing (~10), or V2-P1 landing (Cloud API creates real per-message cost) |
| V2-P3 Team inbox depth | Two-way conversation work, not just sending | L | Measured inbound volume, or the founder's answer to open question 6 lands as "inbox is part of the product" |
| V2-P4 Campaign & automation suite | Repeatable sending programmes with the guards intact | M-L | Tenants running campaigns by hand through the API or CSV more than once a week |
| V2-P5 Public API, webhooks v2, integrations | Other systems drive WP without a human | M | Three or more integration requests, or one deal contingent on Zapier/CRM |
| V2-P6 Reliability and scale hardening | Remove the v1 single points of failure and raise the ceiling | M-L | V1-P8 numbers, a Redis incident, fleet headroom < 20% twice in a month, or the first SLA |
| V2-P7 Compliance and enterprise security | Pass a real security review | L-XL | First enterprise deal with a security questionnaire, or a data-residency requirement |
| V2-P8 AI-assist | Not planned | — | Founder asks; ADR 0011's bounded-business-process gate applies |

**Effort bands are estimates, not commitments,** and they are derived the same way the capacity numbers are — from design scope, not from this team's measured velocity, which does not exist yet. Bands for one experienced full-time engineer plus review: **S ≤ 2 weeks · M 3-6 weeks · L 7-12 weeks · XL > 12 weeks or calendar-bound**. Re-band every phase after v1 ships, when we finally have a velocity number that is real.

## 9.4 V2-P1 - Meta Cloud API / BSP adapter

**Goal:** offer a second, official channel for tenants who cannot accept an unappealable restriction on their own number — without touching the queue, pacing, health FSM, UI or schema.

**Delivers:** a second implementation of `MessageTransport` + `ChannelLink` under `provider/meta/` (direct Tech Provider, or 360dialog/Gupshup as a BSP to skip Meta's onboarding burden — decide at the time on approval latency, not on price); embedded signup via the already-defined `LinkChallenge {type:'redirect'}` variant; template support (`template` re-enters the `job_kind` enum, which v1 deliberately dropped, plus a template registry and Meta approval-status sync); per-provider capability gating from `MessageTransport.capabilities`; Meta-specific health signals (quality rating, messaging tier, 130429 throughput errors) mapped into the existing 12-signal scorer as additional evidence, replacing inference with fact for those tenants.

**Depends on v1:** the transport boundary (`MessageTransport`/`ChannelLink` split, `SendErrorClass` as the only branch surface, `LinkChallenge` redirect variant already in the union), `whatsapp_instances.provider_kind` existing from the first migration so no migration is needed to register an adapter, and the enum-parity test that makes adding `template` to `job_kind` a controlled change rather than a silent zero-row claim.

**Effort: L.** The adapter itself is small — no socket, no lease, no fence, no auth-state encryption. The work is Meta's onboarding surface (business verification, embedded signup, webhook verification), the template lifecycle, and per-provider pacing profiles.

**Trigger:** any of — a tenant segment that will not accept the v1 ban-risk disclosure; a measured restriction rate in production that makes v1 economics bad; a deal requiring templates or the verified-business badge; or Meta pricing moving far enough to make pass-through attractive.

**What v1 must not compromise:** the provider boundary is the whole insurance policy. `provider.types.ts` must contain no Baileys type (lint-enforced), the engine must branch only on `SendErrorClass`, `roles/api.ts` must never import `provider/**`, and `LinkChallenge` must keep the redirect member even though v1 never constructs it. If any of those slip in v1, this phase stops being an adapter and becomes an engine rewrite.

## 9.5 V2-P2 - Billing, wallet and entitlements

**Goal:** charge for the product without a billing failure ever dropping a queued message.

**Delivers:** subscriptions and the INR price book on Razorpay (UPI Autopay, e-mandate, GST) with Stripe/Dodo for USD behind one `PaymentProviderAdapter`; an append-only `wallet_ledger` with a trigger blocking UPDATE/DELETE and a nightly `balance = sum(ledger)` drift check; usage meters built from `send_attempts`; invoices and payment events mirrored from provider webhooks, never authored by us; dunning; and the entitlement resolver as a pure function in `@wp/domain` so the admin preview and the runtime check cannot drift (ADR 0008).

**Depends on v1:** the v1a tables (`plans`, `plan_limits`, `client_limit_overrides`) created in the first migration; the durable job row and `send_attempts` as the metering source of truth; the single `paused → sending` code path that always requires an authenticated human user. Wallet-empty is enforced **at scheduler eligibility, not at job creation** — jobs stay queued and the instance pauses with `pause_reason='wallet_empty'`, which is one new enum value on an existing mechanism, and resume after top-up is a confirmed user action, never automatic (ADR 0008).

**Effort: L.** Money is unforgiving: tax, proration, currency, reconciliation and dunning are each small and each mandatory.

**Trigger:** the first paying tenant past the point where hand-invoicing is honest work (~10 tenants), or V2-P1 landing — a Cloud API adapter creates real per-message pass-through cost, and without a wallet we absorb it silently.

**What v1 must not compromise:** the durable job table and per-tenant scoping are what make metering a query instead of a data-recovery project. Every send must be attributable to `(client_id, instance_id, attempt_no)` with an idempotency key that already exists — `wallet_ledger.idempotency_key = 'job:'||job_id||':'||attempt_no` only works because v1 wrote the attempt row before the provider call. Equally: **do not add a second automatic exit from `paused`**. v1's CI test asserting exactly one `paused → sending` path is what keeps wallet-empty from becoming an auto-resume loophole.

## 9.6 V2-P3 - Team inbox depth

**Goal:** make WP a place agents work, not only a place messages leave from.

**Delivers:** group support (`capture_groups`), a media pipeline at real volume (thumbnails, virus scanning, storage lifecycle), opt-in bounded history backfill, assignment/notes/canned replies, presence and typing, unread state and SLA timers.

**Depends on v1:** `contacts`/`chats`/`messages` (monthly partitions, rendered body only — never `rawMessage`), `media_assets` with keys built solely by `storage.put()`, the SSE realtime channel, and the `capture_groups`/`capture_media` flags that default to `false` in v1 precisely so this phase is a flag flip plus features rather than a schema change.

**Effort: L**, and it is the phase most likely to be under-estimated: assignment, presence and history are three separate products in a trench coat.

**Trigger:** measured inbound volume per tenant, or the founder's answer to open question 6 (section 10) landing as "a working inbox is part of a real working panel". Note the coupling: that answer also changes v1's per-session memory model, so it should be answered before V1-P8 measures, not after.

**What v1 must not compromise:** the memory discipline. `syncFullHistory:false`, `markOnlineOnConnect:false`, no in-process message store (`getMessage` reads Postgres) and bounded caches are the only reasons the capacity table is not worse than it is. History backfill and groups both inflate the signal working set, so this phase must re-measure per-session RSS against V1-P8's baseline before it enables anything fleet-wide — otherwise it silently invalidates the capacity model and the pricing built on it.

## 9.7 V2-P4 - Campaign & automation suite

**Goal:** let a tenant run a repeatable sending programme without a human pasting lists, and without any guard being weaker than it is for a single send.

**Delivers:** message templates (our own, distinct from Meta templates), contact segments, a scheduling calendar, drip and automation rules (trigger → wait → send with human-handoff exits), and A/B variants.

**Depends on v1:** the `campaigns` table with its resumable expansion cursor and `dedupe_key`, the DWRR fair scheduler (so one tenant's campaign cannot starve another's transactional band), and the whole Safe Mode content-guard set.

**Effort: M-L.** The engine already expands and paces; the work is UI and rule semantics.

**Trigger:** tenants doing campaign work by hand through the API or CSV more than about once a week — that is the signal that the feature exists already, just badly, in their spreadsheets.

**What v1 must not compromise:** automation must be a **job-creation** feature, never a pacing feature. Every automated job goes through the same `pacing_ledger` reserve, the same opt-out check at all three enforcement points, and the same `SendOrigin` enum (no automation origin is exempt). One concrete design task to carry forward: A/B variants change the content fingerprint, and the duplicate fan-out guard counts distinct recipients per `(client_id, local_date, fingerprint)` — a two-way split halves each counter. That must be solved by grouping variants under a campaign-level fingerprint, not by raising the thresholds, or the A/B feature quietly becomes a way around the guard.

## 9.8 V2-P5 - Public API, webhooks v2 and integrations

**Goal:** other systems drive WP without a human in the panel.

**Delivers:** a published, versioned OpenAPI spec with a deprecation policy; per-key rate plans; event replay for webhook consumers; Zapier/n8n/Make apps; and CRM connectors (the two or three the pipeline actually asks for, not a catalogue).

**Depends on v1:** oRPC + Zod contracts in `@wp/contracts` already generating OpenAPI; hashed, scoped, optionally instance-restricted API keys with boot-time scope registration; signed, SSRF-guarded webhook delivery with auto-disable; `delivery_event_ids` as the dedup authority; and the outbox relay.

**Effort: M.** The API exists; publishing it is the work — contract stability, docs, sandbox, and the support burden of a spec you cannot change casually.

**Trigger:** three or more unrelated integration requests, or a single deal contingent on one. Publishing earlier freezes a contract we may still want to move.

**What v1 must not compromise:** external identifiers. v1 exposes only `message_job_refs.public_id` (uuidv7) and never the partitioned `bigint` job id, and every route already lives under `/v1` with an RFC 9457 error envelope. If a v1 response ever leaks an internal id or an unversioned shape, this phase begins with a breaking change to customers who integrated in good faith. Event replay also needs retention longer than `delivery_events`' 90 days, so the retention decision made in v1 sets the replay window this phase can honestly offer.

## 9.9 V2-P6 - Reliability and scale hardening

**Goal:** remove the failure modes v1 knowingly accepted, and raise the per-box ceiling.

**Delivers:** Redis Sentinel or a replica — removing the stated v1 single point of failure (open question 11: losing Redis stops the whole fleet within ~10 seconds, fail-safe but not fail-over); a read replica for admin analytics; `message_jobs` partition growth automation plus Parquet archival to object storage; the `session-worker`/`send-worker` split (the lease design already permits it, and v1 deliberately did not build a separate send-worker role); and per-session memory reduction — tighter caches, harder eviction of `session`/`sender-key` material to Redis, and, if Node overhead dominates the measurement, an evaluation of a Go or Rust session host behind the same transport boundary.

**Depends on v1:** the lease + Postgres-minted fence (which is what makes splitting the roles safe), monthly/weekly partitioning already in place, and V1-P8's measured curves — every item here is prioritised by a number that phase produces.

**Effort: M-L**, spread across items that can ship independently. Sentinel is roughly a day plus a box; a session-host rewrite is XL on its own and only happens if measurement demands it.

**Trigger:** explicitly numeric — measured concurrency approaching the measured per-worker ceiling, `wp_fleet_capacity_headroom` below 20% twice in a month, any Redis-caused outage, or the first customer SLA. This is the phase most likely to jump the queue and become V2-P1 in practice.

**What v1 must not compromise:** Redis must stay genuinely rebuildable — the fence is minted in Postgres, the pacing ledger is the only grantor, and DWRR deficit state is per-worker and in-memory. Every one of those choices is what allows a Sentinel migration (or a Redis wipe) to cost one takeover cycle instead of a correctness incident. The metrics named in v1 (`wp_session_rss_bytes_est`, `wp_worker_eventloop_lag_p99`, `wp_instances_unowned`, `wp_fence_regression_total`) are the inputs that make this phase evidence-driven; if they are not wired in V1-P7, this phase starts blind.

## 9.10 V2-P7 - Compliance and enterprise security

**Goal:** survive a real enterprise security review without emergency engineering.

**Delivers:** OpenBao/Vault or a cloud KMS swapped in behind the existing `KeyProvider` interface (a component swap, not a rewrite); `pgaudit` enabled for the cross-tenant staff role — which is what would make the "every cross-tenant read is audited" claim true for raw psql access, a limit v1 states honestly rather than papering over; SSO/SAML and passkeys; automated DSAR export/erasure on top of v1's `dsar_requests` table and manual workflow; data-residency options (open question 16); and SOC 2 readiness.

**Depends on v1:** the `KeyProvider` interface, purpose-separated KEKs, the four-role Postgres separation with its grant snapshot test, `audit_logs` with allow-listed metadata written in the same transaction as the change, and `retention_policies`.

**Effort: L-XL, and partly calendar-bound.** SOC 2 Type II requires an observation window measured in months; no amount of engineering compresses it. **"SOC 2 readiness" means controls and evidence in place — it is not a certification, and must never be described as one in marketing copy.**

**Trigger:** the first enterprise deal whose security questionnaire we cannot answer truthfully today, or a customer contract with a residency clause.

**What v1 must not compromise:** the honest security statement. v1 already documents what it cannot do — a live session is decrypted into worker memory by necessity, we cannot protect credentials from root on the worker host, we cannot encrypt message content end-to-end from ourselves (WP is a linked device), and we cannot prevent WhatsApp bans. **"0 gaps, 0 issues" is not a promise anyone can make honestly**, and v2 does not change that; it shortens exposure windows, adds independent attestation, and widens the audit trail. Anything in v1 that overstates the position now becomes a compliance finding later.

## 9.11 V2-P8 - AI-assist (deferred, not planned)

**There is no AI work planned in v1 or in v2.** ADR 0011 is marked DEFERRED by ADR 0016 on the founder's direction. It is listed here only so that "we forgot" is never the explanation.

If the founder asks for it, ADR 0011's gate applies unchanged before any design: every feature must pass a documented **bounded business process** test (scoped task, defined inputs and outputs, mandatory human path); a general-purpose conversational assistant on a WhatsApp number is not built in any market; models are tiered by task with batch processing for anything not agent-facing; AI runs as durable jobs on the existing queue so it inherits retries, leases, idempotency and tenant isolation; it is billed as metered credits, which means it cannot start before V2-P2; on zero credits it degrades to the non-AI path and never blocks a message send or touches queue health; and no AI claim may suggest improved deliverability or reduced restriction risk.

Nothing in v1 or v2 is shaped to accommodate AI. The one accidental affordance — the durable job pattern — exists for message sends and is reused, not reserved.

## 9.12 The v1 investments that keep v2 cheap

This is the concrete answer to "what in v1 must not be compromised". Each row is something v1 needs for its own invariants; each is also the reason a v2 phase is a feature rather than a rewrite.

| v1 investment | Where it lives | v2 phase it de-risks | What breaks it |
|---|---|---|---|
| `MessageTransport` + `ChannelLink` split, `SendErrorClass`, `LinkChallenge` redirect member, `provider_kind` column | `provider/provider.types.ts`, first migration | V2-P1, and the Go/Rust session host in V2-P6 | a Baileys type leaking into the interface; the engine branching on a provider-specific error |
| Durable job row before any send, `send_attempts` with `(job, attempt_no)` uniqueness | `message_jobs`, `send_attempts` | V2-P2 metering, V2-P5 event replay | sending anything without a durable row first |
| Tenant scoping in four layers + `client_id` first on every tenant index | `TenantDb`, RLS FORCE, role separation, isolation suites | V2-P2, V2-P3, V2-P5, V2-P7 | a new table without `client_id` (suite A goes red by design) |
| One pacing grantor (`pacing_ledger`) with no bypass path | `modules/pacing/**` | V2-P4 automation, V2-P1 per-provider profiles | a second counter table; a client-settable override; an "automation" origin exemption |
| Exactly one `paused → sending` path requiring an authenticated human user | health service + resume endpoint | V2-P2 wallet-empty, V2-P6 failover | any second automatic exit from `paused` |
| `@wp/design-tokens` + `@wp/ui`, consumed by all three surfaces | `packages/` | every phase that adds a screen | a raw hex or a bespoke component tree in a new surface |
| `@wp/contracts` (oRPC + Zod) as the single contract source | `packages/contracts` | V2-P5 | a hand-written route outside the contract |
| `@wp/domain` browser-pure with the FSMs, DWRR, `BANNED_CLAIMS` | `packages/domain` | V2-P3, V2-P4, V2-P7 copy review | importing a driver into domain (two lint rules guard this) |
| Redis strictly rebuildable; fence minted in Postgres | lease/fence design | V2-P6 Sentinel migration | putting non-rebuildable state in Redis |
| Public ids are `public_id` uuidv7 only | `message_job_refs` | V2-P5 | exposing a partitioned bigint in any response |

## 9.13 How this order may legitimately change

The order above is a default, not a contract. Three re-orderings are pre-authorised by evidence, so they do not need re-litigation:

1. **V2-P6 moves first** if V1-P8 measures per-session cost materially above 35 MB, or if the fleet needs manual intervention during the 7-day drift run.
2. **V2-P2 moves first** if v1 acquires paying tenants faster than hand-invoicing can carry — billing is what converts a proof into a business.
3. **V2-P1 moves first** if production restriction rates on real linked numbers make the v1 channel commercially untenable for the segment we are selling to. That is a measured decision, not a fear-driven one, and V1-P8 phase B (10-20 real numbers) is where the first real data point comes from.

Everything else waits its turn. And the standing constraint from ADR 0016 applies to every phase above: **no capacity number and no price is quoted to a customer before it is measured**, which in practice means no v2 phase gets a public commitment date either.


---

# 10. Quality strategy, risks, open questions and next steps

This section is the plan's contract with itself: how we prove work is finished, what can go wrong, what we are assuming without evidence, what only the founder can decide, and what happens on Monday morning.

## 10.1 What "done" means in this repo

Done is three things, in order:

1. **Verbatim green output of named tests.** Every task names its test before the code exists (TDD); the run output is pasted into the task record unedited. A summary of a test run is not evidence; the output is (core invariant 7).
2. **`scripts/ci.{ps1,sh}` green end to end.** No git host means no server-side hook, so the script *is* the gate: format → lint → dependency-cruiser → `@wp/domain` browser build → guard meta-assertion → tenant-scope → send-origin → copy → typecheck → unit → integration → build. A guard that matched zero files fails the build; a rule with no automated guard is not a rule.
3. **One reviewer verdict per feature** (not per task), covering the invariants touched, plus the claim checklist question: does the claim SQL itself carry the fence, health, epoch, client and plan predicates? Checked outside the `UPDATE` means reject.

Each phase adds its own named gate (phase titles in section 0). A red task stops the line: the next dispatch is a debugger, never "continue past the failure".

## 10.2 The test layers

| Layer | Runs against | Fixtures / data | What it must not do |
|---|---|---|---|
| Unit | `packages/domain`: FSMs, DWRR selector, retry classifier, `TIMING` ordering, resolvers | injected clock, seeded RNG (`Date.now`/`Math.random` are banned globals in domain) | touch a DB, a socket or wall-clock time |
| Integration | real PostgreSQL 17 + Redis 7 in Docker, truncate between tests | two seeded tenants **by default** | share state across tests or use a superuser role |
| Contract | every route against `@wp/contracts` (oRPC + Zod v4), incl. the error envelope and `.strict()` rejection of unknown fields | generated from the contract | assert on a hand-copied schema |
| Isolation | suites A (all-tables inversion), B (background paths), C (Redis key enumeration) | two tenants, one never referenced by the code under test | be loosened when a new table fails suite A |
| Concurrency / chaos | N parallel workers, `kill -9`, Redis flush, half-open TCP, rolling restart | real Postgres, real leases | rely on sleeps for correctness |
| End-to-end | Playwright, all three surfaces | a fresh tenant per spec | use production credentials or a real number |
| Load / soak | k6 + the synthetic-socket harness | synthetic instances, plus 10-20 real numbers in Phase B | be run once and never repeated |
| Security | 429s per route class, SSRF hostile-URL table, log-grep, `no_forbidden_mechanism_exists`, `copy_contains_no_banned_claims` | a seeded tenant whose phone, body, email and API key are grepped for in a full log stream | assert on configuration instead of behaviour |

**Test-data policy.** No real customer data in any fixture, ever. Phone numbers come from documented test ranges; bodies are lorem plus one Devanagari and one emoji case (the inbox renders Hindi and normalisation bugs hide there). Integration fixtures seed **two** tenants because the real leaks in both reference repos were cross-tenant reads on background paths (section 1), which a single-tenant fixture cannot catch.

## 10.3 The gating suites

| Suite | Size | Where it is specified | Ships in |
|---|---|---|---|
| Send-path and engine | 23 named tests: `duplicate_idempotency_key_creates_one_job`, `two_workers_cannot_double_claim_one_job`, `stale_fence_cannot_claim_save_purge_or_write_events`, `redis_flush_does_not_deadlock_claims`, `hung_redis_connection_self_fences_within_15s`, `kek_rotation_preserves_decryptability`, `reaper_never_drives_attempts_negative`, `pause_preserves_work_end_to_end`, `high_flood_does_not_starve_low`, and 14 more | blueprint testing strategy | V1-P3 / V1-P4 |
| Safe Mode | 32 amended tests plus 7 new, incl. `postgres_is_authoritative_when_redis_is_wrong`, `redis_outage_degrades_but_never_over_sends`, `tightening_takes_effect_on_the_very_next_reserve`, `timezone_change_cannot_reset_the_daily_cap`, and `tenant_can_tighten_never_loosen` as a **property** test over tenant *and* admin patches | blueprint Safe Mode suite | V1-P5 |
| Isolation, security, copy | suites A/B/C, role-grant snapshot diff, real-429 per route class, SSRF table incl. DNS rebinding and a TLS-verification negative, log-grep, forbidden-mechanism scan, banned-claims scan incl. Hindi/Hinglish with the `SAFE_MODE_DISCLAIMER` co-presence assertion | blueprint security section | V1-P1 onwards |
| Schema assertions | `no_unique_index_on_a_partitioned_table_without_the_partition_key`, `exactly_one_table_carries_a_reserve_counter`, `enum_parity_db_vs_domain` | blueprint data model | V1-P1 |

Three of these are **self-extending**: suite A enumerates every base table and fails on a new one without either a `client_id` + RLS FORCE coverage row or an entry in `isolation_non_tenant_tables` with a written reason; `disconnect_map_covers_every_enum_member` fails when the pinned Baileys enum gains a member; `enum_parity_db_vs_domain` fails when the DB enum and the TypeScript union drift. Forgetting is a red build, not a silent hole.

## 10.4 How Baileys is mocked, and where it is not

1. **Unit / integration: a fake `MessageTransport`.** Queue, pacing, reaper and reconciler tests never import Baileys; they program outcomes by `SendErrorClass` (`transient | not_connected | invalid_recipient | invalid_payload | rate_limited | restricted | unknown`) — the only thing the engine branches on — plus latency and hang injection. This is what makes 100-worker chaos tests possible at all.
2. **Synthetic harness: real Baileys, mock WebSocket endpoint.** Real sockets, Noise handshake, crypto and `EncryptedAuthStore` writes against a mock server — the only way to measure per-session RSS and signal-key write throughput without buying hundreds of numbers (V1-P8 Phase A).
3. **Real linked numbers: 10-20, in V1-P8 Phase B only.** Validates the synthetic multiplier, real reconnect behaviour, receipt volume and the echo-replay assumption (SPIKE-2). 250 real numbers is not schedulable, and bulk number registration is itself a restriction pattern — so we do not do it.

Two things are never mocked: the `DisconnectReason` enum (a data table tested against the pinned library; the codes in this plan are library knowledge and **must** be re-derived at implementation time) and the encryption round trip (sealed from a real `initAuthCreds()` object, Buffers and all — the double-parse bug class that bit evolution-api, section 1).

## 10.5 Visual, accessibility and performance budgets

- **Accessibility:** axe-core inside the Playwright specs on every panel screen, plus a keyboard-only pass on signup, onboarding, QR pairing, pause/resume and unresolved sends. WCAG AA contrast is enforced at the token layer (a raw hex inside `packages/ui` is a lint error), so contrast is checked once on tokens, not per component.
- **Visual:** no hosted visual-regression service exists without a git host. v1 uses Playwright screenshot assertions on a few high-value states (instance card per health band, QR screen, pause banner) plus the `@wp/ui` smoke build the website imports — which is what catches the "first Button import into a Server Component fails opaquely" class. A full visual-regression tool is an open implementation detail, not a v1 blocker (`2026-08-25-frontend-stack-and-monorepo.md` flags the same gap).
- **Performance budgets:** website LCP ≤ 2.5s on an India 4G profile in CI at V1-P10 — the number that decides whether the animated hero survives. Backend budgets, asserted in load runs rather than unit tests: p99 `pacing.reserve()` < 25 ms; event-loop lag p99 < 200 ms per worker (the soft-yield threshold); claim-to-dispatch p95 inside one pacing gap; SSE drop after membership revocation within 5 s. Budgets are pass/fail where the harness allows and reported-and-reviewed where it does not — a budget nobody looks at is not a budget.

## 10.6 Load and soak plan, with pass thresholds

| Run | What it does | Pass threshold |
|---|---|---|
| A1 ramp (synthetic) | 10 → 50 → 100 → 150 → 200 → 250 sessions on one worker | RSS, CPU, Redis bytes per session and PG write rate recorded at every step; event-loop lag p99 < 200 ms at the chosen level |
| A2 drift (synthetic) | **7 days** at the chosen level | RSS flat within noise after 24 h, zero session leaks, zero unexplained disconnects; a 24-hour run does not substitute |
| A3 key-write throughput | encrypted signal-key writes at fleet scale (SPIKE-4) | Redis and PG keep up at the target session count without queueing — the largest unproven performance risk |
| B1 real numbers | 10-20 real linked numbers | synthetic multiplier validated within a stated error band; echo replay observed and ≥ 95% of ambiguous sends auto-resolved |
| C1 storm | `kill -9` a worker holding 150 sessions | takeover ≤ 45 s, zero re-QR, connect bucket never exceeded, every `needs_reconcile` explained |
| C2 Redis flush | flush mid-run | claims resume within one scan interval; `wp_fence_regression_total` = 0 |
| C3 rolling deploy under load | one worker at a time, `stop_grace_period ≥ 45s` | zero re-QR, zero unresolved sends, zero lost jobs |
| C4 pacing soak | 1,000 simulated instances, steady profile, 8 hours | **zero cap violations**, zero lost jobs, zero unexplained `blocked_needs_review`, p99 `reserve()` < 25 ms |

Only after A + B + C do we publish a sessions-per-worker default, a capacity table or a price.

## 10.7 Risk register

Likelihood and impact are High/Medium/Low. "Owner" means who is accountable for the decision, not a separate person — this is a one-founder project with a single implementation line, and pretending otherwise would be the first dishonest line in the plan.

### Technical

| Risk | L | I | Mitigation | Early-warning signal | Owner |
|---|---|---|---|---|---|
| **Per-session memory is unmeasured.** 35 MB/session carries the whole cost model; 60-80 MB is plausible for accounts with large contact sets and doubles fleet and price | H | H | `syncFullHistory:false`, `markOnlineOnConnect:false`, no in-process message store, bounded caches, Redis signal keys with TTL; V1-P8 measures it before anything is quoted | `wp_session_rss_bytes_est` rising with contact count; worker RSS above plan at 150 sessions | Build lead |
| **Redis is a single point of failure.** Losing it stops the fleet within 10 s — fail-safe, not fail-over | M | H | Postgres-minted fence, so a flush costs one takeover cycle, not a silent outage; nothing is lost; Sentinel/replica deferred to V2-P6 | Redis latency spikes; `wp_lease_lost_total` climbing fleet-wide | Founder (accept in writing, question 11) |
| **Echo-based reconciliation is unproven at code level.** If `fromMe` replay is unreliable, more sends land in the manual queue | M | M | SPIKE-2 early in V1-P3; two in-flight attempts sharing a hash resolve *neither*; the manual queue is designed, not improvised | `wp_unresolved_jobs_total` / `wp_reconcile_ambiguous_total` above 0.1% of sends/day/instance | Build lead |
| **Fencing bounds duplicates, it cannot eliminate them** — a split-brain send can reach a recipient before the fence rejects the record | L | M | Lease + fence + 15 s watchdog; at most one duplicate per event; no copy anywhere claims exactly-once delivery | `wp_fence_regression_total` > 0; `wp_lease_takeovers_total` > 3/hour on one instance | Build lead |
| **Postgres is also a single node in v1** | L | H | pgBackRest to B2, RPO 5 min / RTO 60 min, restore drill **before** the first paying tenant; sending pauses safely when PG is down | backup age; restore drill overdue | Founder |
| **Lease-grab gives no placement control** — one worker may hold a disproportionate share of heavy accounts | M | L | deliberate YAGNI at 1,000 instances; soft yield at 0.9× cap on lag; revisit only if measured | `wp_worker_eventloop_lag_p99` diverging between workers | Build lead |

### WhatsApp platform

| Risk | L | I | Mitigation | Early-warning signal | Owner |
|---|---|---|---|---|---|
| **Tenant account restriction / ban.** An unappealable restriction risk on the tenant's real number; no appeal path, no quality-rating API | H | H | Safe Mode ON with no off-switch, warm-up, cold-outreach caps, content guards, opt-out registry, immediate pause on a hard signal, human-only resume; disclosed via `SAFE_MODE_DISCLAIMER` in onboarding, ToS and marketing. **We reduce sender-side velocity signals; we cannot prevent bans — recipient reports, content and account reputation dominate and no sender-side pacing controls them** | opt-out rate > 10/1,000 for a client; rejected-send rate rising; any 403/402/406; delivery ratio falling | Founder (posture, question 23); Build lead (mechanism) |
| **Baileys upstream / protocol change.** An unofficial library against an undocumented protocol; a WhatsApp change can break linking, sending or the enum overnight | M | H | Pinned version with a documented upgrade drill; the `MessageTransport`/`ChannelLink` boundary makes an engine swap a component swap; `disconnect_map_covers_every_enum_member` fails the build on an unmapped member; unknown codes fail **safe** (degraded → paused after 2 attempts); V2-P1's Cloud API adapter is the hedge the boundary keeps cheap | spike in `wp_reconnect_attempts_total{code=unknown}`; `disconnect.unmapped` log lines; fleet-wide link failures after a WhatsApp client release | Build lead |
| **WhatsApp Business Terms posture.** A QR/linked-device product is not an officially sanctioned integration path | M | H | Disclosed to tenants up front; zero evasion mechanisms (no rotation, proxies, fingerprint spoofing or auto-resume); the official channel is a v2 adapter, not a rewrite | ecosystem-wide enforcement reports; sudden correlated restrictions across the fleet | Founder |

### Security

| Risk | L | I | Mitigation | Early-warning signal | Owner |
|---|---|---|---|---|---|
| **Session credential theft** (DB dump, backup, insider) | L | H | Envelope AES-256-GCM, DEK per record, purpose-separated KEKs with the `session` KEK in workers only, AAD split by layer so rotation cannot brick sessions, key ring 0400 root-owned outside the image | failed-decrypt rate > 0; unexpected `wp_admin_app` connections | Build lead |
| **Live sessions are plaintext in worker memory** — a core dump, heap snapshot or swapped page contains them, and root on the host defeats us | M | H | `RLIMIT_CORE=0`, core pattern disabled, swap off or encrypted, production heap snapshots disabled; stated plainly. **"0 gaps" is not a promise anyone can honestly make** | any process producing a dump; unexpected root sessions | Build lead |
| **Cross-tenant leak on a background path** (the leak both reference repos actually had) | M | H | Four isolation layers plus suite B running every background path with two tenants; the `CROSS_TENANT_QUERIES` registry with role, reason and projected columns | suite A red on a new table; a registry entry added without review | Build lead |
| **Key-ring loss** — no keys, no sessions, no recovery | L | H | Three copies (host store, founder's offline encrypted copy, sealed second copy) with a quarterly restore drill; a backup never restored is not a backup | drill overdue | Founder |

### Business

| Risk | L | I | Mitigation | Early-warning signal | Owner |
|---|---|---|---|---|---|
| **A capacity or price number gets quoted before it is measured** | M | H | Every derived figure is labelled derived; V1-P8 gates any published capacity or price; the website ships last, after the numbers exist | a number in a deck, pricing page or sales call before V1-P8 | Founder |
| **Warm-up patience vs churn.** ~30 days to ~1,000/day; a tenant who signs up Monday sends 20 messages that day | H | M | Honest onboarding copy showing the ramp before signup completes; visible per-tenant progress; the ramp is time- and health-gated, never purchasable | trial-to-paid drop at tier 1; support requests to "speed it up" | Founder (question 7) |
| **Tenants with bad lists.** Pacing cannot fix a purchased list | M | H | Consent attestation in onboarding, opt-out registry at three enforcement points, opt-out-rate alerting and tightening, plus a suspension threshold if the founder rules one | opt-out rate > 10/1,000; block-indicator signal rising | Founder (question 18) |
| **"Pay more, send faster" pressure** | M | M | Not built as an entitlement at any price; `ADMIN_RELAX` is platform-admin-only, floor-bounded, expiring, reasoned and audited | a sales conversation offering it | Founder (question 17) |

### Team and process

| Risk | L | I | Mitigation | Early-warning signal | Owner |
|---|---|---|---|---|---|
| **Bus factor of one.** One founder, one implementation line, no VCS | H | H | Written ADRs and this plan as the durable memory; `VERSION` + `CHANGELOG.md` + `scripts/snapshot.ps1` stamped archives to an external folder; runbook written in V1-P7, not after an incident | snapshots not taken for a week; a decision made without an ADR | Founder |
| **No measured velocity.** Every effort estimate in this plan is derived from scope, not from this team's throughput | H | M | Phases are sequential with gates; re-band all estimates after v1 ships | a phase running > 2× its band | Founder |
| **Scope creep from v2 into v1** | M | M | ADR 0016's rule: v1 builds no feature whose only justification is v2 (section 9) | a task whose acceptance criteria reference a v2 phase | Build lead |

## 10.8 Assumptions this plan makes

1. The pinned Baileys version links, sends and reconnects as documented, and its `DisconnectReason` enum is stable enough that a mapped table plus a fail-safe default suffices.
2. WhatsApp replays our own `fromMe` messages to a reconnecting linked device (the basis of reconciliation). Unvalidated until SPIKE-2.
3. Per-session RSS sits in the 25-45 MB band for idle-connected sessions under our config. Unvalidated until V1-P8.
4. One Postgres 17 node behind PgBouncer sustains the claim, reserve and event-write rates at 1,000 instances. Derived, not load-tested.
5. Redis holds encrypted `session`/`sender-key` material at ~2-5 MB per session with a 30-day TTL and is not the first memory bottleneck.
6. Tenants own the numbers they connect and have consent for the recipients they message. We attest it; we cannot verify it.
7. A VPS provider outside India is acceptable for v1 (question 16); the quoted prices are volatile 2026 EU snapshots.
8. Sending is predominantly outbound 1:1 text with light media — groups and deep inbox deferred. This assumption is what keeps the memory model valid.
9. The founder is reachable for pause/restriction escalations, because `paused → sending` structurally requires an authenticated human.
10. No AI and no second transport in v1: both are boundary-preserved, neither is built.

## 10.9 Open questions for the founder

Numbering is kept stable from the blueprint so answers can be recorded against an id.

### Must be answered before V1-P0 starts

| No. | Question | What changes with the answer |
|---|---|---|
| 1 | Is v1 selling "1,000 accounts **registered**" or "1,000 sockets **connected at once**"? | The capacity milestone, the box order and the pricing page: ~$150-250/mo vs ~$400-560/mo, and whether offline parking is a feature or an excuse |
| 2 | One user, many clients (agencies/resellers), or strictly one client per user? | Keeps `memberships` + `instance_grants`, or collapses `client_id` onto `users` and simplifies the authz model. Expensive later |
| 3 | Are bulk campaigns in v1, or single/small-batch sends only? | Campaign tables, the resumable expansion cursor, duplicate-fan-out ack and a large slice of UI |
| 5 | Message-content retention default: 24 months, or 6-12 with an upgrade? | Partition strategy and storage cost; very expensive after data accumulates |
| 6 | Is a working inbox part of "a real working panel", or is v1 send-and-track only? | The media pipeline, `messages` volume and the per-session memory model |
| 11 | Do you accept Redis as a single point of failure in v1? | Yes: ship as designed. No: ~1 day plus a box for Sentinel/replica in V1-P0/P7 |
| 20 | Admin backend as a separate deployable — confirmed? | Confirmed: as built (one extra deployable, ~150 MB RSS). Otherwise it becomes a role inside `app/backend` — and the folder layout is a binding instruction, so this needs your word |
| 21 | Website in Next.js confirmed over Astro? | Next as instructed; Astro would ship a lighter animated hero on Indian mobile networks. Changes no other folder |
| 22 | Snapshot location (`D:\kd\wp-snapshots\`), and does the script also write an encrypted off-box copy? | `scripts/snapshot.ps1` in V1-P0 |
| 23 | **Acknowledge the ban-risk posture** — unappealable restriction risk on the tenant's number, disclosed in ToS and onboarding | Nothing is built differently; everything about how we describe it is |
| 24 | **Acknowledge that capacity numbers are derived**, and nothing is quoted before V1-P8 | Gates pricing, sales conversations and the website |
| 25 | Confirm ADRs 0013-0016 and the updated 0002; confirm 0004 superseded (evasion-token bans stay) | The single item that unblocks implementation |

### Must be answered before the panel launches to real tenants

| No. | Question | What changes |
|---|---|---|
| 4 | Opt-out scope: client-wide (recommended) or per-instance? | Registry key shape and the compliance warning copy |
| 7 | Warm-up length vs customer patience (~30 days to ~1,000/day) | The number most likely to cause either churn or bans |
| 8 | Steady-state daily cap: 1,000/day/number, 2,000 ceiling — any real observed number? | Replaces a guess with data; seeds `pacing_warmup_tiers` |
| 9 | Default `ambiguous_send_policy`: `ask_me` (recommended) or `resend_once`? | Whether real people occasionally get a duplicate. Belongs in the ToS either way |
| 10 | Relink to a different number: hard-block (default) or allow with typed, audited confirmation? | Silent acceptance is number substitution and is off the table; this decides whether an explicit path exists |
| 12 | Do transactional instances (OTP, order updates) get a 24h window instead of 09:00-20:00? | A loosening path, so it needs a rule, not a toggle |
| 13 | Group actions during warm-up: hard-block or warn only? | A content-guard default |
| 14 | KEK hosting: file-based key ring on the VPS (recommended) or fund OpenBao/Vault now? | The only security decision with a real recurring cost; `KeyProvider` makes it a swap, not a rewrite |
| 15 | MFA mandatory for owners at launch? | The right call, and it will cost some signups |
| 17 | Who may grant a looser pacing profile — only you, or sales? | Platform-admin-only, reasoned, expiring, floor-bounded. Never a purchasable entitlement |
| 18 | High opt-out rate on a tenant who insists their list is opt-in: advisory, or a suspension threshold? | An enforcement policy plus its copy |
| 19 | May support staff read message bodies during impersonation? | Designed as no by default, metadata only, with separately-audited elevation |
| — | Who buys and owns the 10-20 real numbers for V1-P8 Phase B, and what if one is restricted mid-proof? | Whether the real-account phase of the scale proof can be scheduled at all |

### Later (does not block v1 delivery, blocks commercial claims)

| No. | Question | What changes |
|---|---|---|
| 16 | India data residency: hard requirement or latency preference? | Hetzner has no India region, so a hard requirement means re-pricing the whole capacity table before it means anything |
| — | Pricing model (per number, per message, per seat) and whether any SLA is offered | Needs V1-P8 numbers first; an SLA on a single-Redis, single-Postgres deployment is a promise we cannot yet keep |
| — | Does v2 open with breadth (billing) or with hardening (V2-P6)? | Decided by the measured numbers, not now (section 9) |

## 10.10 Immediate next steps

1. **Founder confirms ADRs 0013 (Baileys engine), 0014 (repo structure), 0015 (Safe Mode), 0016 (v1/v2 split) and the updated 0002 (Baileys not Meta, Next.js not Astro, no AI),** and records 0004 as superseded with its evasion-token bans still in force. Nothing below starts until this is done — it is the only hard blocker.
2. **Founder answers the twelve "before V1-P0" questions.** 1, 2, 5 and 6 shape the first migration and are the expensive ones to change later.
3. **Record every answer as an ADR update** (memory-keeper), and mark ADRs 0005-0010 confirmed or explicitly still-proposed, so no phase starts against an unsettled decision.
4. **Run `/feature V1-P0`** — explore the empty tree, architect only where an invariant is touched, founder approval, then a planner task list sized to one implementer run per task.
5. **Run `/build V1-P0`** — TDD per task, harden, full `scripts/ci`, one reviewer verdict, progress recorded.
6. **Schedule SPIKE-2 (echo replay) and SPIKE-4 (key-write throughput) inside V1-P3, SPIKE-1 (caller-supplied message id) inside V1-P4.** Each can change a design decision; a late spike only confirms a sunk cost.
7. **Do not start V1-P9 or V1-P10 early**, however tempting a sellable surface looks: v1's stated purpose is a technical proof, and a website selling unmeasured numbers is itself a claims risk (ADR 0016).

## 10.11 How this plan is maintained

**Update triggers** — the plan is edited (with an ADR where the change constrains future work) when:

1. V1-P8 produces measured numbers. **Every derived capacity, cost and density figure here is replaced by the measured one and the confidence label moves from Low-Medium to High.** Until then each such number carries the word "derived", with no exception for a slide, a pricing page or a sales call.
2. A founder answer lands for an open question — recorded against its number, affected section edited in place.
3. Baileys breaks against a WhatsApp protocol change, or the pinned enum changes.
4. A risk in 10.7 fires — the register gains what actually happened; `.memory/lessons/` gains the lesson if it cost real effort.
5. A phase gate fails in a way the plan did not anticipate.

**Where progress is tracked:** `.memory/progress/master-plan.md` is the execution tracker (a checkbox per phase and per task); `.memory/progress/<feature>.md` holds each feature's task list; decisions go to `.memory/decisions/`, surprises to `.memory/lessons/`, external findings to `.memory/research/`; the `.memory/MEMORY.md` index line is appended, never rewritten. This plan is the design; the progress files are the state.

**The rule that outranks the rest of this section:** an unmeasured number in this plan is a hypothesis with a deadline, and V1-P8 is the deadline. Nothing derived is quoted to a customer, and nothing measured is softened back into a promise.

