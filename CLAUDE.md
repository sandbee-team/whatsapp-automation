# WP - WhatsApp Messaging SaaS

Reliable WhatsApp messaging infrastructure: multi-tenant durable queues, priority scheduling, per-account pacing, health monitoring, safe pause/resume. Full product spec: `plan.html` (repo root). Architecture canon: `.claude/skills/wp-architecture/SKILL.md` - read it before any design/implementation work.

## Current status
- Direction: NO Meta Cloud API - v1 runs a Baileys QR/linked-device engine behind a transport boundary (ADR 0013). NO AI (0011 deferred). v1 includes broadcast, groups, inbox and wallet (ADR 0017); sold/metered unit is CONNECTED numbers; 10k sessions is a structural target, ~2,000 physical (ADR 0018). Stack: Node 24/TypeScript + React 19 (Vite) panels + Next.js site, PostgreSQL 17 + Redis, four projects app/ admin/ website/ + packages/ + db/ (ADR 0014), Safe Mode default ON (ADR 0015). ADRs 0002, 0013-0016 accepted (founder delegated); 0017-0020 in force.
- No application code yet. NOT a git repo and must never be linked to git/any VCS (ADR 0003, user constraint 2026-08-25; deny rules in settings.json). Workspace scaffolding completed 2026-08-25.
- Operational plan: `plan/` - one phase = one file = one session (`plan/v1/P00`..`P29`, status table in `plan/README.md`, method in `plan/SESSION-PROTOCOL.md`; ADR 0020). Reference/rationale: `MASTER-PLAN.md` + canon `.memory/research/2026-08-25-v1-architecture-blueprint.md` and its delta `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md`. Standing gates and cross-phase open items: `.memory/progress/master-plan.md`.

## Orchestrator contract (how to work here)
The user states WHAT they want. Claude (main session) decides who does it and how - never ask the user which agent, skill, or model to use, and never make the user manage the process.

1. Route work via the delegation table below. The main session orchestrates, decides, and reviews summaries; it does not grind through files itself.
2. Repo-wide searches, unknown-location lookups, and long test/log output -> delegate (explorer / test-runner); subagents return summaries, never file dumps. Files whose paths you already know: read the needed sections directly, whatever the count - a spawn costs more than a targeted read.
3. When the user describes a feature, build request, or review without typing a command, invoke the matching skill yourself via the Skill tool (`feature`, `build`, `audit`) - do not re-derive the steps. Feature flow = /feature (explore -> architect if invariants are touched -> USER APPROVAL -> planner) then /build (implement TDD -> harden -> full suite -> review -> record).
4. One dispatch = one WORK UNIT: a coherent module or file cluster with its tests (for phases, the phase file's Dispatch plan defines the units - typically 3-5 per phase), full task text pasted in. Independent units with disjoint file scopes run as up to 3 parallel dispatches; units sharing files or containing migrations never run in parallel. Red task stops the line (debugger next), never "continue past failure".
5. Nothing is "done" without verbatim green test output and, for non-trivial features, one reviewer verdict (once per feature, not per task).
6. If a request conflicts with `.claude/rules/core-invariants.md` or the safety-compliance skill, say so in one line and offer the compliant alternative.
7. Plugin workflow skills (superpowers brainstorming / writing-plans / executing-plans / subagent-driven-development) are replaced by /feature and /build in this repo; do not invoke them even if a plugin is enabled.

## Task-size triage (do this FIRST, before any dispatch)
Not everything is a phase. Pick the smallest tier that fits; escalate the moment scope grows (say so, re-tier):
- trivial - one obvious line/config/copy change: main session edits directly, runs the nearest test or guard, done. No dispatch, no reviewer.
- small - one module + its test, no invariant surface: ONE implementer (or ui-implementer) dispatch with the full task text; its green output is the evidence. No planner file, no reviewer unless a core-invariant path (queue/db/api/money) is touched.
- standard - multi-file or a new module, still not a plan/ phase: planner -> implementer(s) -> test-runner; reviewer once only if invariants or schema are touched.
- phase - anything in plan/v1: follow SESSION-PROTOCOL O1-O3, E1-E3, C1-C7 exactly.
Speed discipline: ceremony scales with risk, not habit - the fastest correct path wins.

## Delegation table
| Work | Agent | Model/effort |
|---|---|---|
| Find files/symbols/usages, map code | explorer | haiku |
| External docs, provider APIs, library research | researcher | sonnet/medium |
| Architecture, data model, tech decisions, ADRs | architect | opus/high (xhigh is unavailable for subagents here - see lessons/2026-08-25-xhigh-effort-fails-for-subagents.md) |
| Approved design -> ordered task list | planner | sonnet/high |
| Write code for one task (TDD) | implementer | sonnet/high |
| Panel/website UI work (app/ admin/ website/) with no queue/db/money surface | ui-implementer | sonnet/high |
| Edge-case + concurrency test suites | test-engineer | sonnet/high |
| Run full suite / lint / load script, report failures | test-runner | sonnet/low |
| Review once per feature before done/merge | reviewer | opus/high |
| Bugs, test failures, weird behavior | debugger | sonnet/high |
| Schema, migrations, indexes, hot queries | db-engineer | sonnet/high |
| READMEs, API docs | docs-writer | haiku |
| Save decisions/lessons/progress/sessions | memory-keeper | haiku |
| Claude Code workspace config (.claude/**, CLAUDE.md, hooks, rules) | main session, small edits | consult `.memory/research/2026-08-25-claude-code-config-reference.md` first; record in an ADR |

Token discipline: never use the built-in general-purpose or Explore subagents for repo work (they inherit the expensive main model) - use the table; never send opus-tier agents to do mechanical work; never read whole large files when Grep/targeted Read works; keep this main context lean - it is the most expensive context in the project. Test discipline: narrowest run first (one test -> file -> area); the full suite and the 12-step gate run once per phase via test-runner - see `.claude/skills/test-discipline/SKILL.md`.

## Memory protocol (STRICT)
ALL project memory lives in `./.memory/` ONLY. Never write project knowledge to global memory (`~/.claude/projects/**/memory`) or any location outside this repo.

- `.memory/MEMORY.md` - index, one line per file; append/update lines with Edit, never rewrite the file. Update it with every memory write (a hook reminds you).
- `decisions/NNNN-<slug>.md` - ADRs. Any decision that constrains future work gets one; never delete, supersede. Open ADRs (like 0002) are filled in place, not renumbered.
- `lessons/<date>-<slug>.md` - every bug that cost real effort or surprised us.
- `research/<date>-<slug>.md` - external findings with sources and confidence.
- `progress/<feature>.md` + `ROADMAP.md` - task lists with checkboxes; tick as work completes.
- `sessions/<date>-<slug>.md` - session summaries (/save).
- `templates/` - required formats for new files. `auto/` - Claude Code auto-memory (redirected here; machine-local, gitignored). Only personal preferences and corrections go there; any decision, lesson, or fact a fresh clone needs goes to decisions/lessons/research via memory-keeper.

Session start: the SessionStart hook injects the index, last session, and open decisions - do not re-read those files. Read topic files on demand only.

## Commands
`/feature <desc>` design flow · `/build <feature>` execute plan · `/audit [path]` review · `/research <q>` · `/progress` status · `/decide <d>` ADR · `/lesson <l>` · `/save` session summary

## Engineering invariants
Always-on: `.claude/rules/core-invariants.md`. Path-scoped rules for db/queue/api code load when those files are read; implementer and db-engineer read them before creating files in those areas. Safety boundaries (forbidden evasion mechanisms, honest claims): `.claude/skills/safety-compliance/SKILL.md`.
