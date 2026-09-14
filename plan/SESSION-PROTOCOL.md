# Session protocol — one phase = one session

This file is the reusable checklist for **every** phase session. Phase files reference it by step id
(`O1-O3`, `E1-E3`, `C1-C7`) and never restate it. It invents no new process: it maps onto the `/feature`,
`/build` and `/audit` commands and the agent roster already defined in `CLAUDE.md`.

Authority: `plan/README.md` is the phase-status authority. This file is the *how*.
Binding rules: `.claude/rules/core-invariants.md` (always) and `.claude/skills/safety-compliance/SKILL.md`.
There is **no git in this repo and never will be** (ADR 0003) — which is why C1 works off a written file list.

---

## Opening — O1..O3

**O1. Read the phase file top to bottom, then read only its "Read first" table.**
Do not explore the repo. The "Read first" table exists precisely to remove the exploration tax; if it is
missing something, add the row rather than starting a search. If more than two files must be found,
dispatch `explorer` (haiku) and take a summary back — never a file dump.

**O2. Verify you can actually start.**
- **Claim the phase FIRST**: set its row in `plan/README.md` to `in-progress (claimed <session-name> <date>)`.
  If the row is already claimed by another session, STOP — do not run any step; surface it to the user and
  let them pick the owning session. Two orchestrators closing one phase doubles reviews, races the shared
  dev DB, and overflows shared files (it happened on P03 — see lesson 2026-08-27-two-orchestrators-one-phase-collision).
- Every phase in "Depends on" is `done` in `plan/README.md`.
- Every line under "Prerequisites (facts, not phases)" holds — compose is up, migrations applied,
  the named ADRs are accepted.
- The previous session's C5 evidence is green in its session log, and the quick gate -
  `pnpm run typecheck && pnpm run guards:meta` - passes on the tree as you found it. Run the full
  `scripts/ci.ps1` at open ONLY if that evidence is missing. **A red quick gate at O2 is a bug from the
  previous session, not your problem to absorb**: fix it first (dispatch `debugger`), record it, then start.

**O3. Does this phase need a design decision first?**
If the phase touches message lifecycle, retry behaviour, pacing, health state, tenant isolation, money,
or the schema **and** no accepted ADR already covers it → run `/feature <phase goal>` first
(explore → `architect` → **founder approval** → `planner`). Otherwise go straight to execution.
Phases P18-P24 (wallet, contacts, inbox, broadcast, groups) are known to need this; their internals were
sized, not designed.

---

## Execution — E1..E3   (this is `/build <phase-id>`)

**E1. One work unit = one dispatch.**
The phase file's **Dispatch plan** groups the ordered steps into 3-5 work units; one unit = one dispatch,
with every step's text pasted verbatim into it (each step keeps its own `- [ ]` box, ticked individually).
A unit is one coherent module or file cluster WITH its tests - up to ~400 changed lines when the surface is
plain, smaller when it touches claim/pacing/wallet/crypto invariants. If a phase file predates dispatch
plans, group the steps yourself by file cluster before the first dispatch and write the plan into the file.
Routing: schema/migration/index units go to `db-engineer`; pure panel/website UI units to `ui-implementer`;
everything else to `implementer` (sonnet/high). Units with disjoint file scopes run in PARALLEL (up to
three); units containing migrations never run in parallel with anything. Prepare ALL unit dispatch texts in
one pass before firing the first one - do not re-derive context between dispatches.
When a step requires verbatim content from a research or canon file (SQL, DDL column lists, enum labels),
the main session extracts and pastes that content into the dispatch text; the subagent never opens
`.memory/research/**` itself.
TDD inside the unit: each test named in "Tests that prove it" is written red-first with its step, never
after the fact. Tick each step's box when the dispatch reports it green, and append every touched path to
"Files created or changed this session" as you go - that list is the diff and cannot be reconstructed later.
**Time budget: a unit dispatch past ~20 minutes or a third debugger loop on one unit means the unit is
mis-sized - stop, split the remainder into a new unit, record the split, continue. Target: E-phase done in
20-30 minutes, whole session shipped in 30-45.**

> **File ownership between parallel dispatches (learned in P10 - cost a wasted gate round).**
> Disjoint file scopes are necessary but NOT sufficient. In P10 one agent wrote test fixtures with CONSTANT
> RSS values (correct at the time) while another made a flat series throw (also correct) - each unit green in
> isolation, the combination red. Before firing parallel units:
> 1. Write each unit's file scope explicitly in the dispatch, and state which files it may NOT touch.
> 2. **Name the shared CONTRACTS the units both depend on** (an error class's throw conditions, a return
>    shape, a metric name, a units convention). If unit A changes a contract unit B's fixtures rely on, they
>    are not disjoint - sequence them.
> 3. A unit that changes when an existing function THROWS, or renames a field/metric, is never parallel-safe
>    with a unit writing tests against it.
> 4. After a parallel wave lands, run the union of the touched areas' tests once before moving on - do not
>    trust per-unit green as proof the wave composes.

**E2. The first red test stops the line.**
Dispatch `debugger` (sonnet/high). Never "continue past the failure", never comment a test out, never mark
it `.skip` or `.only`. If the fix changes a decision, that is a `/decide` at C6, not a silent edit.

**E3. After the happy path is green.**
`test-engineer` (sonnet/high) for edge cases on this phase's surface (it runs only the tests it writes),
then `test-runner` (sonnet/low) for ONE full unit-suite run (`pnpm run test:unit`) - the full 12-step gate
waits for C5. Nothing proceeds to close while the unit suite is red.

---

## Close — C1..C7   (mandatory; nothing is "done" without all seven)

**C1. Deep code review of this session's work.**
Dispatch `reviewer` (opus/high) **once** - IN PARALLEL with C2 - with the "Files created or changed this
session" list pasted into the dispatch. That list is the diff, because there is no git.

> **C1/C2 parallel-safety asymmetry (learned in P10 - cost a wasted gate round).**
> `reviewer` is genuinely READ-ONLY, so it is parallel-safe with anything.
> `test-engineer` (C2) is **NOT read-only** - this protocol *requires* it to turn findings into tests, so it
> WRITES test files. Therefore:
> - C1 ‖ C2 together: fine.
> - **C5 (the full gate) must NOT start until C2 has reported.** The gate's first two steps are
>   `format` and `lint`; they fail on any half-written file, and the resulting red is indistinguishable at a
>   glance from a real regression.
> - Use the C1/C2 wait to write the C3/C4 answers, read canon, or draft the session log - never to run the
>   gate.
> - When C2 and a fix-round dispatch touch the SAME test file, tell the later one explicitly what the
>   earlier one added, so it extends rather than clobbers (SendMessage works for an agent still running). Equivalent to `/audit` scoped to those paths.
CRITICAL findings go back to `implementer`; then re-review **only the fixes**, not the whole phase.
Record the verdict verbatim: `APPROVED` or `APPROVED-with-notes` (notes filed in the session log).

**C2. All-cases / edge-case review.**
Dispatch `test-engineer` (in parallel with C1) over the phase's NEW invariant surface - the claims,
uniqueness, tenant and money paths this session created, not a broad re-sweep - looking specifically for: concurrency and double-claim,
crash in the middle of a multi-statement transaction, replay of an already-applied write, empty and huge
inputs, two-tenant interference, clock boundaries (local midnight, DST, timezone change), retry storms,
and "what happens if this dependency is slow rather than down". **Anything it finds becomes a test in this
session, not a TODO.**

**C3. Invariant check — written, one line per invariant.**
Against `.claude/rules/core-invariants.md` (1-7) and the safety-compliance skill, answer in writing:
1. durable-first — did anything gain a path that sends without a durable job row?
2. fail-safe — does every new unclear/failure state *stop* rather than retry, and does it pause the right
   blast radius (one job, one group, one instance, one client) rather than the whole number?
3. idempotency at storage — is every new uniqueness claim a real constraint on a **non-partitioned** table?
4. tenant isolation — does every new table lead with `client_id NOT NULL`, is it registered in isolation
   suite A, and does any new background path get a two-tenant test in suite B?
5. pause preserves work — can any new state stop claiming without failing, deleting or stranding a job?
   (Silently unclaimable counts as stranded.)
6. no evasion — no rotation, no proxy, no fingerprint variation, no auto-resume out of a restriction, no
   tenant-settable flag that loosens a limit; and no banned claim in any new copy string.
7. tests are evidence — is the green output in the session log verbatim?

**C4. Structure and convention check ("is everything properly managed?").**
- `scripts/ci` guards all green **and each reports a non-zero matched-file count** (a guard matching zero
  files is not a guard) - verified from the single full-gate run at C5, not a separate run.
- No file outside the ADR 0014 tree; no deep module import; no raw `db.select()` outside `platform/db`;
  no `OFFSET` pagination; no float used for money.
- Every new tenant table is in isolation suite A; every new route has an auth policy and a scope;
  every new metric obeys the label allow-list; every new copy string is in the `check-copy` scan.
- Nothing half-finished and undocumented: if a step was descoped, it is written down in the phase file
  and carried into the next phase's file, not left in someone's head.

**C5. Evidence.**
Paste the **verbatim tail** of the green `scripts/ci` run - the phase's ONE full-gate run - into the
session log. A summary of test output is
not evidence and a phase is not done without this.

**C6. Memory updates — dispatch `memory-keeper` (haiku), naming the exact files:**
- `plan/README.md` — this phase's row → `done` (**the phase-status authority**).
- `plan/v1/P<NN>-<slug>.md` — every step box ticked, "Files created or changed" complete, the Definition of
  Done boxes ticked.
- `.memory/sessions/<yyyy-mm-dd>-P<NN>-<slug>.md` — what was built, the evidence tail, the reviewer verdict,
  the C3 answers, and **what is NOT done**.
- `.memory/progress/master-plan.md` — only if a cross-cutting gate or open item opened or closed.
- `.memory/lessons/<yyyy-mm-dd>-<slug>.md` — if anything surprised us or cost real debugging time.
- `.memory/decisions/NNNN-<slug>.md` — if a decision was made or changed mid-phase (via `/decide`).
- `.memory/MEMORY.md` — append **one index line per new memory file**, with Edit, never a rewrite.

**C7. Next-session prompt.**
After confirming the next phase's dependencies are now satisfied, paste that phase's
"Next-session prompt" block into the chat as the **last message of the session**. If the phase split
mid-session, write the prompt for `P<NN>a` instead and add that row to `plan/README.md`.
**Do not start the next phase in the same session.**

---

## Mapping to what already exists (so nothing is duplicated)

| Protocol step | Existing mechanism |
|---|---|
| O1 | the phase file's "Read first" table; `explorer` (haiku) for anything else |
| O3 | `/feature` — explore → `architect` → founder approval → `planner` |
| E1-E3 | `/build`, plus the delegation table in `CLAUDE.md` |
| C1 | `/audit` + `reviewer`, once per phase (CLAUDE.md rule 5) |
| C2 | `test-engineer` |
| C3-C4 | `.claude/rules/core-invariants.md`, safety-compliance skill, `scripts/ci` guards |
| C5 | core invariant 7 — verbatim green output |
| C6 | `memory-keeper` + the memory protocol in `CLAUDE.md`; `/save`, `/lesson`, `/decide` |
| C7 | new — and it is one paste |

## If a session dies mid-phase

The durable state is the phase file: its ticked step boxes plus the "Files created or changed" list.
The next session re-reads the phase file and resumes at the **first unticked step**, inferring nothing from
memory. Every step is written to be re-runnable — migrations are numbered and additive, guards are
idempotent, and re-running a completed step is a no-op, not an error. A phase re-run on a finished tree
ends green.
