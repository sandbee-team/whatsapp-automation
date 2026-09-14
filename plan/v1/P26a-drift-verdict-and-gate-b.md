# P26a — drift-verdict-and-gate-b

**Goal (one line):** the 7-day drift run launched in P26 is read back, the leak verdict (least-squares MB/day slope with its 95% CI over ≥ 6 days of hourly samples) and the detached 8-hour pacing artifact are written into `docs/capacity/fleet-capacity.md`, and the Gate-B banner flips from `DRIFT VERDICT PENDING — P26a` to `GATE B CLOSED — measured to N=<n>` — or the leak is raised as a `/decide`, never smoothed.
**Status:** todo · **Size:** S (~1 hour, run on **day 8** — no earlier) · **Session:** 1 of 1
**Depends on:** P26 (must be `done`) **+ calendar**: the drift artifact must cover ≥ 6 days of hourly samples (launched 2026-09-07; earliest honest run **2026-09-15**)
**Blocks:** every capacity or price claim (ADR 0016, ADR 0018 §8); P29's launch checklist row "Gate B closed"

## Prerequisites (facts, not phases)
- P26 is `done`: `packages/domain/src/capacity/drift-verdict.ts` (`driftVerdict`) and `scripts/measure/drift-run.ts` (`--checkpoint` / `--verdict` over a JSONL artifact) exist and are green; `docs/capacity/fleet-capacity.md` exists with the `DRIFT VERDICT PENDING — P26a` banner and `check-capacity-gate` accepts it.
- The drift run is **still running or has finished on its own**: `docs/measurements/raw/2026-09-07-drift-*.jsonl` exists, its header names the hardware fingerprint, N, the steady profile and the sample interval, and it holds ≥ 6 × 24 hourly `sample` rows. If the run died early (container restart, host reboot), the artifact is still read: **a 4-day run is reported as 4 days** and the verdict is `insufficient-data` — that is a real outcome, recorded, and the run is relaunched with the P26 checkpoint command for a further week; P26a then slides.
- The detached 8-hour pacing run artifact `docs/measurements/2026-09-07-pacing-8h.json` exists (or its absence is recorded as "8 h run did not complete — the in-session <duration> artifact stands").
- Zero real linked test numbers is still the state unless founder open item 6 closed in between — if numbers now exist, do **not** attach them here; that is P10a's component B, not this session.
- ADR 0018 accepted; 0020 in force. No new ADR is needed unless the verdict is `drift`.

## What you are building (3-6 bullets)
- The **leak verdict**: `driftVerdict` run over the real drift series — kind, slope MB/day, 95% CI, R², span in days, sample count — written into the capacity table with the artifact path beside it.
- The **8-hour pacing artifact verified** with the same `--verify` code path P26 used on the in-session run (zero ledger-derived cap violations, `reserve()` p99 < 25 ms, zero lost/failed/duplicated, other tenants' claim p99 within 20 %), and its measured duration written next to the target.
- The **Gate-B banner flip** (`GATE B CLOSED — measured to N=<n>`) — only when the verdict is `no-drift` AND the pacing artifact verifies; otherwise the banner stays and a `/decide` is raised naming the slope, the CI and the affected fleet-size math.
- The `check-capacity-gate` guard exercised against the flipped doc (it accepts either banner; a doc with neither is red).

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Prior phase | `plan/v1/P26-scale-proof-1k.md` | Dispatch plan → O2 findings (what was and was not measured); the drift checkpoint command in the P26 session log |
| Session log | `.memory/sessions/2026-09-07-P26-scale-proof-1k.md` | "Drift run" section: container name, artifact path, `--checkpoint` command, launch time UTC |
| Verdict math | `packages/domain/src/capacity/drift-verdict.ts` | module doc: `no-drift` / `drift` / `insufficient-data` rules (CI entirely above zero = drift) |
| Analysis CLI | `scripts/measure/drift-run.ts`, `scripts/measure/pacing-run.ts` | `--verdict <jsonl>` and `--verify <json>` modes |
| Doc + guard | `docs/capacity/fleet-capacity.md`, `scripts/check-capacity-gate.ts` | the banner constants `GATE_B_PENDING_BANNER` / `GATE_B_CLOSED_BANNER_PREFIX`, the measured-N / run-duration / error-bar markers |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §8 the gates; the only honest 10k sentence |
| Design | `.memory/research/2026-08-26-v1r-design-10k-concurrency.md` | §6.2 M6 ("a 24 h test proves nothing about a 30-day session"), §6.3 Gate 2 |
| Invariants | `.claude/rules/core-invariants.md` | 7 (a self-reported number is not evidence — the verdict is computed from the artifact, never typed) |

## Dispatch plan (SESSION-PROTOCOL E1)
Three steps, one unit each, sequential (each depends on the previous step's output):
- **U1** (main session, not a dispatch): step 1 — run the two analysis commands, paste their verbatim output into the session log.
- **U2** (implementer, sonnet): step 2 — write the verdict + pacing rows into `fleet-capacity.md`, flip or keep the banner, extend `BANNED_CAPACITY_FIGURES` with any new measured tokens, run the guard.
- **U3** (main session): step 3 — if `drift`, `/decide` (architect) before anything else; C1-C7.

## Ordered minimum steps
- [ ] 1. Read the artifacts, compute — never type — the numbers: `pnpm exec tsx scripts/measure/drift-run.ts --verdict docs/measurements/raw/2026-09-07-drift-<profile>.jsonl` (prints kind, slope MB/day, 95% CI, R², spanDays, sampleCount) and `pnpm exec tsx scripts/measure/pacing-run.ts --verify docs/measurements/2026-09-07-pacing-8h.json` (prints each SLO with its measured value and PASS/FAIL). Paste both outputs verbatim into the session log → `.memory/sessions/<date>-P26a-drift-verdict-and-gate-b.md`
- [ ] 2. Write the verdict into the table: `docs/capacity/fleet-capacity.md` gains a `## Drift verdict (M6)` section with kind, slope, CI, R², span, sample count, the artifact path and the hardware fingerprint from the artifact header; the pacing-run section gains the 8 h row (measured duration, four SLO values). Add every newly published measured token (unit-paired, e.g. `<slope> MB/day`) to `BANNED_CAPACITY_FIGURES` in `scripts/check-capacity-gate.ts`. If kind is `no-drift` AND every pacing SLO is PASS: replace the banner line with `GATE B CLOSED — measured to N=<measured N from the P26 pacing artifact>`; the honest sentence becomes "the architecture has no known ceiling below 10,000 and has been measured to N = <n>". If kind is `insufficient-data`: keep the pending banner, write the days actually covered, relaunch the drift run (P26 checkpoint command), and set this phase's row back to `todo` with the new earliest date. If kind is `drift`: keep the pending banner, write the slope and CI, and run `/decide` (architect) on the leak before anything else — no capacity figure is quotable while a positive slope stands → `docs/capacity/fleet-capacity.md`, `scripts/check-capacity-gate.ts`
- [ ] 3. Prove the gate: `pnpm run check:capacity-gate` green on the flipped doc; `pnpm vitest run scripts/guards/check-capacity-gate.test.ts` green (the case `a_closed_banner_is_accepted_and_a_missing_banner_is_rejected` below is added here if P26 did not already add it); then `plan/README.md` rows: P26a → `done` (or `todo` with the new date), and the Gate-B line in `.memory/progress/master-plan.md` ticked or annotated → `plan/README.md`, `.memory/progress/master-plan.md`

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/domain/src/capacity/drift-verdict.test.ts` | `a_flat_seven_day_series_returns_no_drift` (existing, P26) | the verdict function used in step 1 is the tested one |
| `scripts/measure/drift-run.test.ts` | `verdict_mode_reads_only_sample_rows_and_reports_the_span_it_actually_covers` (existing, P26) | a 4-day artifact prints `insufficient-data` with 4 days — never a fabricated 7 |
| `scripts/guards/check-capacity-gate.test.ts` | `a_closed_banner_is_accepted_and_a_missing_banner_is_rejected` | a doc carrying `GATE B CLOSED — measured to N=1000` passes clause (d); a doc with neither banner is red |
| `scripts/measure/pacing-run.test.ts` | `verify_mode_fails_when_any_slo_is_missed` (existing, P26) | a fixture with p99 26 ms prints FAIL and exits non-zero |

Mandatory-suite tests this phase makes green: none new (Gate-B evidence phase).

## Definition of done
- [ ] Every step box above is ticked.
- [ ] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (one full gate run, `powershell -File scripts/gate.ps1`).
- [ ] The verdict and the 8 h verification outputs are pasted verbatim, and the numbers in the doc are copied from them, not typed.
- [ ] Banner state is one of exactly two: `GATE B CLOSED — measured to N=<n>` (verdict `no-drift` + pacing PASS) or `DRIFT VERDICT PENDING — P26a` with the reason written (insufficient days, or a `/decide` ADR number for `drift`).
- [ ] `reviewer` verdict recorded (small phase: reviewer reads the doc diff + guard change only).
- [ ] Invariant check done (SESSION-PROTOCOL C3) — invariant 7 is the whole phase.
- [ ] Files created/changed listed below.

## Files created or changed this session
<!-- fill during the session -->
- `docs/capacity/fleet-capacity.md` — changed: drift verdict section, 8 h pacing row, banner flip (or reason)
- `scripts/check-capacity-gate.ts` — changed: new measured tokens in `BANNED_CAPACITY_FIGURES`
- `scripts/guards/check-capacity-gate.test.ts` — changed: closed-banner case (if not already present)
- `plan/README.md` — changed: P26a row
- `.memory/progress/master-plan.md` — changed: Gate B line
- `.memory/sessions/<date>-P26a-drift-verdict-and-gate-b.md` — created

## Risks / gotchas specific to this phase
- **Do not run before day 8.** A 5-day series returns `insufficient-data` by design; running early and "eyeballing" a slope is the exact dishonesty the verdict function exists to prevent.
- **Never type a number into the doc.** Every figure is copied from the two command outputs pasted in the session log.
- **A `drift` verdict is a founder decision, not a footnote.** It changes the sessions/box math in ADR 0018 §3 and the fleet cost table; raise it with `/decide`, keep the pending banner, and do not start P29's launch checklist row on top of it.
- **If the drift container died**, the artifact still exists — report the days covered. Relaunch with the same command (the P26 session log has it verbatim); do not "extend" the old series by concatenating two runs from different launches (different baselines break the slope).
- **The 8 h artifact may be absent** (VM restart). Then the in-session P26 artifact (with its real duration) remains the evidence, the doc keeps saying so, and the 8 h run is relaunched — Gate B still closes on the drift verdict only if the P26 in-session pacing run passed every SLO; otherwise it waits.
- **Nothing here closes Gate C** (≥ 2,000 concurrent in production for 7 days).

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
P26a closed Gate B (or recorded why not). The next open phase is whichever of P27 / P28 is not yet done —
check plan/README.md; if P27 already ran while the drift run was in flight, start P28:
Start phase P28 — admin-internal-api-and-panel. Read plan/v1/P28-admin-internal-api-and-panel.md and follow it exactly:
one phase, one session. Deps P25 are done (see plan/README.md). Do not start P29.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
