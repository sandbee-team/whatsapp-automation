# WP delivery plan (operational)

`MASTER-PLAN.md` = **why**. This folder = **what to do this session**.
Canon: `.memory/research/2026-08-25-v1-architecture-blueprint.md` + the authoritative delta
`.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` (+ ADRs 0017-0020).
Protocol: `plan/SESSION-PROTOCOL.md`. **One phase = one session.**

Rule: **`plan/` never explains, `MASTER-PLAN.md` never instructs.** If a phase file starts explaining why,
cut it and link. If MASTER-PLAN starts listing file paths, cut it and link.

---

## How to work (three lines)

1. Open the lowest phase whose status is `todo` and whose dependencies are all `done`; **claim it first**
   (its row here → `in-progress (claimed <session> <date>)`; already claimed by another session = STOP);
   then read only its file and its "Read first" table (`SESSION-PROTOCOL` **O1-O3**).
2. Work its Dispatch plan's units in order - parallel where marked - TDD inside each unit, first red stops the line
   (`SESSION-PROTOCOL` **E1-E3** — this is `/build P<NN>`).
3. Close with **C1-C7**: deep review of this session's file list → edge-case pass → the 7-invariant check →
   structure check → verbatim green `scripts/ci` → memory updates → paste the next-session prompt.
   **Do not start the next phase in the same session.**

## Where status lives

| Level | Authority |
|---|---|
| **Phase status** (`todo` / `in-progress` / `done`) | **this file's table below** — updated by `memory-keeper` at C6 |
| Step status inside a phase | that phase file's own `- [ ]` boxes — ticked during the session |
| Cross-cutting gates, founder open items, the v2 list | `.memory/progress/master-plan.md` |
| Decisions | `.memory/decisions/NNNN-*.md` |

No phase carries a checkbox in two files. `.memory/progress/master-plan.md` must not re-list these phases.

## Folder rules

- File name is `P<NN>-<slug>.md`, zero-padded, **never renumbered**. A phase found mid-flight to be too big
  splits into `P<NN>a-<slug>.md` appended after it; the tail keeps its numbers.
- Phase files name the **quick gate** for O2 (`pnpm run typecheck && pnpm run guards:meta`), never the full
  gate - the full `scripts/ci.ps1` belongs to C5 only. Every new phase file carries a **Dispatch plan** line
  above its steps (grouping them into 3-5 work units and marking parallel-safe units, per SESSION-PROTOCOL E1), and tests are
  written red-first inside the dispatch of the step they prove - never as an all-tests-upfront step.
- `plan/v1/` files are written **just in time**: the next 3 phases in full, the rest are rows below.
  Writing 30 detailed files up front guarantees 25 stale ones.
- `plan/v2/README.md` is an outline only — one line per v2 phase, no steps, no tests. It exists so nothing
  "temporarily" leaks into v1.
- Seven phases are sized **L**. L means *split it before you start if your session is a single sitting*;
  each L row states its split line. Realistic session count for v1 is ~37, not 30.

---

## Phases (v1) — canonical numbering, ADR 0020

Legend: **Dep** = must be `done` first. **Demo** = the one demonstrable outcome shown at session close.
**Old** = the `MASTER-PLAN.md` / ADR 0016 phase this material came from.

### Block 1 — foundations (nothing visible yet; everything depends on it)

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P00 | `workspace-guards-and-domain` | done | — | L (split: tree+guards / `@wp/domain`+`@wp/contracts`) | `scripts/ci.ps1` green and **every guard reports a non-zero matched-file count** | V1-P0 |
| P01 | `server-kit-and-crypto` | done | P00 | M | `kek_rotation_preserves_decryptability` and `auth_state_round_trip_preserves_buffers` green | V1-P0 |
| P02 | `db-foundations-and-isolation` | done | P01 | M | adding a `client_id`-less table turns isolation suite A red, live | V1-P1 |
| P03 | `db-queue-and-claim` | done | P02 | M | two workers race for one job — exactly one wins; tests 2/21/22/23 green; the merged claim's `EXPLAIN` is filed | V1-P1 |

### Block 2 — a person can log in

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P04a | `auth-signup-and-onboarding — a: auth+sessions (steps 1-6)` | done | P02 | L (split executed) | signup creates user+workspace+owner membership+wallet in ONE transaction, proven under wp_app FORCE RLS; refresh reuse revokes the whole chain; TOTP mandatory for owner | V1-P2 |
| P04b | `auth-signup-and-onboarding — b: wizard/frontend/e2e (steps 7-10)` | done | P04a | L (split) | an unverified account cannot reach Connect (server-side 403 + route guard); Playwright signup→verify→login→TOTP→wizard e2e | V1-P2 |
| P05 | `panel-shell-and-sse` | done | P04b | M | login → honest empty dashboard; SSE drops within 5 s of a membership revocation | V1-P2/P7 |

### Block 3 — a WhatsApp number connects and stays connected

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P06 | `session-lease-and-fence` | done | P03, P01 | M | two workers cannot hold one session; a hung Redis self-fences in 15 s (tests 3-6); fence lives in `instance_lease_state` | V1-P3 |
| P07 | `session-auth-store` | done | P06 | M | no plaintext credential in any datastore (test 7) | V1-P3 |
| P08 | `session-qr-linking` | done | P07, P05 | M | **a real number is scanned in the panel and shows "Connected as +91·····21"** | V1-P3 |
| P09 | `session-fleet-and-drain` | done | P08 | M | `kill -9` a worker holding N sessions: takeover ≤45 s, zero re-QR (tests 11-13); minimum worker metrics exist | V1-P3 |
| P10 | `measure-session-cost` | **done** | P09 | M | component A **MEASURED**: 0.227 MB/session (95% CI [0.209,0.244], R² 0.9994, 4 ramp points, Linux cgroup v2), published under SOCKET-RESIDENT-PRE-HANDSHAKE + SOCKET-ONLY banners; `check-capacity-gate` guard live; cap stays 69/`provisional` (measured keys deliberately unset) | V1-P8 (pulled forward) |
| P10a | `session-cost-real-state` | todo (blocked on founder-run live testing with real numbers - ADR 0048 §5, ADR 0045; the session runs only the harness/analysis once numbers are linked) | P10 **+ founder open item 6** (≥3 real linked test numbers) | M | **Gate A** closes: component B (real Signal/group state incl. a 5-participant and a 150+ participant group), the M3-measured Signal cap VALUES, the composed `dmOnly`/`groupEnabled` figures | V1-P8 (split from P10) |

### Block 4 — a message actually sends

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P11 | `send-path-mvp` | done | P10, P03 | M | ~~a message arrives on a real phone~~ **NOT DEMONSTRATED** (live/QR testing deferred by the founder; and the send loop is not yet wired to a live Baileys socket - see P11's gotcha 9). Closed on unit+integration evidence: a POST becomes a durable job, is claimed, dispatched through a fake transport and recorded with a 4-row events trail | V1-P4 |
| P12 | `queue-recovery-and-echo-spike` | done | P11 | M | 100 `kill -9`s between dispatch and result: zero lost, zero silent duplicates (tests 15-17 green); **SPIKE-2 built but NOT YET RUN** (needs real linked number; skeleton in `docs/evidence/P12-spike-2-echo.md` awaits founder operator run) | V1-P4 |
| P13 | `pacing-ledger-and-warmup — ledger+reserve (steps 1-8)` | done | P12 | L (split executed 2026-09-02) | 50 parallel claims never exceed the cap; a deny defers the job without touching `attempts` | V1-P5 |
| P13a | `warmup-ladder (P13 steps 9-10)` | done | P13 | M | a tier advances on a fake clock, a WATCH band freezes it and a DEGRADED band rolls it back one tier | V1-P5 |
| P14 | `pacing-guards-and-optout` | done | P13, P13a | M | STOP from a recipient cancels that contact's queued jobs (`cancel_reason='opt_out'`) — never fails them | V1-P5 |
| P15 | `outbox-relay-and-webhooks` | done | P12, P05 | M | the hostile-URL table (incl. DNS rebinding + TLS negative) all rejected; a live webhook receives a signed send event | V1-P4/P7 |

### Block 5 — the system defends itself

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P16 | `health-signals-and-pause` | done | P14 | M | a restriction signal pauses the instance; an API key and a system actor are both rejected at `/resume`; 72 simulated hours produce no auto-resume | V1-P6 |
| P17 | `notifications-and-instance-card` | done | P16, P15 | M | pause → panel banner + email + webhook, one of each, under a reconnect storm | V1-P6 |

### Block 6 — money

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P18 | `wallet-ledger-and-pricing` | done | P12, P02 | M | 100 crash-injected sends produce exactly one charge each; a replayed result write leaves the balance **byte-identical** — DONE 2026-09-04: 100 crash-injected sends → 100 guards/100 ledger rows/exact balance; replay leaves balance byte-identical; gate 26/26 green (attempt 2) | new (was V2-P2) |
| P19 | `wallet-gate-topup-and-staff-credit` | done | P18, P13 | M | balance hits zero: sending stops, **zero jobs failed or deleted**, banner + email; a staff-approved top-up resumes the drain and **does not** clear a restriction pause | new — DONE 2026-09-05: gate CI GREEN all 26 steps (386 files / 1396 tests); migrations 0058 (topup_requests + staff_audit_log) and 0059 (wallet_low/wallet_empty notification kinds); C1 APPROVED-with-notes after a CHANGES-REQUIRED round (split-transaction money-loss on staff approve, fixed + regression test); C2 found and fixed a bigint-paise precision bug |

### Block 7 — the product the founder described

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P20 | `contacts-and-import` | done | P14 | M | a 10,000-row CSV imports idempotently (re-upload adds nothing), opted-out rows flagged, attestation recorded, export and per-contact erasure work — DONE 2026-09-05: gate CI GREEN all 27 steps (429 integration files / 1531 tests); migrations 0060 (six tables, four enums, country_code, max_contacts), 0061 (composite tenant FKs on tag links), 0062 (contacts.last_import_id); C1 APPROVED-with-notes after two CHANGES-REQUIRED rounds; outcomes proven by integration tests, panel not driven by hand this session | new |
| P21 | `inbound-listener-receipts-and-optout` | done | P20, P12 | **S** | a real STOP cancels that contact's queued jobs and a delivered+read pair lands in `delivery_events` — with zero stored message text — DONE 2026-09-06: gate CI GREEN all 27 steps (attempt 3; 456 integration files / 1643 tests); migration 0063 (`inbound_dead_letters` + `whatsapp_instances.inbound_max_per_minute`); headless dispatcher + receipts + STOP + admission + per-worker in-flight limiter; C1 APPROVED-with-notes (MAJOR fixed + re-reviewed); C2 no bugs; ADR 0040 (receipt identity excludes the provider timestamp). **Evidence run NOT done** (needs a real linked number). Inbound contact auto-create + opt-out management screen carried to P23 | new (was V2-P3) |
| P22 | ~~`inbox-conversations-and-reply`~~ | **retired → v2 (V2-P3)** | — | — | number retired 2026-08-26 (ADR 0021); **not reused** — P23-P29 keep their numbers | — |
| P23 | `broadcast-campaigns` | done | P19, P20, P21 | L (split executed 2026-09-06: engine half here / composer+pre-flight+funnel UI → P23a) | **a broadcast to 500 contacts drains under pacing** (`expansion-drain-full-c1fix`: sent==500==pacing consumed ≤ cap 600, 500 refs, 0 orphans), survives a mid-expansion crash with no duplicates (mandatory test 20), and Cancel stops the very next claim — DONE 2026-09-06: gate CI GREEN all 27 steps (attempt 2; 482 integration files / 1720 tests; unit 328 / 2007; db 50 / 227); migration 0064 (`campaigns` ALTER incl. `instance_id`/`name`/`idempotency_key`, `campaign_recipients`, `campaign_counters`, `broadcast_recipient_status`); ADR 0041; C1 CHANGES-REQUIRED → fix round → APPROVED-with-notes; C2 no bugs; carried to P23a: receipt/send-result stamping, `completed` + `campaign.progress`, restamp replay store, profile-dependent fan-out threshold | new (was V2-P4) |
| P23a | `broadcast-composer-and-funnel (P23 steps 9-10)` | done | P23 | M | the pre-flight quote shows client-level deferrals, integer-paise billable, wallet after and a cap-derived ETA labelled an estimate; the funnel drains live over `campaign.progress`; every surface saying "Broadcast" carries the disclosure | new (split from P23 2026-09-06) — DONE 2026-09-06: gate CI GREEN all 27 steps (final run on the final tree; integration 502 files / 1784 tests; unit 335 / 2041; db 50 / 228); migration 0065 (partial index campaigns_funnel_discovery_idx); C1 APPROVED-with-notes → fix round (3 MAJOR / 4 MINOR fixed) → re-review APPROVED-with-notes; C2 green, 2 findings fixed; panel proof = component test over the real SSE invalidation path (no linked number this session); carried to P24: restamp replay store (+ lifecycle action keys), inbound contact auto-create, opt-out screen, GET /v1/instances list route |
| P24 | `groups-messaging` | done | P14, P21, P23, P23a | M | a message sent to a real group; group receipts do not collide with 1:1; a group 403 never pauses the instance | new — DONE 2026-09-06: gate CI GREEN all 27 steps (attempt 4; integration 533 files / 1877 tests; unit 344 / 2111; db 52 / 233); migrations 0066 (`wa_groups` counts-only + `whatsapp_instances.groups_*` clock), 0067 (`notification_kind` += group_forbidden), 0068 (wp_app UPDATE on `groups_sync_requested_at`); C1 APPROVED (round 3, after two CHANGES-REQUIRED rounds; the round-1 CRITICAL was a dead production hook); C2 12 files/39 cases, 2 RED fixed; ADR 0042; live-number evidence Part B NOT RUN |

The inbox **product** (conversation threads, replies, media, search, message bodies) is **v2 (V2-P3)**; v1 keeps a headless inbound listener only — receipts, opt-out detection, echo evidence and two contact timestamps. See `.memory/research/2026-08-26-inbox-to-v2-split.md` and ADR 0021. Phase numbers are never reused or renumbered: the P22 slot stays empty.

### Block 8 — operate it, then prove it

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P25 | `observability-and-runbook` | done | P24 | M | stop a worker → `wp_instances_unowned` alert fires; the log-grep test finds no seeded phone, body, email or API key — DONE 2026-09-07: gate CI GREEN all 31 steps (attempt 3 on the final tree; attempt 1 failed at `lint` (a 308-line test file, split), attempt 2 at `integration` (6 tests / 2 root causes: P25 opt-out tests left `outbox_events` fan-out rows that the fleet-wide relay tests count; two pre-existing flaky assertions fixed at the cause)); 91 `wp_*` registrations inventoried + guarded (`check-metric-inventory`, `check-metric-manifest`, `check-alert-rules`, `check-dashboards` CI steps; 35 guards); migration 0069 (`notification_kind += optout_rate_high`, schema 69); internal-only `/metrics` listener per role; 5-min rollup collector (`wp_messages_out_without_job` = invariant 1 as a gauge); 23 alerts + 5 SLO rules promtool-tested; 4 dashboards / 47 panels; `docs/RUNBOOK.md` 23 alert sections + 14 procedures; log-grep PII test green (logs, console, scrape, audit metadata, outbox payload); unowned-alert demo FIRING at 120 s with 0 jobs touched; C1 CHANGES-REQUIRED → fix round → APPROVED-with-notes; C2 34 hunt items, 2 real bugs fixed. NOT done: live stack smoke; deferred `wp_pacing_orphan_reservations_total`/`wp_pacing_ledger_repair_total`; `wp_instance_queue_depth`/`wp_instance_oldest_queued_seconds` unregistered; `campaign_recipients` retention scheduler (`scheduledBy: 'P25'`) carried | V1-P7 |
| P26 | `scale-proof-1k` | measured; close deferred (founder pivot 2026-09-07: go-live now, drift verdict dropped as a gate; C5 discharged by P26b's gate for every step EXCEPT its own 6 fleet-scale suites, which cannot run on the shared dev Redis while `wp-p26-drift` is live - see the P26b session log) | P25, P10 | L (split: synthetic+7-day drift / real numbers+chaos) | **Gate B**: the measured capacity table; zero cap violations; p99 `reserve()` < 25 ms. This phase unblocks every capacity and price claim | V1-P8 |
| P26a | `drift-verdict-and-gate-b (P26 step 9 split — calendar)` | **parked** (founder 2026-09-11, ADR 0048 §6: rerun the drift only if a capacity figure is ever to be published; **re-plan when reopened:** the 2026-09-07 drift artifact ended at hour 32 - container exited on a Docker restart 2026-09-08; `drift-run-cli --verdict` = `insufficient-data`, span 1.33 days - so this phase now starts with a fresh ≥ 6-day drift launch on isolated infra per ADR 0047 (c), earliest verdict 6 days after that launch) | P26 **+ calendar: drift artifact ≥ 6 days (launched 2026-09-07 → earliest 2026-09-15)** | S (~1 h, day 8) | `driftVerdict` over the real 7-day artifact → slope + 95% CI written into `docs/capacity/fleet-capacity.md`; the 8 h pacing artifact verified; banner flips to `GATE B CLOSED — measured to N=<n>` or a `/decide` is raised; not a go-live gate any more (founder, 2026-09-07); run only if capacity figures are ever to be published | V1-P8 (split from P26 2026-09-07) |
| P26b | `panel-ui-overhaul` | done (2026-09-11; C5 gate GREEN on `wp_test2` in the v1 release-gate session after ADR 0047's two fixes - the six fleet-scale suites were a PgBouncer routing bug plus a drain in-flight stub, never a founder decision; verbatim tail in `docs/evidence/V1-RELEASE-GATE-2026-09-11.md` §4; the attempt-4 evidence of 2026-09-08 stands for every other step) | P25; P26 measurements (gate deferred, runs with P26b's gate) | L (one session: design system + shell + auth/onboarding + every route + demo seed + journey e2e) | Production-grade SaaS panel UI end to end, verified by a Playwright click-through and before/after screenshots; references `D:kdopenpanel-main`, `demo/evolution-manager-v2`, `demo/Blastup` (patterns only). |
| P27 | `scale-path-10k` | **parked** (founder 2026-09-11, ADR 0048 §1/§6: expected scale is at most 400-500 clients; reopen only if a quotable capacity figure or >1,000 concurrent sessions become real) | P26 | L (split per lever: worker split / Redis split / read replica) | 10× the measured per-box session count across N workers with the panel unchanged, plus a documented, costed path from the measured number to 10,000 | new |

### Block 9 — the surfaces the founder asked to come last

| id | phase | status | dep | size | demo | old |
|---|---|---|---|---|---|---|
| P28 | `admin-internal-api-and-panel` | done | P25 | L (split: `/internal/v1`+staff auth / admin UI) | the grant snapshot proves `wp_admin_app` cannot write any send-path table; staff suspend a client and adjust a wallet, both audited and notified (C5 gate: 29 non-integration steps + db 55/55 + backend integration 596/602 files green; 6 red are pre-existing P26 fleet suites) | V1-P9 |
| P29 | `website-and-launch-hardening` | done (2026-09-09; session 1 = steps 1-6, session 2 = P29a steps 7-10; C5 gate 2026-09-09 on `wp_test2`: 33 steps through `integration`, unit 549/549 files, db 57/57, backend integration 597/603 with the 6 red being exactly the P26 fleet-scale suites (founder decision still open), admin-backend integration 15/15 + `build` + `website-build` + `website-lcp` green standalone - evidence `docs/evidence/P29a-gate-tail.md`) | P28 | L (split: marketing site / restore + key drills + launch checklist) | LCP ≤ 2.5 s on an India 4G profile in CI, `check-copy` green including Hindi, and **a timed restore from backup before the first paying tenant** | V1-P10 |
| P29a | `launch-hardening-and-drills (P29 steps 7-10 split — 2026-09-08)` | done (2026-09-09; three scanners as pinned Docker images + CI steps, timed key-ring drill 39 ms PASS, timed base-backup restore drill RTO 94 s / RPO 0 s PASS with real parity + ledger chain, `docs/LAUNCH-CHECKLIST.md` 14 DONE / 16 NOT DONE, migration 0075 `consent_tos_version`, six statements on the consent step; C1 CHANGES-REQUIRED round fixed in-session; same six P26 suites red in C5) | P29 (session 1) | M-L (one session; re-split after step 8 if the drills do not fit) | Semgrep + Trivy + filesystem-mode secret scan as CI steps, a **timed** PITR restore drill and a **timed** key-ring restore drill with evidence files, `docs/LAUNCH-CHECKLIST.md` with one artefact per row, six ToS statements on the onboarding consent step, full gate green | V1-P10 (split from P29 2026-09-08) |

**P27 does not deliver 10,000 live sessions.** At the derived bracket that is 180-350 GB of session RAM and
5-10 app boxes — a funding decision, not a coding one. P27 delivers the architecture plus the measured
extrapolation, so reaching 10,000 is buying boxes rather than rewriting.

## Where v2 lives

`plan/v2/README.md` — outline only. Nothing from that list may be built inside a v1 phase.

---

## The per-phase file template (copy verbatim; nothing is optional — an empty section says `none`)

````markdown
# P<NN> — <slug>

**Goal (one line):** <what exists at the end that did not exist at the start>
**Status:** todo | in-progress | done · **Size:** S|M|L · **Session:** 1 of 1
**Depends on:** P<NN>, P<NN> (must be `done`)
**Blocks:** P<NN>, P<NN>

## Prerequisites (facts, not phases)
- <a fact this session must be able to assume, e.g. "Postgres 17 + Redis 7 up via infra/compose/docker-compose.dev.yml">
- <a decision that must already be accepted, e.g. "ADR 0019 accepted">

## What you are building (3-6 bullets)
- <bullet>
- <bullet>

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | <§ name> |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | <§> |
| ADR | `.memory/decisions/<NNNN-slug>.md` | — |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/<db|queue|api>-*.md` | all |

## Ordered minimum steps
- [ ] 1. <one action> → `<path/one.ts>`, `<path/two.sql>`
- [ ] 2. <one action> → `<path>`
- [ ] 3. ...
(max 10; if an 11th appears, stop and split into P<NN>a)

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `<path>.test.ts` | `<case_name>` | <assertion> |
| `<path>.test.ts` | `<case_name>` | <assertion> |

Mandatory-suite tests this phase makes green: <numbers from the blueprint's mandatory tables, or `none`>.

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
- <a concrete failure mode a session will hit here, and what to do>
- <a safety-boundary trap specific to this phase, if any>

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P<NN+1> — <slug>. Read plan/v1/P<NN+1>-<slug>.md and follow it exactly:
one phase, one session. Deps P<NN> are done (see plan/README.md). Do not start P<NN+2>.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
````

Why each part exists: **prerequisites** stop a session starting on a broken machine; **read first** removes
the exploration tax, which is the single biggest per-session cost in a repo this size; **files created or
changed** is the substitute for `git diff` and is the reviewer's input, so it is not optional bookkeeping;
**next-session prompt** is the paste-to-continue requirement and is written by the *previous* phase's
author, who knows what actually landed.
