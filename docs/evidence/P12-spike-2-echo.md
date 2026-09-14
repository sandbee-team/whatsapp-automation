# P12 Unit U7 — SPIKE-2: does WhatsApp echo our own `fromMe` sends back to a reconnecting linked device?

**STATUS: NOT YET RUN — awaiting a real linked number.** No row in the results table below may be filled in,
and no verdict/consequence section below may be written, except from the output of an actual `tsx
app/backend/test/manual/spike-2-echo.ts` run against a real second phone. A mock WebSocket, a synthetic event,
or an inferred result is not evidence for this document — see "Why nothing here can be simulated" below.

Created: 2026-09-01 (runner + skeleton, P12 Unit U7, step 10). Filled in only after the founder (or an
authorised operator) runs the trials described here.

## Why this spike exists (the stakes)

P12 built an **echo reconciler** whose primary evidence is WhatsApp replaying our own `fromMe` messages to a
reconnecting linked device after a crash between the `dispatched` write and the provider ack. Canon (the P12
scope delta) says that replay arrives through the history/notification path that
`shouldSyncHistoryMessage: () => false` **suppresses**, and that `emitOwnEvents: true` only re-emits events
from the _live_ socket, so it cannot cover the exact case the reconciler exists for — a socket that was dead
across the crash.

If the echo does not arrive, every ambiguous in-flight send goes to human review. At 0.1% unresolved and 6M
sends/day, that is ~6,000 decisions/day — "not an operable feature", in the scope delta's own words. This spike
is the one piece of evidence that decides whether the reconciler P12 built is real infrastructure or dead code.

## The pre-registered decision rule (BOTH forks, stated BEFORE any result exists)

Verbatim from `plan/v1/P12-queue-recovery-and-echo-spike.md` step 10:

> (a) Echo arrives in **≥8/10** trials within the window ⇒ keep `shouldSyncHistoryMessage:()=>false`, record the
> observed latency distribution, and set the window from data.
> (b) Echo does **not** arrive ⇒ either implement the **narrow** filter
> `shouldSyncHistoryMessage: (msg) => msg.key?.fromMe === true && msgTimestamp >= now − reconcileWindow`
> (still no history in the inbox; keep the P08 runtime config assertion green; re-run the spike to confirm the
> change works) **or** write the ADR that echo reconciliation is unavailable and re-size the human-review
> workload in decisions/day at the current measured send rate.
> **Anything between 3/10 and 8/10 is fork (b) with the numbers stated.**

This rule is fixed now, before any trial runs, so the eventual result cannot be reinterpreted or rationalised
after the fact. Whoever fills in the results section below must apply this rule exactly as written — a 7/10
result is fork (b), not "close enough" to fork (a).

## Why nothing here can be simulated

Verbatim from the phase file's own gotcha: _"SPIKE-2 cannot be answered synthetically. A mock WS endpoint
replays whatever we make it replay... Writing a synthetic run up as a SPIKE-2 result would be exactly the kind
of false evidence invariant 7 exists to prevent."_ The runner (`app/backend/test/manual/spike-2-echo.ts`)
constructs its socket via the real, unmodified `createBaileysSocket` (`app/backend/src/provider/baileys/
socket-factory.ts`) — the exact pinned P08 config, never a hand-rolled substitute — and connects to WhatsApp's
real servers. There is no fixture, no fake socket, and no default/placeholder result anywhere in this document.

## Ban-risk disclosure (verbatim in substance from ADR 0013 and the phase gotcha)

Repeated `kill -9` on a real number carries a real risk. It lands on the founder's own at-risk number with no
appeal path. Keep step 10 to ~10-20 spaced trials, never a loop; this is our own account being crash-tested,
which is legitimate — but it is not free, and it is not a reason to build any reconnection trick. No branch of
this spike or the reconciler it validates may implement number rotation, fake identities, proxy tricks, or any
mechanism to evade a provider restriction (core invariant 6; `.claude/skills/safety-compliance/SKILL.md`).

## Results table (≥10 trials, offline duration varied — fill in only from a real run)

Columns map directly to the 7 items the dispatch requires the runner to capture. "Content hash match" is
computed via the real `computeContentHash` (`app/backend/src/engine/queue/content-hash.ts`) — never
reimplemented in the runner or by hand here.

| Trial | Offline bucket | Echo arrived? | Event (upsert notify / upsert append / history.set) | Latency (ms, raw) | `wa_msg_id` present? | Enough to hash? | Content hash match? | JID server part | `addressingMode` / `remoteJidAlt` present? |
| ----- | -------------- | ------------- | --------------------------------------------------- | ----------------- | -------------------- | --------------- | ------------------- | --------------- | ------------------------------------------ |
| 1     | 30 s           |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 2     | 30 s           |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 3     | 30 s           |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 4     | 5 min          |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 5     | 5 min          |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 6     | 5 min          |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 7     | 5 min          |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 8     | 10 min         |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 9     | 10 min         |               |                                                     |                   |                      |                 |                     |                 |                                            |
| 10    | 10 min         |               |                                                     |                   |                      |                 |                     |                 |                                            |

(Add rows 11-20 here if the operator runs more than 10 trials — never fewer than 10.)

## Raw counts

_(Fill in only after all planned trials complete.)_ Echoes arrived in **\_/10** trials. Breakdown by bucket:
30s **_/_**, 5min **_/_**, 10min **_/_**. Breakdown by event: `messages.upsert` (notify) **\_**,
`messages.upsert` (append) **\_**, `messaging-history.set` **\_**, none **\_**.

## Verdict

_(Fill in only after the raw counts above are complete — apply the pre-registered rule exactly.)_

## Consequence chosen

_(Fill in only after the verdict — state which fork applied and, for fork (b), which of the two branches was
taken: the narrow `shouldSyncHistoryMessage` filter + re-run, or the ADR documenting reconciliation as
unavailable + the re-sized human-review workload at the current measured send rate.)_

## ADR 0035 §8 finding — JID / addressingMode

_(Fill in only after real trials. Report, verbatim shape only — never a real number or JID:)_

- Was `key.remoteJid`'s server part `s.whatsapp.net`, `c.us`, `lid`, or something else, across the observed
  echoes?
- Did any echo carry `key.addressingMode`, `key.remoteJidAlt`, or `key.participantAlt`?
- **If any echo arrived `@lid`-addressed:** per ADR 0035 §2, the pure `normalizeWaJidForHash` deliberately does
  NOT map `@lid` to a phone JID (that mapping needs Baileys' own I/O-bound LID↔PN store). An `@lid`-addressed
  echo therefore fails the content-hash match and the job falls safe to `blocked_needs_review`. If this is
  observed live, it is a finding that changes where JID resolution has to live (a P12a/P13 follow-up in
  `echo-capture.ts`'s impure layer, per ADR 0035's "Revisit when" section) — not a footnote.

## Operator runbook

All commands run from the repo root (`D:\kd\wp`), using `tsx` (already a workspace devDependency — no new
install needed).

### Stage 0 — link the second real phone

```
tsx app/backend/test/manual/spike-2-echo.ts pair
```

Expected output: a QR code prints directly to the terminal (never written to the log file — pairing payloads
are never logged). Scan it with the **second** real phone (never the founder's primary number — see the
ban-risk disclosure above). Wait for `PAIRED. Creds saved.` in the terminal, then `Ctrl+C`. Creds are now saved
under `app/backend/test/manual/.local/auth-state/` (local-only; this repo has no VCS at all per ADR 0003, and
`scripts/check-tree.ts` never inspects this deep, so nothing here needs a `.gitignore` entry).

**If this stage misbehaves:** a QR that never appears means the socket never reached the `connecting` state —
check network connectivity and that no other process is already using `.local/auth-state/`. A QR that expires
before scanning (45s, per `socket-factory.ts`'s pinned `qrTimeout`) just needs a re-run of the same command.

### Stage 1 — run a trial

```
tsx app/backend/test/manual/spike-2-echo.ts trial 1 30s
tsx app/backend/test/manual/spike-2-echo.ts trial 2 5m
tsx app/backend/test/manual/spike-2-echo.ts trial 3 10m
```

(repeat with distinct trial numbers, spaced apart, cycling the three bucket values, for at least 10 trials
total — see the ban-risk disclosure for why this must stay spaced and bounded, never a tight loop)

Expected output: the command prints numbered steps for what to do next (send a real message when it prints
`SOCKET OPEN`, note the message off-tool, hard-kill via `taskkill /F /PID <pid>` — **not** `Ctrl+C**, which is
not a hard kill and will not reproduce a crash-mid-send — wait the offline bucket with the process fully dead,
then re-run the exact same `trial <n> <bucket>` command to reconnect). On reconnect it observes for 15 minutes
and prints either "echo observed" or "NO echo observed" at the end, then exits.

**If this stage misbehaves:** if the process exits before the 15-minute window completes for a reason other
than the trial finishing (crash, machine sleep, network drop), the trial is **INCOMPLETE**, not a negative
result — do not enter it as a miss in the results table; discard it and run a fresh trial number instead.

### Stage 2 — resume observing without re-printing instructions (optional)

```
tsx app/backend/test/manual/spike-2-echo.ts observe 1
```

Only needed if a 15-minute observation window is interrupted for a benign reason (e.g. the terminal was closed
by mistake right after reconnect) and the operator wants to keep watching without restarting a whole trial's
offline-wait step. Uses the same auth state; does not re-print the kill/wait instructions.

### After all trials — build this document

1. Open `app/backend/test/manual/.local/spike-2-echo-<runId>.log` (one file per process run — there will be
   several, one per `pair`/`trial`/`observe` invocation). Each line is one JSON record with a `stage` field
   (`pair`, `trial-start`, `raw-event`, `echo-observed`, `trial-end`).
2. For each trial, find its `trial-start` and `trial-end` records (matching `trialNo`), and every
   `echo-observed` record between them, to fill one row of the results table above.
3. Apply the pre-registered decision rule exactly to the raw counts — do not round, do not average, do not
   discard an inconvenient trial.
4. Fill in the Verdict, Consequence chosen, and ADR 0035 §8 sections, then flip the STATUS line at the top of
   this document from "NOT YET RUN" to the completion date and trial count.
