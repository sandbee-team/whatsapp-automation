# Session cost — capacity measurement (P10)

Status: **COMPONENT A MEASURED** (P10, 2026-09-01). The component-A run (Unit
U4) landed: 4 ramp points, real Baileys sockets held resident on a Linux
cgroup-v2 target, fitted RSS slope with R² and a 95% CI. Component B (real
Signal/group state — the dominant DM variable) is **BLOCKED this session** (no
real linked test numbers; founder open item 6) and carried to P10a (ADR 0032).
**Gate A closes at P10a, not here.** This document, its banner, and the
`check-capacity-gate` guard exist so no number can be quoted before it is
measured.

## Banner (verbatim — must appear unmodified in this file)

```
SOCKET-RESIDENT-PRE-HANDSHAKE (component A, ADR 0032) · SOCKET-ONLY (component B deferred to P10a — no real Signal/group state measured) · EXTRAPOLATED (injected rows, P10a) · Gate A OPEN (closes at P10a) · Gate B (P26) still open — no number here may be quoted to a customer (ADR 0016, ADR 0018 §8)
```

## Method note — what component A does and does not measure (ADR 0032, verbatim)

> `SOCKET-RESIDENT-PRE-HANDSHAKE (component A): real Baileys sockets constructed through the real EncryptedAuthStore and bounded Signal key store, holding a live TLS/WS connection and the full socket object graph resident at the awaited-serverHello point of the real Noise XX handshake. The handshake does not and cannot complete against a local peer (no cert forgery — invariant 6). This measures §1.1 rows 1,2,3,7,11,12. It does NOT measure the post-handshake transport (row-1 keepalive cadence, the noise transport cipher state), the initial app-state/query traffic, or any real Signal/group working set (rows 4,5,6,9 — component B, P10a). Not a per-session cost; the per-session number is A + B. No figure here may be quoted to a customer (ADR 0016, ADR 0018 §8).`

The "stall-before-serverHello" mock peer (`app/backend/src/engine/measure/mock-wa-peer.ts`)
accepts the TCP+TLS+WS upgrade, reads the client's `clientHello`, and then
never sends a valid `serverHello` — the socket sits resident at
`awaited-serverHello`, never reaches `open`, and never reconnect-loops. See
ADR 0032 for the full rejected-alternatives analysis (no cert-forgery
shortcut was built or considered viable).

## Sample size

N (sample size) = **4 ramp points** (50 / 250 / 1,000 / 2,000 resident
sockets), **12 samples per point** taken at 5 s intervals across a 60 s soak
after a forced GC and a 20 s settle. The published per-session figure is a
single **least-squares slope fitted ACROSS the 4 ramp points** (with R² and a
95% CI), never a per-point `total RSS / N` average — the fitted intercept
(305 MB of worker baseline, pools and JIT) is exactly what a total/N average
would wrongly attribute to sessions. This line is the guard's required
"sample size" marker and must stay present for `check-capacity-gate` to pass.

**Window honesty:** the phase spec calls for a 5-minute settle and a
20-minute soak per point. This session ran a 20 s settle and a 60 s soak
(forced GC, settle and multi-sample soak all real, but shorter). The
shortened window is recorded in the raw artifact header and is why the
production feedback loop (ADR 0018 §3, `wp_session_rss_bytes_est`, 24 h
trimmed mean) remains the authoritative long-run correction rather than this
lab number.

## Hardware fingerprint

| Field                    | Value                               |
| ------------------------ | ----------------------------------- |
| Target                   | Docker WSL2 VM (Linux container)    |
| CPU model                | 12th Gen Intel(R) Core(TM) i5-12500 |
| Cores (vCPU)             | 12                                  |
| RAM                      | 16,608,600,064 B (~15.5 GiB)        |
| Kernel                   | 6.6.87.2-microsoft-standard-WSL2    |
| cgroup version           | v2                                  |
| Node version             | v24.20.0                            |
| Baileys version (pinned) | 7.0.0-rc14                          |
| Captured (UTC)           | 2026-09-01T08:31:10.640Z            |

## Ramp points

- Per box: `50/250/1000/2000` — **RUN** (planned `50/250/1000/2500`; the
  **2,500 point is TRUNCATED**, recorded in the artifact header)
- Per worker: `60/135/200/250` — **NOT RUN this session**, carried to P26 (M7)

The planned 2,500-per-box top point is truncated — 2,500 resident sockets
plus the worker baseline and heap will not fit 15.5 GiB with headroom; the
truncation is recorded explicitly in the raw artifact header
(`truncatedRampPoints: [2500]`), never fabricated. Four points remain, which
satisfies the ≥ 4-point requirement for a valid slope fit.

## Component A — per-component table (SOCKET-RESIDENT-PRE-HANDSHAKE, error bars)

**Observed RSS per ramp point** (one process, `idle` profile; every point had
`residentCount === sessions`, so no point was voided):

| Ramp point (sessions, per process) | RSS (bytes) | RSS (MB) | cgroup `memory.current` (MB) | lag p99 (ms) | CPU % | batch-add time (ms) | redis-sig (MB) |
| ---------------------------------- | ----------- | -------- | ---------------------------- | ------------ | ----- | ------------------- | -------------- |
| 50                                 | 331,583,488 | 316.2    | —                            | 13.13        | 0.71  | 1,037               | 3.04           |
| 250                                | 375,099,392 | 357.7    | —                            | 13.35        | 0.68  | 3,049               | 3.04           |
| 1,000                              | 564,686,848 | 538.5    | —                            | 14.24        | 0.84  | 11,345              | 3.04           |
| 2,000                              | 791,670,784 | 755.0    | 899.1                        | 14.55        | 0.84  | 14,963              | 3.04           |

**Batch-add time column (WARNING 5, FIX-P10-A):** this column was previously
labelled "connect p99" and implied a per-socket connect latency. It is
actually a cumulative BATCH-BUILD duration - one sample per ramp point,
covering the whole sequential `addSessions(delta)` loop for that point
(~20 ms/socket at this repo's measured rate), taken from
`scripts/measure/ramp-sessions.ts`'s `batchAddMs` tracker (renamed from
`connectLatency`/`connectMsP99`). No per-socket connect/handshake latency was
measured this session — carried to P26/M5. The raw JSONL artifact
(`docs/measurements/raw/2026-09-01-componentA-idle.jsonl`) is historical
evidence and was NOT rewritten; its `connectMsP50`/`connectMsP99` fields
carry this same batch-add semantics under their original field names.

**The fitted result** (least-squares across all 4 points — this is the
published component-A figure):

| Quantity                           | Value                                                    |
| ---------------------------------- | -------------------------------------------------------- |
| **RSS slope (MB/session)**         | **0.227**                                                |
| 95% CI on the slope                | [0.209, 0.244] (width 0.034)                             |
| R²                                 | 0.9994                                                   |
| Fitted intercept (worker baseline) | 305.0 MB                                                 |
| Ramp points in the fit             | 4 (≥ 4 required; a 3-point fit is rejected)              |
| Raw artifact                       | `docs/measurements/raw/2026-09-01-componentA-idle.jsonl` |
| Fit summary                        | `docs/measurements/2026-09-01-componentA-fit.json`       |

**Why the slope, not `total/N`:** at the 2,000-session point `total RSS / N`
= 791,670,784 B / 2000 = 395,835.4 B/session = **0.377 MB/session** (same MiB
base as every other figure in this table: 395,835.4 / 1,048,576), ~67 %
higher than the fitted 0.227 MB — the 305 MB baseline is not a per-session
cost. R² = 0.9994 (well above the 0.9 "broken run" floor) says the linear
model holds across the ramp.

**Per-worker ramp (60/135/200/250): NOT RUN this session.** The per-box ramp
above already spans 50→2,000 in one process, which covers and exceeds the
per-worker range, and the derived worker cap is computed from the same slope.
Carried to P26 (per-worker lag/GC-pause characterisation, M7) rather than
silently claimed here.

Every published row above is traceable to the single raw JSONL artifact
`docs/measurements/raw/2026-09-01-componentA-idle.jsonl` (header + one sample
row per tick + one summary row per ramp point + the fit row).

## Component B (SOCKET-ONLY this session — BLOCKED, carried to P10a)

Real Signal/group state (§1.1 rows 4,5,6,9) is not measured this session.
No real Signal/group state numbers exist in this document. P10a supplies:

- The record-size measurement (`record_kb` below).
- The composed `dmOnly` / `groupEnabled` figures (component A + component B).
- Gate A close.

| Component                        | Status                                  |
| -------------------------------- | --------------------------------------- |
| Component B (Signal/group state) | `<FILL IN P10a>` — BLOCKED this session |

## Composed figures (dmOnly / groupEnabled) — NOT AVAILABLE this session

These are **not measured this session** and must not be inferred from
component A alone. They compose as `component A + component B` once P10a
lands component B's real numbers.

| Figure                                               | Value                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Component A (socket-resident, measured)              | **0.227 MB/session** (95% CI [0.209, 0.244], R² 0.9994)                      |
| `dmOnly` (per-session MB, no group participation)    | `<FILL IN P10a>` (component A + component B[dm])                             |
| `groupEnabled` (per-session MB, group participation) | `<FILL IN P10a>` (component A + component B[group], see group formula below) |

## The ≥ 60 MB redesign fork — evaluated in writing (P10 Definition of Done)

ADR 0018's revisit clause: _"if measured RSS ≥ 60 MB/session the 10k path
changes shape and must change before twenty more phases are built on it."_

**Verdict: the fork is NOT triggered by component A, and remains formally
OPEN pending component B.**

- Component A measured **0.227 MB/session** — two orders of magnitude below
  the 60 MB threshold and ~80× below the _optimistic_ 18 MB planning bracket.
  Nothing in the socket/runtime layer (§1.1 rows 1,2,3,7,11,12: TLS/WS
  buffers, Noise handler, Baileys object graph, bounded retry/placeholder/call
  caches, WP per-instance state, V8 overhead) threatens the 10k path shape.
- The figure the fork actually tests is the **blended A + B**. Component B —
  the real Signal session/sender-key working set, which the design documents
  identify as _the dominant DM variable_ (5-15 MB pessimistic, and the group
  term scales as `tracked_devices × record_kb`) — is **not measured**. So the
  blended number cannot be stated, and the fork cannot be formally closed.
- **Practical read:** for the blended figure to reach 60 MB, component B
  would have to contribute ~59.8 MB/session — roughly 4× its own pessimistic
  bracket. That is not the expected outcome, but it is a measurement P10a owes,
  not an assumption this document is entitled to make.
- **Action:** P11 is **not** blocked by this fork (no ADR 0021-style reshape
  is raised). Component A's result makes a reshape unlikely; P10a re-evaluates
  the fork on the blended figure and closes it.

## What the worker cap is set from (and deliberately NOT set from)

`MAX_SESSIONS_PER_WORKER` is derived, never constant (ADR 0018 §3):

```
cap = clamp(floor((heapBudgetMb - processBaselineMb) / perSessionMb * safetyFactor), 10, 250)
perSessionMb = measuredSessionMb ?? plannedSessionMb      // measured wins when present
```

**This session leaves `measuredSessionMb` UNSET, deliberately.** Both
`WORKER_MEASURED_SESSION_MB_DM_ONLY` and `..._GROUP_ENABLED` are optional with
no default and are not set in any environment, so the cap resolves from the
planned bracket and is tagged **`provisional`**:

```
cap = clamp(floor((3072 - 200) / 35 * 0.85), 10, 250)
    = clamp(floor(2872 / 35 * 0.85), 10, 250)
    = clamp(floor(69.75), 10, 250)
    = 69          (provisional: true — measured absent, planned used)
```

**Why component A's 0.227 MB/session is NOT fed into the cap:** doing so would
give `clamp(floor(2872 / 0.227 * 0.85), 10, 250) = 250` (the ceiling) — a
worker admitting 250 sessions on the false premise that a session costs
0.227 MB. Component A measures only the socket/runtime rows; the dominant
Signal working set (component B) is unmeasured, and the real per-session cost
is `A + B`. Feeding a known-partial measurement into a production admission
decision would be the exact dishonesty this phase's banners exist to prevent
(and would risk OOM-killing a worker holding 250 live sessions). The measured
keys stay unset until P10a supplies B; the cap stays conservative and
`provisional` until then, and the production feedback loop (ADR 0018 §3)
corrects it from real fleet RSS once real sessions run.

## Group formula

```
group_state_mb = tracked_group_participant_devices × record_kb / 1024
```

Where `record_kb` is `<MEASURED IN P10a>` — never a flat 1 MB assumption.
`tracked_group_participant_devices` is the count of distinct participant
device identities the instance tracks Signal sender-key state for across all
groups it is a member of.

## Raw artifact path convention

Component A's run writes ONE artifact for the whole ramp (the slope is fitted
across ramp points, so splitting per point would break the method):
`docs/measurements/raw/<date>-componentA-<profile>.jsonl` — this session:
`docs/measurements/raw/2026-09-01-componentA-idle.jsonl`, with the derived fit
summarised in `docs/measurements/2026-09-01-componentA-fit.json`. Component B
(P10a) follows `docs/measurements/<date>-componentB-signal.json`.

Each artifact's header records: hardware fingerprint, Node/Baileys versions,
ramp points, planned-vs-truncated points, the banner, and the settle/soak
windows actually used. A doc row with no corresponding artifact path is not a
published figure — it stays marked `<FILL IN P10a>` until the artifact exists.

## Gate status

- **Gate A** (component A measured, this doc's component-A table filled):
  OPEN — closes at P10a once component A's numbers are cross-checked against
  the production feedback loop per ADR 0032.
- **Gate B** (P26): measured table lives in docs/capacity/fleet-capacity.md -
  banner DRIFT VERDICT PENDING — P26a; nothing here or there is quotable
  until P26a closes. Per ADR 0018 §8, until Gate C closes the only honest
  10,000-session statement is: the architecture has no known ceiling below
  10,000 and has been measured to N = 2,000 resident synthetic sockets
  (SOCKET-ONLY, component A).
