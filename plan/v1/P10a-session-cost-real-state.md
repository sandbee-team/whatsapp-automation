# P10a — session-cost-real-state

**Goal (one line):** component B exists — Signal/group state is measured on real linked numbers, the two Signal caps are set from M3 (not defaults), the session-cost table is re-published complete (no SOCKET-ONLY marker), and **Gate A closes**.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P10 (must be `done`) **+ founder open item 6 resolved** (≥ 3 real linked test numbers + a pool of consenting test contacts — see Prerequisites)
**Blocks:** Gate A (ADR 0018 §8), P26's capacity-table quality (P26 runs either way but its Gate-B table inherits this phase's B-component)

> Split origin: P10 session 2026-09-01. The ≥3 real linked test numbers did not exist (P08's live-scan
> demo was still the founder's open item — scope-delta founder open item 6), so P10 ran component A
> (synthetic sockets) only and published the table marked **SOCKET-ONLY**, exactly as its Prerequisites
> instructed. This file carries P10's steps 5, 6 (the M3-measured cap VALUES — the config plumbing
> landed in P10) and 8 (the complete table). Gate A closes here, not at P10.

## Prerequisites (facts, not phases)
- P10 is `done`: the mock WA peer, measure fleet, ramp runner, capacity math in `@wp/domain`, the
  SOCKET-ONLY table in `docs/capacity/session-cost.md`, `check-capacity-gate`, and the feedback loop all
  exist; `scripts/ci.ps1` green.
- **≥ 3 real linked test numbers** (founder buys/links them — never bulk-registered; safety skill) and a
  pool of **consenting** test contacts. Without these this phase cannot start — do not simulate around it.
- A real 5-participant test group among consenting contacts. A real 150+ participant group is NOT
  required (extrapolate from records-per-participant-device and label it, per P10's risk list).
- The Linux measurement target from P10 still available; `redis-sig` still `noeviction` (ADR 0018 §5).
- ADRs 0013, 0015-0018, 0020 in force.

## What you are building (3-6 bullets)
- **M3/M10 measured for real**: bytes + record count per distinct contact and per group participant
  device on 3-10 real linked numbers (5-participant group measured for real).
- **Injection to scale**: real-shaped records injected through the real `EncryptedAuthStore` to reach
  100 / 500 / 2,000 distinct contacts and a 150+ participant group's device count (≤ the 2,000-device
  cap), re-measuring heap + `MEMORY USAGE wp:sig:*`. Injected rows labelled `EXTRAPOLATED`, never `MEASURED`.
- The two **Signal caps set from M3** (`SIGNAL_KEYSTORE_MAX_RECORDS`, `REDIS_SIG_MAX_FIELDS_PER_INSTANCE`
  — the P10 plumbing, new VALUES), then `MAX_SESSIONS_PER_WORKER` + per-worker `mem_limit` recomputed
  from the composed A+B model.
- The **complete published table**: SOCKET-ONLY marker removed, component B rows added with
  MEASURED-LOW-N / EXTRAPOLATED banners, the ≥ 60 MB redesign fork re-evaluated on the full blended
  figure, **Gate A recorded closed** in `.memory/progress/master-plan.md`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| The parent phase | `plan/v1/P10-measure-session-cost.md` | whole file — its step 5/6/8 text and risk list are the spec |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | § Per-session memory budget and the 10k fleet |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §2, §3, §5, §8 |
| Design | `.memory/research/2026-08-26-v1r-design-10k-concurrency.md` | §6 measurement plan (M3, M10), §1.4 |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms — no bulk registration, no rotation on restriction |

## Ordered minimum steps
- [ ] 1. Signal-state fixtures + working-set measurer (P10 step 5 verbatim): measure per-contact and
  per-group-participant-device record size/count on the real numbers; inject real-shaped records through
  the real store to 100/500/2,000 contacts and 150+ group device count; re-measure heap +
  `MEMORY USAGE wp:sig:*` → `app/backend/src/engine/measure/signal-state-fixtures.ts`,
  `scripts/measure/signal-working-set.ts`, `docs/measurements/<date>-componentB-signal.json`
- [ ] 2. Set both Signal cap VALUES from M3 (P10 step 6's deferred half); re-run the 2,000-recipient
  no-thrash assertion against the measured budget → `app/backend/src/platform/config.ts` defaults,
  `infra/compose/docker-compose.dev.yml` redis-sig sizing note
- [ ] 3. Recompute `WORKER_MEASURED_SESSION_MB_*` from the composed A+B model; recompute per-worker
  `mem_limit`; re-run `scripts/check-box-memory.ts` → config + compose
- [ ] 4. Re-publish `docs/capacity/session-cost.md` complete (banner: MEASURED (A) · MEASURED-LOW-N (B)
  · EXTRAPOLATED (injected rows) · Gate B (P26) still open); re-evaluate the ≥ 60 MB fork in writing;
  record Gate A closed → docs + `.memory/progress/master-plan.md`

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| P10's suite | all still green | the caps/values change must not break the P10 plumbing tests |
| `scripts/guards/check-capacity-gate.test.ts` | existing cases | banner/sample-size/leak checks hold on the re-published table |
| new (this phase) | injection rows labelled EXTRAPOLATED | a row sourced from injection can never carry MEASURED |

Mandatory-suite tests this phase makes green: none. Closes measurement items **M3, M10** and **Gate A**.

## Definition of done
- [ ] Every step box above is ticked.
- [ ] `scripts/ci.ps1` output pasted verbatim into the session log — green.
- [ ] `docs/capacity/session-cost.md` has no SOCKET-ONLY marker; every B row traceable to a JSONL/JSON artifact; injected rows labelled EXTRAPOLATED.
- [ ] The ≥ 60 MB fork re-evaluated in writing on the full blended figure.
- [ ] Gate A recorded closed in `.memory/progress/master-plan.md`.
- [ ] `reviewer` verdict recorded; invariant check (C3) done; files list below complete.

## Files created or changed this session
<!-- fill during the session -->

## Risks / gotchas specific to this phase
- Inherit P10's risk list wholesale — especially: consenting contacts only; injection (not mass
  messaging) to reach 2,000 contacts; a restricted test number is DATA, not a problem to route around
  (no rotation/failover/auto-resume, ever); `redis-sig` stays `noeviction`; purge the injected keyspace
  after the run.
- Do not let the founder's test numbers idle-expire mid-phase — schedule the measurement within the
  session, numbers linked at the start.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P11 — send-path-mvp. Read plan/v1/P11-send-path-mvp.md and follow it exactly:
one phase, one session. Deps P10 are done (see plan/README.md). Do not start P12.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
