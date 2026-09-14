# P12 — queue-recovery-and-echo-spike

**Goal (one line):** a crash between dispatch and result can no longer lose a job or silently duplicate a message — the 15 s reaper repairs what it can prove, the echo reconciler resolves what WhatsApp replays, everything else lands in `blocked_needs_review` behind a two-choice human decision — and SPIKE-2 answers **in writing** whether the `fromMe` echo actually arrives with `shouldSyncHistoryMessage` disabled.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P11 (must be `done`)
**Blocks:** P13, P15, P18, P21, P23

**Size warning:** this phase lands exactly on the 10-step ceiling and step 10 needs a **real** WhatsApp number.
Split line: if step 8 is not green by mid-session, or no real number is available today, stop after step 8
and move steps 9-10 into `plan/v1/P12a-echo-spike-and-chaos.md` (add the row to `plan/README.md`).
P13 may then start on P12; **P23 (broadcast) stays blocked on P12a** — that is the whole point of the gate.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; all migrations applied; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL **O2**).
- P03 landed: `message_jobs` (monthly partitions), `send_attempts`, `delivery_events` + `delivery_event_ids`, `message_wa_ids` in its final both-directions shape, `db/queries/claim-jobs.sql`, `scripts/check-single-claim.ts`.
- P11 landed: the dispatch/result path — `send_attempts` states `prepared → dispatched → acked|failed`, `attempts` incremented exactly once with the attempt INSERT, the result write whose **zero-row outcome is a hard error** that leaves the outcome on the attempt row, `delivery_events`, `wp_claim_lost_total`, and the event-driven wake loop.
- P08/P09 landed: the pinned Baileys socket factory with its runtime config assertion against `DEFAULT_CONNECTION_CONFIG`, and the drain path that turns a still-in-flight send into `needs_reconcile`.
- `TIMING` is exported from `@wp/domain` with its ordering unit test (`sendTimeoutMs 45_000 < claimExpiryMs 90_000 − reaperGraceMs 30_000`).
- ADRs **0013, 0015, 0017, 0018, 0020 accepted**. The wallet does **not** exist yet (P18) — money is a named no-op seam in this phase, not a stub of a charge.
- **Step 10 only:** one real linked number the founder accepts as at-risk (ADR 0013's disclosure), plus a second phone to receive. A mock-WS socket cannot answer SPIKE-2 and a synthetic result must never be written up as one.

## What you are building (3-6 bullets)
- The **reaper** (15 s, grace 30 s, `LIMIT 500`): the blueprint's statement verbatim, cross-tenant and registered as such, repairing `acked` to `sent`, requeuing `prepared`/`failed`/no-attempt, and sending `dispatched` to `needs_reconcile`.
- **`fromMe` echo capture**: hash + observed-at evidence written to `message_wa_ids` (ids and hashes only, never a body) — the narrow slice of the inbound handler that the reconciler needs, with P21 owning the receipt and opt-out paths.
- The **echo reconciler**: a 10-minute evidence window, ±5 min hash match, **1:1 assignment**, and the conservative rule that two in-flight attempts sharing a hash resolve **neither**.
- **`needs_reconcile` → `blocked_needs_review`**: the terminal-until-a-human state, its two-choice API and panel entry with the exact copy, an audit row carrying `actor_user_id`, and a CI guard proving no other code path can move a job out of it.
- The **money seam** (`RepairedSendSink`, no-op here): every repaired-to-`sent` job emits exactly one work item so P18 can charge it once — the blueprint's bulk reaper would otherwise deliver a send that is never billed.
- **Evidence**: a 100× `kill -9` chaos harness (zero lost, zero silent duplicates) and `docs/evidence/P12-spike-2-echo.md` with the SPIKE-2 verdict and its consequence.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Durable queue…* → **The reaper (every 15s)**; **needs_reconcile → blocked_needs_review**; *Dispatch and result*; *Failure behaviour matrix* rows "Socket dies mid-send" / "Slow media send"; *Testing strategy* tests **15, 16, 17**; *Observability* (the three honesty metrics) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *Techniques…* → **the SPIKE-2 gate paragraph**; *Conversations and messages* → the `message_wa_ids` **direction** decision and "`inbound_message_ids` is struck"; *Inbox* → "Our own outbound messages appear in the thread"; *Reversals* + "**Repaired sends are charged**" |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §4 (no singleton loop O(active) faster than 5 min), §8 (gates) |
| ADR | `.memory/decisions/0013-v1-whatsapp-engine-baileys-qr.md` | pinned config; the ban-risk disclosure that governs step 10 |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | the repaired-send charge, so the seam has the right shape |
| Skill | `.claude/skills/queue-engineering/SKILL.md` | **Idempotency**; Job claiming; Pause/resume semantics |
| Invariants | `.claude/rules/core-invariants.md` | all (2, 3, 5 bite hardest) |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms; honest claims |
| Path rules | `.claude/rules/queue-*.md`, `.claude/rules/db-*.md`, `.claude/rules/api-*.md` | all |

**O3:** no `/feature` needed — the reaper and the reconciler are specified verbatim in canon. But SPIKE-2 fork (b)
**is** a decision: if the echo does not arrive, write an ADR at C6 (next free number, `0021` if unused).

## Session-open corrections (written 2026-09-01 at O1/O2, SESSION-PROTOCOL E1)

Seven parallel read-only scouts mapped the real tree against this file's assumptions. **Where this block and
the steps below disagree, THIS BLOCK WINS** — each item was verified against the shipped code, and three were
verified by execution, not by reading. Do not "fix" a step back to its original wording.

| # | This file assumed | The tree actually is | Consequence |
|---|---|---|---|
| C1 | `needs_user_action='unresolved_send'` (a text/enum label) | `message_jobs.needs_user_action` is **`boolean NOT NULL DEFAULT false`** (`0007_message_jobs.sql:68`) | The *reason* goes in the new `unresolved_reason text` column; `needs_user_action` is set `true`. No enum is added and no column type is changed. |
| C2 | 1:1 echo assignment "enforced by `message_wa_ids.message_id` under its unique key" | `message_wa_ids` PK is `(client_id, instance_id, direction, wa_msg_id)`. **There is no unique index on `message_id` at all** | Migration 0026 must ADD a partial unique index on `(client_id, instance_id, message_id) WHERE message_id IS NOT NULL`. Without it "1:1" is enforced by nothing. |
| C3 | `check-single-claim` "will probably flag the reaper"; fix the guard to be SET-side only | The guard is **already** SET-side-only — both patterns use `(?:(?!\bWHERE\b)[^;])*?`, which cannot cross a `WHERE`. **Verified by executing both regexes** against the reaper SQL: both `false`. | **No guard change is needed and none may be made.** The REAL hazard is different: `PARAMETERIZED_STATUS_PATTERN` flags any `SET status = $n` on `message_jobs`. Every P12 statement therefore writes status as a **literal** (`SET status = 'sent'`), never a bind. |
| C4 | `scripts/ci.ps1` + `ci.sh` — changed: add the guard step | Both are **preflight-only wrappers**. `scripts/guards/meta.test.ts:66-90` (`ci_ps1_and_ci_sh_run_the_same_ordered_steps`) asserts, for every step, that neither file contains its command | Adding a step to either file **turns that test red**. The guard chains into `package.json`'s existing `check:tenant-scope` script; `CI_STEPS` in `scripts/ci-steps.ts` is the only step list. |
| C5 | `db/test/isolation-suite-b.test.ts` — changed | That file **and the whole `db/test/` directory do not exist** (it is `db/tests/`). There is no central background-path registry; suite B is a per-path file convention with one shipped instance: `app/backend/src/modules/realtime/__tests__/suite-b-sse.test.ts` | P12 CREATES `app/backend/src/modules/queue/__tests__/suite-b-reaper-reconciler.integration.test.ts` following that shipped convention. |
| C6 | `scripts/cross-tenant-queries.ts` | Real path is **`scripts/registries/cross-tenant-queries.ts`** | Register the reaper + reconciler `-- name:` labels there. All three fields (`role`/`reason`/`projectedColumns`) are validated non-empty; a partial entry is itself a violation. |
| C7 | Advisory single-flight lock | Canon row 18 prefers a leader-lease row because **session** advisory locks are unreliable under PgBouncer transaction mode (ADR 0006/0009 — PgBouncer transaction pooling is real) | Use **`pg_try_advisory_xact_lock`** — transaction-scoped, released at COMMIT inside the same pooled transaction, so canon's objection does not apply. **Verified live**: `SET ROLE wp_scheduler; SELECT pg_try_advisory_xact_lock(...)` returned `t`; no grant needed (Postgres grants these to PUBLIC). Never `pg_advisory_lock` (session-scoped). |
| C8 | `ctx.actor` with `api_key`/`system` variants ⇒ 403 | **There is no actor abstraction in the repo.** `AuthenticatedContext` (`platform/http/route-policy.ts:47`) is `{userId, sessionId, clientId, role, epoch}` — no kind, no discriminant. `authenticateRequest` accepts only a verified user JWT, so `api_key`/`system` have **no code path to an HTTP request** | See decision 1 below. The 403 requirement is enforced and tested at the **service** layer, where a non-user actor can actually be constructed. |
| C9 | A replayed retry is idempotent through the existing mechanism | `message_job_refs` is scoped to job **creation** (`message_job_id NOT NULL`, `public_id` PK, no UPDATE/DELETE grant). It cannot key a retry/discard action | Migration 0026 adds `unresolved_action_keys` — its own non-partitioned authority, PK `(client_id, idempotency_key)`. |
| C10 | Integration tests at `app/backend/test/integration/queue/*.int.test.ts` | `app/backend/vitest.config.ts` claims **only** `src/**/*.integration.test.ts`, and there is no `app/backend/test/` integration tree. A file named `.int.test.ts` is claimed by **neither** vitest project and would silently never run | Every P12 integration test is `app/backend/src/modules/queue/<name>.integration.test.ts` (or under `engine/queue/`). A `*.int.test.ts` name is forbidden. |
| C13 | Metric `wp_reaper_repairs_total{outcome}` (step 3's wording) | **`outcome` is not an allowed metric label.** `@wp/server-kit`'s `ALLOWED_LABELS` (`packages/server-kit/src/obs/metric-policy.ts:29-47`) is a CLOSED, CI-guarded allow-list — `assertMetricRegistrationAllowed` **throws at registration time** for any unlisted label, and adding a label name requires its own ADR. | Shipped as **`wp_reaper_repairs_total{result}`** — `result` is already on the allow-list and already carries this exact small-closed-union shape on the sibling `wp_send_attempts_total{result}`. Values are the closed union `requeued_no_attempt`, `requeued_prepared`, `requeued_failed`, `needs_reconcile`, `repaired_sent`, asserted by a test. The alternative (widen `ALLOWED_LABELS` for one metric) was rejected: it needs an ADR and buys nothing over an existing, semantically identical label. |
| C12 | Migration 0026's column grants make the reaper's cross-tenant sweep work | **They do not — and this blocked U2.** Column grants control WHICH COLUMNS a role may touch once RLS has already admitted a row; the **policy match** controls WHICH ROWS. `message_jobs`/`send_attempts`/`delivery_events`/`message_wa_ids` each carry exactly ONE policy (`tenant_isolation`, PERMISSIVE, `TO public`, keyed on the `app.client_id` GUC) under FORCE RLS, and `wp_scheduler` is **not** BYPASSRLS. **Verified live twice**: `SET ROLE wp_scheduler; SELECT count(*) FROM message_jobs` returns **0** with no GUC set. So the reaper would have swept zero rows in production, silently. | Migration **0027** adds two `SECURITY DEFINER` functions owned by `wp_admin_app` (`wp_reap_expired_leases`, `wp_reconcile_scan_unresolved`), hardened exactly as the FOUR existing precedents (`wp_lease_scan_unowned`, `wp_session_bootstrap_scan`, `wp_realtime_authz_snapshot`, `wp_client_id_for_user`) — pinned `search_path`, `REVOKE ALL FROM PUBLIC`, `EXECUTE` to `wp_scheduler` only. ADR 0029 §2 already established the pattern, and 0018's own comment names this exact "zero rows with no `app.client_id` GUC" problem as the reason the owner must be `wp_admin_app`. **Rejected**: a permissive `USING (true)` policy `TO wp_scheduler` — for a sweep with no owner GUC to key on that is a spelled-out BYPASSRLS for the role, widening the blast radius far past the two statements that need it. |
| C11 | wp_scheduler can already read/write what the reaper needs | wp_scheduler has **no SELECT on `lease_expires_at`/`leased_at`/`lease_owner`/`owner_fence`**, no UPDATE on `message_jobs.needs_user_action`, and **no UPDATE grant on `message_wa_ids` for any role** | Migration 0026 carries the additive column grants. `0012:50-55` explicitly reserved this for "the reaper's own migration". |

### The reaper's real contract (wider than the "What you are building" bullets)

Four `(send_attempts.state, message_jobs.status)` crash combinations are already fixtured by P11, and the
reaper must handle all four. The `acked`/`failed` pair is the one this file's bullets omitted:

| # | Attempt state | Job status | Fixtured at | Required repair |
|---|---|---|---|---|
| 1 | *no attempt row* | `processing` | `modules/queue/claim.ordering.integration.test.ts:221` | → `queued`, **`attempts` untouched** (it was never incremented) |
| 2 | `prepared` | `processing` | (this file's assumed baseline) | → `queued`, `attempts` − 1 |
| 3 | `dispatched` | `processing` | `engine/queue/dispatch.integration.test.ts:157` | → `needs_reconcile`. **Never `queued`.** |
| 4 | `acked` / `failed` | `processing` | `engine/queue/result-crash-window.integration.test.ts:102,138` | The outcome is **AUTHORITATIVE on the attempt row**: reconcile the job FROM it (`acked` → `sent`; `failed` → the retry/terminal decision the result path would have made). **NEVER requeue** — that double-sends to a real person. |

`result.ts:52-62` states this in the production code itself, names P12, and names the "prepared + processing"
assumption as explicitly *not* the shape it leaves behind.

### Decisions taken at session open (not silent edits)

1. **Actor enforcement (C8).** `unresolved.service.ts` takes an explicit
   `actor: {kind: 'user' | 'api_key' | 'system'; userId?: string}` and throws `FORBIDDEN` for any kind but
   `'user'`, and for `'user'` with no `userId`. The route constructs `{kind:'user', userId: req.auth.userId}`.
   The mandatory test `retry_and_discard_require_a_user_actor_and_write_an_audit_row` is therefore a
   **service-level** test (all three kinds constructible) plus a route-level test that the route always
   supplies a user actor. This is the honest shape: inventing an HTTP path for an api-key actor purely so it
   could be handed a 403 would be building the hole in order to prove we plugged it. Carried forward so the
   phase that actually introduces API-key auth wires it into this same guard.
2. **`ambiguous_send_policy` is NOT built** (this file's own gotcha) — no column, no setting, no enum. Descope
   recorded here and carried into P13's file.
3. **Migration number is `0026`** (`schema_migrations` max = 25, verified live). One migration, additive only.
4. **`getSendSocket` (carried from P11 item 1) is U0, a dedicated unit.** The carried note feared that widening
   `RunnerHandle.getSock` past `{logout()}` would collide with the `logout-call-sites` guard and ADR 0013
   constraint 6. **Both fears are unfounded, verified:** that guard scans for `.logout(` **call sites**, not
   type shapes, so a type change adds nothing to it; ADR 0013 constraint 6 is about restriction handling and
   human resume, and constraint 9's banned-token list (`rotateNumber`/`setProxy`/`forceResume`/
   `setDeviceFingerprint`/…) does not contain `sendMessage`. Further, `getSock` is **not widened at all**:
   `provider/baileys/adapter.ts:110` already defines `BaileysSendSocketPort` as its own narrow port, so U0 adds
   a **separate** `getSendSocket?(): BaileysSendSocketPort | undefined` beside it, gated on the connection
   being open.
5. **Step 10 runs this session.** The founder confirmed at session open (2026-09-01) that a real linked number
   and a second receiving phone will be supplied, superseding the "QR/live testing deferred" note for this
   step only. No split to P12a; the phase's split line stays unexercised.

### Founder decisions taken DURING the session (asked, not assumed)

6. **Step 10 (SPIKE-2) runs this session** — the founder confirmed a real linked number and a second receiving
   phone will be supplied, superseding the 2026-09-01 "QR/live testing deferred" note for this step only. No
   split to P12a; the phase's split line stays unexercised.
7. **The reaper's cross-tenant write gets a new dedicated `wp_reaper` role** (`NOLOGIN BYPASSRLS`), which owns
   the writing `SECURITY DEFINER` function and nothing else. **Why this was a founder question and not a
   mechanical call:** `SECURITY DEFINER` runs *table-ACL* checks as the owner, not only RLS — so the owner
   needs BYPASSRLS **and** a write grant on `message_jobs`, and **no existing role has both**. Verified live:
   `wp_admin_app` is BYPASSRLS but `UPDATE message_jobs` ⇒ `ERROR: permission denied` (it must never hold a
   send-path write grant — `SEND_PATH_TABLES`, enforced by
   `wp_admin_app_has_no_write_grant_on_any_existing_send_path_table`); `wp_migrator` owns and writes the table
   but is not BYPASSRLS ⇒ `SELECT count(*) FROM message_jobs` = **0** with no GUC. All four pre-existing
   definer precedents are **read-only**, so this case had never arisen. Two cheaper routes were ruled out by
   execution, not opinion: `SET row_security = off` on a `wp_migrator`-owned definer fails under FORCE RLS
   (`ERROR: query would be affected by row-level security policy`), and a permissive `USING (true)` policy
   `TO wp_scheduler` is a spelled-out BYPASSRLS for the role with a far wider blast radius. The approved shape
   was verified end to end with a throwaway probe role (5 rows visible cross-tenant, UPDATE succeeded; probe
   role and function dropped, DB confirmed clean). **Rejected alternatives, recorded:** grant `wp_admin_app` a
   narrow UPDATE (punches a hole in the staff-never-writes-the-send-path invariant, on the role the admin
   panel uses); a per-tenant reaper loop inside `withTenant` (no new role, but diverges from canon's one
   bounded `LIMIT 500` statement and costs N queries per 15 s tick, which ADR 0018 §4 warns against).
8. **`check-single-claim` IS fixed this phase — but for the opposite reason the phase file predicted.** C3
   stands (the guard never flagged the reaper's `WHERE ... status='processing'`). The real defect, found when
   migration 0027 landed: the guard's `UPDATE` matches the **`FOR UPDATE OF j SKIP LOCKED` row-lock
   clause**, and the `status = 'processing'` it then lands on is inside a `--` comment
   (`sanitizeForBoundedScan` deliberately strips only `;` from comments, leaving prose scannable). So a
   general false positive on the standard claim/sweep idiom, not a reaper-specific one. Fixed in the guard with
   regression fixtures both ways, exactly as the phase file pre-authorised; the migration was NOT reworded and
   `db/migrations/**` was NOT excluded from the guard.

## Dispatch plan (written 2026-09-01 at session open, SESSION-PROTOCOL E1)

One unit = one dispatch, full step text pasted in. U1 carries the migration and runs alone.

| Unit | Steps | File scope | Agent | Parallel with |
|---|---|---|---|---|
| **U0** live send socket (carried P11 item 1) | — | `engine/session/{registry,runner,runner-types}.ts`, `engine/queue/send-loop-worker-wiring.ts`, `roles/session-worker.ts` + tests | implementer | U1 (disjoint) |
| **U1** MIGRATION + schema + timing | 2 | `db/migrations/0026_reconcile_support.sql`, `db/schema/{message-jobs,message-wa-ids,unresolved-action-keys}.ts`, `db/src/isolation/tenant-tables.ts`, `packages/domain/src/timing.ts` + tests | db-engineer | U0 only |
| **U2** reaper + money seam | 3, 4 | `db/queries/reap-expired-leases.sql`, `modules/queue/{reaper,repaired-send-sink}.ts`, `scripts/registries/cross-tenant-queries.ts` + tests | implementer | none (after U1) |
| **U3** echo capture + reconciler | 5, 6 | `modules/queue/{echo-capture,reconciler}.ts`, `db/queries/reconcile-unresolved.sql`, `roles/session-worker.ts` handler wiring + tests | implementer | none (after U1) |
| **U4** cron role + advisory single-flight | 7 | `roles/cron.ts`, `main.ts`, `platform/config.ts`, `infra/compose/docker-compose.dev.yml` + tests | implementer | U5 |
| **U5** human two-choice path + guard + copy | 8 | `modules/queue/unresolved.{service,routes}.ts`, `packages/contracts/src/messages.ts`, `packages/domain/src/copy/unresolved.ts`, `scripts/check-no-auto-requeue.ts`, `scripts/guards/registry.ts`, `scripts/ci-steps.ts`/`package.json` + tests | implementer | U4 |
| **U6** panel + chaos harness + suite B | 9 | `app/frontend/src/features/unresolved/**`, `modules/queue/__tests__/crash-injector.ts`, `crash-recovery.integration.test.ts`, `suite-b-reaper-reconciler.integration.test.ts` | ui-implementer (panel) ‖ implementer (harness) | panel ‖ harness |
| **U7** SPIKE-2 (manual, real number) | 10 | `app/backend/test/manual/spike-2-echo.ts`, `docs/evidence/P12-spike-2-echo.md` | main session + founder | none |

**Step 1 is not a unit** — per `plan/README.md`, each test named in "Tests that prove it" is written red-first
inside the dispatch of the step it proves.

## Ordered minimum steps
Migration numbers: use the next free 4-digit number after P11's last one and write the real name into the files list.

- [ ] 1. Write the failing tests first (all red, none skipped, none `.only`) → `app/backend/src/modules/queue/reaper.test.ts`, `app/backend/src/modules/queue/reconciler.test.ts`, `app/backend/test/integration/queue/reaper.int.test.ts`, `app/backend/test/integration/queue/reconciler.int.test.ts`, `app/backend/test/integration/queue/unresolved-api.int.test.ts`, `app/backend/test/integration/queue/crash-recovery.int.test.ts`, `scripts/__tests__/check-no-auto-requeue.test.ts`.
- [x] 2. Migration — reconcile support (**DONE** U1; migration is `0026_reconcile_support.sql`, applied. Deviations from this step text: `needs_user_action` left as the shipped `boolean` (C1) so the reason lives in `unresolved_reason`; the `(client_id, instance_id, terminal_at)` partial index already existed as `message_jobs_review_idx` from 0007 and was NOT recreated; ADDED beyond the step text — the partial unique index `message_wa_ids_message_id_uq` that makes 1:1 real (C2), the `unresolved_action_keys` table as the retry/discard replay authority (C9), and the additive `wp_scheduler` column grants 0012 had reserved for "the reaper's own migration" (C11)), additive only → `db/migrations/00NN_reconcile_support.sql`, `db/schema/message-wa-ids.ts` (changed), `db/schema/message-jobs.ts` (changed). Adds: `message_wa_ids.content_hash bytea`, `.observed_at timestamptz` (echo evidence lives on the **single** id authority — a separate evidence table would be a second authority for one question, exactly what the delta struck); `message_jobs.unresolved_reason text`, `.unresolved_at timestamptz` and reuse of the existing `needs_user_action`; partial index `(client_id, instance_id, terminal_at) WHERE status IN ('needs_reconcile','blocked_needs_review')` if P03 did not already create it; evidence lookup index `(client_id, instance_id, content_hash, observed_at) WHERE message_id IS NULL`. Header comment: **P21 owns the inbound body path and must `ALTER`, never `CREATE`.**
- [x] 3. The reaper statement + module (**DONE** U2/U2a. Deviations: the statement lives in migration 0027's `SECURITY DEFINER` function `wp_reap_expired_leases(p_grace_seconds,p_limit)` owned by the new `wp_reaper` role — a bare cross-tenant UPDATE as `wp_scheduler` sweeps ZERO rows under FORCE RLS, see C12; `db/queries/reap-expired-leases.sql` is a pure passthrough wrapper, same discipline as `lease-scan-unowned.sql`. Metric label is `{result}` not `{outcome}` (C13). `created_at` dropped from the final WHERE per the timestamptz lesson. Registry path is `scripts/registries/cross-tenant-queries.ts`.) → `db/queries/reap-expired-leases.sql` (blueprint's SQL **verbatim**: `lease_expires_at < now() - interval '30 seconds'`, `ORDER BY lease_expires_at LIMIT 500 FOR UPDATE OF j SKIP LOCKED`, the `attempts` decrement on `prepared` **only**), `app/backend/src/modules/queue/reaper.ts` (writes `delivery_events(event_type='reconciled')` for every `acked` repair, emits one `RepairedSendSink.onRepairedSent(attemptId)` per repair, metrics `wp_reaper_repairs_total{outcome}` and `wp_unresolved_jobs_total`), `scripts/cross-tenant-queries.ts` (changed: register the reaper with role + reason + projected columns).
- [x] 4. The money seam, no-op until P18 (**DONE** U2. `repaired-send-sink.ts` with `onRepairedSent`/`onReconciledLost` keyed on `send_attempts.id` + `createCountingNoOpRepairedSendSink()`; header names P18. No wallet import. NOTE for the reviewer: `reconciler.ts` (U3) declares its own inline structural sink type rather than importing `RepairedSendSink` — duck-type compatible, worth unifying.) → `app/backend/src/modules/queue/repaired-send-sink.ts` (`interface RepairedSendSink { onRepairedSent(attemptId): Promise<void>; onReconciledLost(attemptId): Promise<void> }` + a counting no-op implementation and a header comment naming P18 as the phase that replaces it). No wallet import exists yet and none may be added here.
- [x] 5. `fromMe` echo capture (**DONE** U3. Deviation: "compute the same `content_hash` the dispatch path computes" was NOT implementable as written — see ADR 0035; both sides now hash the WIRE PROJECTION via one shared `contentHashInput`, and `dispatch.ts`'s own hash was corrected (it was key-order dependent, a latent P11 defect). `messages.upsert` did not exist anywhere and was newly wired in `session-worker-discovery-wiring.ts` (NOT `roles/session-worker.ts`, which is pinned at 299/300).) → `app/backend/src/modules/queue/echo-capture.ts`, wired into the session worker's `messages.upsert` handler in `app/backend/src/roles/session-worker.ts` (changed). Per message with `key.fromMe === true`: compute the same `content_hash` the dispatch path computes, `INSERT INTO message_wa_ids (client_id, instance_id, direction='out', wa_msg_id, content_hash, observed_at) ON CONFLICT DO UPDATE` that fills `content_hash`/`observed_at` **only when `message_id IS NULL`** — a resolved row is never overwritten. Ids and hashes only; **no body, no JID, no phone number** anywhere in the row or the log line. One try/catch per message: a throw skips one echo, never the socket.
- [x] 6. The echo reconciler (**DONE** U3. Cross-tenant READ goes through 0027's read-only `STABLE` definer `wp_reconcile_scan_unresolved`; every WRITE stays per-tenant inside `withTenant`. `needs_user_action` set `true` + `unresolved_reason='no_echo_evidence'` per C1. No automatic requeue in any branch.) → `app/backend/src/modules/queue/reconciler.ts`, `db/queries/reconcile-unresolved.sql`. For each `needs_reconcile` job inside `TIMING.reconcileWindowMs` (600 000): match unresolved evidence on `(client_id, instance_id, content_hash)` within ±5 min, oldest-in-flight-first, 1:1 enforced by setting `message_wa_ids.message_id` under its unique key; **>1 in-flight attempt sharing a hash ⇒ resolve none**, both to `blocked_needs_review`, `wp_reconcile_ambiguous_total++`. A resolved match: attempt → `reconciled_sent`, job → `sent`, `sent_at` = evidence `observed_at`, `delivery_events(event_type='reconciled')`, one `onRepairedSent`. Window expiry with no evidence: attempt → `abandoned`, job → `blocked_needs_review`, `unresolved_reason='no_echo_evidence'`, `needs_user_action='unresolved_send'`. **No automatic requeue exists in any branch.**
- [x] 7. Cron wiring (**DONE** U4. `pg_try_advisory_xact_lock` (TRANSACTION-scoped) not `pg_advisory_lock` — see C7; verified live that it releases at COMMIT leaving zero advisory locks, which is what makes it PgBouncer-transaction-mode safe. Keys `wp:cron:reaper` / `wp:cron:reconciler` are distinct so the two loops never block each other. `ROLE` enum + `main.ts` branch extended; compose service added with `mem_limit`.) → `app/backend/src/roles/cron.ts` (changed/created): reaper every 15 s, reconciler every 30 s ± jitter, each under a Postgres advisory single-flight lock so two cron processes cannot overlap; both loops bounded (`LIMIT`), both back off and retry on a database error without touching sockets or leases; register both cadences in `infra/compose/docker-compose.dev.yml` (changed) as `ROLE=cron`.
- [x] 8. The human two-choice path + guard (**DONE** U5/U5a. Deviations: `ctx.actor` does not exist in this repo, so the 403 gate is an explicit `actor` param checked fail-closed at the SERVICE layer and tested there (C8/decision 1); `AuthPolicy` is `session_mfa` (same consequence class as ADR 0013 c6 restricted-instance resume); the guard is chained into `package.json` `check:tenant-scope`, NOT added to `ci.ps1`/`ci.sh` (C4 - a test forbids that). Two REAL bugs caught: the replay guard could not distinguish a fresh insert from a replay (fixed via the `xmax = 0` tell, regression test added), and `wp_app` lacked UPDATE on `send_attempts` + `unresolved_action_keys` - a PRODUCTION-ONLY failure invisible to tests because dev connects as a superuser-ish role; fixed by migration 0028.) → `app/backend/src/modules/queue/unresolved.service.ts`, `app/backend/src/modules/queue/unresolved.routes.ts`, `packages/contracts/src/messages.ts` (changed), `packages/domain/src/copy/unresolved.ts`, `scripts/check-no-auto-requeue.ts`, `scripts/ci.ps1` + `scripts/ci.sh` (changed). `POST /v1/messages/:id/unresolved/retry` and `.../discard`, both mandatory `Idempotency-Key`, both requiring `ctx.actor.userId` (API key and system actor rejected with 403). Retry → job `queued`, `next_attempt_at=now()`, attempt `reconciled_lost`, one `onReconciledLost`, audit row. Discard → job `cancelled`, `cancel_reason='unresolved_discarded'`, audit row. Guard: only `unresolved.service.ts` may contain an UPDATE moving a job out of `blocked_needs_review`, and it must be inside a function taking an actor — with the `guard matched zero files` meta-assertion.
- [x] 9. Panel entry + the 100× chaos harness (**DONE** U6a/U6b. Paths corrected per C10. Harness ran a genuine 100 iterations, no cap, deterministic mulberry32 seed `20260901`; all five crash checkpoints exercised - `{no_attempt:19, prepared:21, dispatched:27, acked:13, failed:20}`. Panel renders both canon strings verbatim from `@wp/domain` (barrel export added by the main session), carries no phone/JID/body, and guards a double-click double-send. NOTE: no `GET` list route exists, so the hook sources rows through one honestly-named function returning an explicit unavailable state - no fabricated data. A list route is owed by a later phase.) → `app/frontend/src/features/unresolved/UnresolvedSendsPanel.tsx`, `app/frontend/src/features/unresolved/useUnresolvedSends.ts`, `app/backend/test/support/crash-injector.ts`, `app/backend/test/integration/queue/crash-recovery.int.test.ts`. Panel: per-instance "Unresolved sends" list with exactly two buttons — **"Retry (may duplicate)"** and **"Discard (may have been delivered)"** — and the explanatory string from `@wp/domain` (see gotchas). Harness: 100 iterations killing the worker at a randomised point between the `dispatched` write and the result write; assert **zero lost** (every job terminal or claimable), **zero silent duplicates** (the mock transport records at most one send per attempt unless a human chose Retry), and tests 15-17 green.
- [ ] 10. **SPIKE-2, on a real number** → `app/backend/test/manual/spike-2-echo.ts` (a scripted, not automated, runner), `docs/evidence/P12-spike-2-echo.md`. Method: with the pinned P08 config (`syncFullHistory:false`, `shouldSyncHistoryMessage:()=>false`, `markOnlineOnConnect:false`), send to a second real phone, `kill -9` between the `dispatched` write and the ack, reconnect, and log **every** event for 15 min, recording for each trial whether a `fromMe` echo arrived, through which event (`messages.upsert` type `notify`/`append`, `messaging-history.set`), its latency, and whether it carried the `wa_msg_id` and enough content to hash. **≥10 trials**, spaced, varying offline duration (30 s / 5 min / 10 min). Write the raw counts, the verdict, and the consequence chosen (see gotchas for the two forks). Nothing is rounded and nothing is inferred from a mock socket.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/src/modules/queue/reaper.test.ts` | `prepared_attempt_requeues_and_decrements_attempts_by_one` | `prepared` → `queued`, `attempts` −1, `next_attempt_at ≈ now()+5s` |
| `app/backend/src/modules/queue/reaper.test.ts` | `no_attempt_row_requeues_without_touching_attempts` | the "never incremented" case is never decremented |
| `app/backend/src/modules/queue/reaper.test.ts` | `dispatched_attempt_becomes_needs_reconcile_never_queued` | no blind retry of a possibly-delivered message (invariant 2) |
| `app/backend/src/modules/queue/reaper.test.ts` | `acked_attempt_is_repaired_to_sent_with_the_attempt_resolved_at` | `sent_at = resolved_at`, `terminal_at` set, one `reconciled` delivery event |
| `app/backend/test/integration/queue/reaper.int.test.ts` | `reaper_never_drives_attempts_negative` | **mandatory 15** — 100 workers killed between claim and attempt insert → `min(attempts)=0` and the job still terminates at `max_attempts` |
| `app/backend/test/integration/queue/reaper.int.test.ts` | `reaper_repairs_nothing_before_the_thirty_second_grace` | a live heartbeat-renewed lease is untouched (the slow-media case) |
| `app/backend/test/integration/queue/reaper.int.test.ts` | `every_repaired_send_emits_exactly_one_repaired_send_item` | one sink call per repair, keyed on `send_attempts.id`, idempotent across a re-run |
| `app/backend/test/integration/queue/reaper.int.test.ts` | `reaper_batch_is_bounded_and_two_cron_processes_do_not_overlap` | `LIMIT 500` honoured; the advisory lock makes the second process a no-op |
| `app/backend/src/modules/queue/reconciler.test.ts` | `echo_reconciles_ambiguous_hashes_conservatively` | **mandatory 17** — two in-flight attempts, same content hash → **neither** resolved, both `blocked_needs_review`, `wp_reconcile_ambiguous_total` +1 |
| `app/backend/src/modules/queue/reconciler.test.ts` | `an_echo_outside_the_five_minute_tolerance_is_not_a_match` | stale evidence never resolves a job |
| `app/backend/test/integration/queue/reconciler.int.test.ts` | `a_single_echo_resolves_the_oldest_in_flight_attempt_once` | 1:1 assignment holds under a concurrent second reconciler run |
| `app/backend/test/integration/queue/reconciler.int.test.ts` | `an_echo_for_an_unresolved_attempt_is_recorded_not_dropped` | evidence row exists with `message_id NULL` before the reconciler runs |
| `app/backend/test/integration/queue/reconciler.int.test.ts` | `window_expiry_without_evidence_blocks_and_never_requeues` | attempt `abandoned`, job `blocked_needs_review`, `needs_user_action` set, **0 jobs requeued** |
| `app/backend/test/integration/queue/reconciler.int.test.ts` | `reaper_and_reconciler_do_not_cross_tenants` | isolation suite B style: two tenants seeded, single-tenant output on both loops |
| `app/backend/test/integration/queue/unresolved-api.int.test.ts` | `unresolved_job_is_never_auto_requeued_under_default_policy` | **mandatory 16** — 72 simulated hours of cron produce zero transitions out of `blocked_needs_review` |
| `app/backend/test/integration/queue/unresolved-api.int.test.ts` | `retry_and_discard_require_a_user_actor_and_write_an_audit_row` | API key → 403, system actor → 403, user → 200 + audit row with `actor_user_id` |
| `app/backend/test/integration/queue/unresolved-api.int.test.ts` | `discard_cancels_and_never_fails_or_deletes_the_job` | status `cancelled`, `cancel_reason='unresolved_discarded'`, row still present |
| `app/backend/test/integration/queue/unresolved-api.int.test.ts` | `a_replayed_retry_with_the_same_idempotency_key_requeues_once` | second call is a no-op returning the same response |
| `app/backend/test/integration/queue/crash-recovery.int.test.ts` | `hundred_kills_between_dispatch_and_result_lose_nothing` | job count invariant holds; every job is terminal or claimable; zero stranded rows |
| `app/backend/test/integration/queue/crash-recovery.int.test.ts` | `hundred_kills_produce_zero_silent_duplicate_sends` | mock transport: ≤1 send per attempt id; any second send is traceable to a human Retry |
| `scripts/__tests__/check-no-auto-requeue.test.ts` | `a_second_path_out_of_blocked_needs_review_fails_the_guard` | planting the transition in another file turns the guard red; guard reports a non-zero matched-file count |
| `packages/domain/src/copy/unresolved.test.ts` | `unresolved_copy_contains_no_banned_claims_and_states_both_risks` | `check-copy` clean; both strings present verbatim |

Mandatory-suite tests this phase makes green: **15, 16, 17** (and 14 from P11 must stay green — re-run it).

## C1 review findings and their resolution (2026-09-02)

`reviewer` (opus/high) verdict at first pass: **`CHANGES-REQUESTED`** — four CRITICAL findings, all in the
reaper/reconciler repair contract, all reachable in production. **All four fixed and re-verified**; the two
worst were reproduced empirically by the main session before any fix was dispatched, and re-proved after.

| # | Finding | Status |
|---|---|---|
| **C1-1** | **Unbounded retry loop.** The `prepared` repair decremented `attempts`, but `wp_reaper` has SELECT-only on `send_attempts` so the `prepared` attempt row survived. Next claim recomputed the SAME `attemptNo`, hit `UNIQUE (message_job_id, attempt_no)`, threw `DispatchAlreadyRecorded`, requeued — forever. `claim-jobs.sql` has no `attempts < max_attempts` predicate (by design: exhaustion is a RESULT-time decision) and a `prepared` crash never produces a result, so nothing bounded it. **Reproduced live** (`attempts=0` while `attempt_no=1` survived). | **FIXED** in migration 0029. Both fixes the main session proposed were rejected with better reasons: retiring the row to `abandoned` does not help (the unique constraint has no state predicate, so the slot stays occupied), and DELETEing the row would require granting `wp_reaper` DELETE on `send_attempts`, contradicting the existing `wp_reaper_has_no_grant_beyond_message_jobs_and_send_attempts` hardening test. Shipped fix: **stop decrementing on the `prepared` branch** so `attempts` only moves forward and the collision is structurally impossible. **Re-proved live**: `attempts=1`, next `attemptNo=2`, only slot 1 exists ⇒ no collision. |
| **C1-2** | **The `failed` repair bypassed the retry matrix.** Every `failed` attempt was mapped to `queued` with a flat 5 s, and `error_class` was not even projected out of the SQL. So `FAIL_PERMANENT` was retried, `RETRY_BACKOFF` lost its exponential jitter, and — worst — `restricted`/`unknown`, which `classify()` **short-circuits** to `PAUSE_INSTANCE`, was scheduled for a retry 5 seconds later **with no instance pause**. A provider restriction signal answered by an automatic resend: invariant 2 and a safety-compliance violation. | **FIXED** in migration 0029. `error_class` is now projected through the CTE and the RETURNING list; the `failed` arm maps to `needs_reconcile` and `reaper-failure-reclassify.ts` re-drives it through the **real** `classify()`, `isRetryBudgetExhausted()`, `backoff()` and `pauseInstanceForResult()`. A `restricted` attempt now PAUSES THE INSTANCE. Metric union updated to `requeued_no_attempt`, `requeued_prepared`, `needs_reconcile`, `repaired_sent`, `failed_terminal`, `failed_paused`, `failed_retry_scheduled`. |
| **C1-3** | **The ambiguity rule was defeated by a stale snapshot**, and its losing branch stranded the job. `sibling_inflight_count` was read in the cross-tenant scan but the resolve wrote in a later, separate transaction; an echo replay landing in that gap (a real, expected event — it is exactly when the sweep runs) let the reconciler mark an ambiguous send `sent`. That is the FALSE-MATCH direction, which ADR 0035 §7 calls the worse one: invisible, no signal, no human asked, and under P18 it is also charged. Separately, a zero-row assignment returned early leaving the job `needs_reconcile` with a `dispatched` attempt, so a genuinely delivered+matched job silently became human review. | **FIXED** in `reconciler-resolve.ts` (new sibling module). The evidence lookup is re-run a second time **inside the same `withTenant` transaction as the assignment UPDATE**, and any mismatch aborts to the ambiguous path from inside that same transaction — so the abort and the "did we resolve" answer can never diverge. The out-of-transaction scan is now documented as a cheap pre-filter only, never the authority. The zero-row case became a three-way ownership decision (own-replay ⇒ proceed idempotently / another job ⇒ ambiguous / still NULL ⇒ re-check). Ownership is checked FIRST, because an own-replay's evidence row no longer satisfies `message_id IS NULL` and a naive re-check would misclassify it as ambiguous. Covered by deterministic-interleaving tests, not sampled races. |
| **C1-4** | **`sibling_inflight_count` computed with no `client_id` predicate** — the one aggregate in the phase whose value crosses into a tenant's correctness decision (resolve vs. ambiguous), computed inside a BYPASSRLS-owned function, while migration 0027's own header claimed the function "reads no tenant identity to make ANY decision" (true for the reaper, false for this subquery). | **FIXED** in migration 0029 (`AND sib.client_id = a.client_id`), applied via `CREATE OR REPLACE` with owner, `REVOKE ALL FROM PUBLIC` and `GRANT EXECUTE TO wp_scheduler` re-asserted afterwards and verified. A catching test is **not constructible** — `instance_id` is a globally-unique UUID so two tenants can never share one; the agent correctly declined to write a test that would prove nothing. |

Reviewer NOTEs 6 (the single-flight lock's transaction is not the sweep's transaction — doc comments corrected
rather than nesting unrelated tenants into one transaction) and 8 (`echo-capture.ts`'s catch could stringify a
pg error carrying row values into a log line — now logs a bounded `err.name` + pg `code`, with a test asserting
no row values leak) are also fixed. NOTEs 5, 7, 9, 10, 11, 12 are filed as carried items.

**The reviewer's explicit confirmation, which mattered as much as the findings:** the `acked`-never-requeued
path is **airtight** across all three layers (the SQL `CASE`, the module's classification, and the CTE's
exclusion of reaper-output states), and second-pass idempotency is real. That is the bug that would have
double-sent to a real person.

### Two severe LATENT bugs found while fixing the above (both pre-existed P12)

1. **The reaper and reconciler were silently INERT for essentially all real crashed jobs.** Both joined
   `send_attempts` to `message_jobs` on `a.message_job_created_at = j.created_at`. But `dispatch.ts` writes that
   column from a JS `Date`, truncating `timestamptz` microseconds to milliseconds — so the equality matched
   almost nothing and every genuinely `prepared`/`dispatched`/`acked`/`failed` attempt fell through the
   `LEFT JOIN` to the "no attempt row" branch. It reported success throughout, because a `LEFT JOIN` that
   matches nothing yields NULL, not an error, and NULL is a legitimate expected state. The predicate was
   justified in canon as "partition-aligned", but **`send_attempts` is not partitioned** (verified:
   `pg_class.relkind = 'r'`), so the term was never load-bearing at all. **Fixed** by dropping the dead
   equality from both joins; the remaining keys (`lease_id`; `message_job_id` + `state='dispatched'`) are
   sufficient. Found only because the new repeated-crash-cycle test made multiple REAL `dispatch()` calls and
   then a real reap — the existing fixtures were too correct to catch it, since they already resolved that
   column server-side. Third distinct manifestation of the timestamptz lesson; recorded as its own lesson.
2. **`dispatch.ts`'s `content_hash` was key-order dependent** — it hashed `JSON.stringify(payload)` of an open,
   tenant-controlled record, so `{"text":"hi","foo":1}` and `{"foo":1,"text":"hi"}` hashed differently. Fixed by
   ADR 0035's wire-projection hash, which both sides now compute through one shared pure function.

## Definition of done
- [x] Every step box above is ticked (steps 1-9 complete; step 10's runner + evidence skeleton are built and the operator run is pending a real number — see the two SPIKE-2 boxes below).
- [x] Full-gate output pasted **verbatim** into the session log — GREEN. `CI GREEN — all 19 steps passed` / `EXITCODE:0`, 229 integration files / 827 tests, captured firsthand 2026-09-02 00:16 via `scripts/gate.ps1` (the one sanctioned entrypoint; `ci.ps1` is a preflight wrapper and per C4 must not itself carry steps).
- [x] Named tests exist and pass; none skipped, none `.only`. Mandatory suite tests **15, 16, 17** green, and 14 (from P11) re-run green. Test 15's previously-unasserted second half ("the job still terminates at `max_attempts`") is now genuinely discharged by `reaper-prepared-collision-loop.integration.test.ts`.
- [x] `reviewer` verdict recorded: **`CHANGES-REQUESTED`** at first pass (four CRITICAL findings) → all four fixed and re-verified, the two worst reproduced empirically before and after the fix. See the C1 section above. Remaining NOTEs filed as carried items.
- [x] Invariant check done (C3), written one line per invariant in the session log. Invariants 1, 2, 3, 4, 6, 7 satisfied. **Invariant 5 is only PARTIALLY satisfied and is recorded as such**: `blocked_needs_review` preserves the job row (never failed, never deleted), but with no `GET` list route the panel cannot display it, so it is closer to a strand than a stop until that route lands. Carried, and it should block whichever phase claims the panel is usable.
- [ ] **NOT DONE — awaiting the founder's operator run.** `docs/evidence/P12-spike-2-echo.md` EXISTS as a skeleton marked NOT YET RUN, with the stakes, the pre-registered decision rule (both forks, the ≥8/10 threshold, and "3/10-8/10 is fork (b) with the numbers stated"), an empty ≥10-row results table covering the 30 s / 5 min / 10 min buckets, the ADR 0035 §8 JID/`addressingMode` must-capture column, the ban-risk disclosure, and a full operator runbook. The runner is `app/backend/test/manual/spike-2-echo.ts` (claimed by NEITHER vitest project, verified). **No trial count, no raw outcome and no fork may be written into it except from a real run on a real number** — a synthetic write-up would be exactly the false evidence invariant 7 exists to prevent.
- [ ] **N/A until the spike runs.** No fork has been taken because no trial has been run. If the run lands on fork (b), the ADR is owed at that point (next free number), indexed in `.memory/MEMORY.md`, and must re-size the human-review workload in decisions/day at the measured send rate.
- [x] Files created/changed listed below, corrected against the real tree (this list *is* the diff — there is no git).

## Files created or changed this session

**This list IS the diff — there is no git (ADR 0003). The reviewer reviews exactly this list.**
Corrected against the real tree at session close; the phase file's original "expected set" was wrong in
several places (see the Session-open corrections block, C1-C13).

### Migrations (all additive, forward-only, all applied; `EXPECTED_SCHEMA_VERSION` 25 → 28)
- `db/migrations/0026_reconcile_support.sql` — created (186 lines). Echo-evidence columns
  (`message_wa_ids.content_hash`, `.observed_at`), `message_jobs.unresolved_reason`, `.unresolved_at`, the
  partial unique index `message_wa_ids_message_id_uq` that makes 1:1 echo assignment REAL (nothing enforced it
  before), the evidence lookup index, the new `unresolved_action_keys` replay authority, and the additive
  `wp_scheduler` column grants migration 0012 had reserved for "the reaper's own migration".
- `db/migrations/0027_reaper_and_reconcile_definer_functions.sql` — created (428 lines). The new `wp_reaper`
  role (`NOLOGIN BYPASSRLS`, column-scoped grants only, zero table-level grants, no role memberships) owning
  the WRITING definer `wp_reap_expired_leases`; the read-only `STABLE` definer `wp_reconcile_scan_unresolved`
  stays owned by `wp_admin_app`. Both hardened: pinned `search_path`, `REVOKE ALL FROM PUBLIC`, `EXECUTE` to
  `wp_scheduler` only.
- `db/migrations/0028_unresolved_retry_discard_grants.sql` — created (99 lines). `GRANT UPDATE (state,
  resolved_at) ON send_attempts TO wp_app` and `GRANT UPDATE (action) ON unresolved_action_keys TO wp_app` —
  closing a PRODUCTION-ONLY failure that every test missed because dev connects as a superuser-ish role.

### Queries
- `db/queries/reap-expired-leases.sql` — created (23 lines), passthrough wrapper over the definer
- `db/queries/reconcile-unresolved.sql` — created (24 lines), ditto

### db/ schema, isolation, tests
- `db/schema/message-jobs.ts` — changed: `unresolvedReason`, `unresolvedAt`
- `db/schema/message-wa-ids.ts` — changed: `contentHash`, `observedAt`
- `db/schema/unresolved-action-keys.ts` — created
- `db/schema/index.ts` — changed: registered `unresolvedActionKeys`
- `db/schema/grants.snapshot.json` — regenerated (diff reviewed line-by-line, 3 times)
- `db/src/isolation/tenant-tables.ts` — changed: `unresolved_action_keys: 'client_id'`
- `db/src/schema-version.ts` — changed: `EXPECTED_SCHEMA_VERSION` 25 → 28
- `db/tests/reconcile-support-schema.test.ts` — created (asserts the unique indexes ENFORCE, not merely exist)
- `db/tests/reaper-definer.test.ts` — created
- `db/tests/reaper-repair-contract.test.ts` — created (the four-state contract, cross-tenant)
- `db/tests/wp-reaper-role.test.ts` — created (role hygiene: NOLOGIN, no stray grant)
- `db/tests/unresolved-grants.test.ts` — created (runs AS `wp_app` via `SET ROLE` — the blind spot that hid the bug)
- `db/tests/helpers/reaper-fixtures.ts` — created
- `db/tests/helpers/unresolved-grants-support.ts` — created
- `db/tests/helpers/grants.ts` — changed: `SNAPSHOT_ROLES` += `wp_reaper`
- `db/tests/grants-snapshot.test.ts` — changed: `wp_reaper` pinned `rolbypassrls = true` DELIBERATELY, commented
- `db/tests/grants-scheduler-columns.test.ts` — changed: pinned column list extended (0026)

### The reaper, reconciler, echo capture, money seam
- `app/backend/src/modules/queue/reaper.ts` — created (223)
- `app/backend/src/modules/queue/reaper.test.ts` — created (127)
- `app/backend/src/modules/queue/reaper.integration.test.ts` — created (229) — **mandatory test 15**
- `app/backend/src/modules/queue/reconciler.ts` — created (261)
- `app/backend/src/modules/queue/reconciler-decision.ts` — created (77), the pure decision function
- `app/backend/src/modules/queue/reconciler.test.ts` — created (181) — **mandatory test 17**
- `app/backend/src/modules/queue/reconciler.integration.test.ts` — created (236)
- `app/backend/src/modules/queue/echo-capture.ts` — created (162)
- `app/backend/src/modules/queue/echo-capture.test.ts` — created (194)
- `app/backend/src/modules/queue/repaired-send-sink.ts` — created (47), the P18 money seam, no-op
- `app/backend/src/modules/queue/__tests__/reconciler-test-helpers.ts` — created (111)
- `app/backend/src/modules/queue/__tests__/crash-injector.ts` — created (149), seeded mulberry32 PRNG
- `app/backend/src/modules/queue/crash-recovery.integration.test.ts` — created (224) — **the 100× chaos harness**
- `app/backend/src/modules/queue/__tests__/suite-b-reaper-reconciler.integration.test.ts` — created (262),
  isolation suite B (main session corrected a wrong `message_jobs.id` uniqueness claim in its comment)

### The human two-choice path
- `app/backend/src/modules/queue/unresolved.service.ts` — created (261), fail-closed actor gate
- `app/backend/src/modules/queue/unresolved-repo.ts` — created (99)
- `app/backend/src/modules/queue/unresolved.routes.ts` — created (118), `session_mfa` policy
- `app/backend/src/modules/queue/unresolved.service.test.ts` — created (38)
- `app/backend/src/modules/queue/unresolved-api.integration.test.ts` — created (229)
- `app/backend/src/modules/queue/unresolved-no-auto-requeue.integration.test.ts` — created (87) — **mandatory test 16**
- `app/backend/src/modules/queue/unresolved-repo-replay.integration.test.ts` — created (93), regression for a real bug
- `app/backend/src/modules/queue/__tests__/unresolved-test-support.ts` — created (117)
- `app/backend/src/modules/queue/index.ts` — changed

### The cron role
- `app/backend/src/roles/cron.ts` — created (83), thin composition root
- `app/backend/src/engine/cron/single-flight.ts` — created (129), `pg_try_advisory_xact_lock`
- `app/backend/src/engine/cron/single-flight.integration.test.ts` — created (101)
- `app/backend/src/engine/cron/cron-loop.ts` — created (126), injected-timer ticker + skip-guard
- `app/backend/src/engine/cron/cron-loop.test.ts` — created (203)
- `app/backend/src/engine/cron/cron-loop-shape.test.ts` — created (121), never-touches-sockets/leases
- `app/backend/src/engine/cron/cron-wiring.ts` — created (141)
- `app/backend/src/main.ts` / `main.test.ts` — changed: `cron` dispatch branch
- `app/backend/src/platform/config.ts` — changed: `ROLE` enum += `'cron'`
- `infra/compose/docker-compose.dev.yml` — changed: `ROLE=cron` service, `mem_limit: 512m`

### The live send socket (carried P11 item 1 — CLOSED)
- `app/backend/src/engine/session/registry.ts` — changed: `getSendSocket?()` added beside untouched `getSock`
- `app/backend/src/engine/session/runner-types.ts` — changed: optional `sendMessage?`; `messages.upsert` union
- `app/backend/src/engine/session/runner.ts` — changed: `getSendSocket` (fail-closed) + `messages.upsert` wiring
- `app/backend/src/engine/session/runner-send-socket.test.ts` — created (167)
- `app/backend/src/engine/session/runner-test-support.ts`, `runner.test.ts` — changed
- `app/backend/src/engine/session/session-worker-runner-factory.ts` — changed: threads `onMessagesUpsert`
- `app/backend/src/engine/session/session-worker-discovery-wiring.ts` — changed: builds the echo-capture closure
- `app/backend/src/engine/queue/send-loop-fleet-wiring.ts` — changed: `FleetRegistryHandle.getSendSocket?()`
- `app/backend/src/engine/queue/send-loop-worker-wiring.ts` — changed: real socket resolver; header rewritten
- `app/backend/src/engine/queue/send-loop-worker-wiring.test.ts` — changed

### Content hash (ADR 0035) + dispatch correction
- `packages/domain/src/queue/content-hash.ts` — created (86), pure canonicalisation
- `packages/domain/src/queue/content-hash.test.ts` — created (83)
- `app/backend/src/engine/queue/content-hash.ts` — created (21), the sha256 wrapper
- `app/backend/src/engine/queue/content-hash.test.ts` — created (49)
- `app/backend/src/engine/queue/dispatch.ts` — changed (296): local `contentHash` deleted, routed through the
  shared `computeContentHash` — this also fixed a latent P11 defect (the old hash was key-order dependent)
- `app/backend/src/engine/queue/metrics.ts` / `metrics.test.ts` — changed: `reaperRepairsTotal`,
  `unresolvedJobsTotal`, `reconcileAmbiguousTotal`, `echoCaptureFailedTotal`

### Contracts, copy, domain
- `packages/contracts/src/messages.ts` — changed (198): the two unresolved route contracts
- `packages/contracts/src/index.ts` — changed
- `packages/domain/src/copy/unresolved.ts` — created (23), both canon button strings byte-exact
- `packages/domain/src/copy/unresolved.test.ts` — created (40)
- `packages/domain/src/index.ts` — changed (178): barrel export for the unresolved copy (main session)
- `packages/domain/src/timing.ts` / `timing.test.ts` — changed: `reaperIntervalMs`, `reconcilerIntervalMs`,
  `echoToleranceMs` + two ordering assertions

### Panel
- `app/frontend/src/features/unresolved/UnresolvedSendsPanel.tsx` — created (107), pure render
- `app/frontend/src/features/unresolved/UnresolvedSendsScreen.tsx` — created (34)
- `app/frontend/src/features/unresolved/useUnresolvedSends.ts` — created (146)
- `app/frontend/src/features/unresolved/api.ts` — created (100)
- `app/frontend/src/features/unresolved/index.ts` — created (12)
- `app/frontend/src/features/unresolved/__tests__/unresolved-sends-panel.test.tsx` — created (219), 8 cases
- `app/frontend/src/routes/_authed/unresolved.tsx` — created (14)
- `app/frontend/src/components/app-shell.tsx` — changed: nav link
- `app/frontend/src/routeTree.gen.ts` — regenerated by the router plugin (not hand-edited)
- `packages/i18n/src/catalogues/en.ts`, `hi.ts` — changed: `nav.unresolved`, `unresolved.panel.*`

### Guards / CI
- `scripts/check-no-auto-requeue.ts` — created (182). Main session added the `TEST_FILE_PATTERN` exemption
  matching `check-tenant-scope`'s convention (a test proving the human transition works is evidence FOR the
  invariant, not a second path around it).
- `scripts/guards/no-auto-requeue-lib.ts` — created (99)
- `scripts/guards/no-auto-requeue-actor.ts` — created (82)
- `scripts/__tests__/check-no-auto-requeue.test.ts` — created (91)
- `scripts/guards/__fixtures__/no-auto-requeue/*` — created (5 fixtures)
- `scripts/guards/registry.ts` — changed: 24th guard registered
- `package.json` — changed: guard chained into `check:tenant-scope` (**NOT** added to `ci.ps1`/`ci.sh` — C4)
- `scripts/registries/cross-tenant-queries.ts` — changed (84): reaper + reconciler entries
- `scripts/check-tenant-scope.ts` — changed: `unresolved_action_keys` added to the `TENANT_TABLES` mirror
- `scripts/guards/single-claim-lib.ts` — changed (298): fixed a REAL false positive — `\bUPDATE\b` matched the
  `FOR UPDATE ... SKIP LOCKED` row-lock clause, and `--` comment prose was scannable
- `scripts/__tests__/check-single-claim.test.ts` — changed (300): 5 new cases, both directions
- `scripts/guards/__fixtures__/single-claim/{clean-for-update-skip-locked,bad-claim-for-update-skip-locked,bad-claim-comment-noise}.sql` — created

### Callers updated for new deps (mechanical)
- `app/backend/src/platform/http/server.ts`, `app/backend/src/roles/api.ts`,
  `app/backend/src/modules/instances/__tests__/instances-routes-test-support.ts`,
  `app/backend/src/modules/tenancy/__tests__/tenancy-routes-test-support.ts`,
  `app/backend/src/modules/messages/enqueue-test-support.ts` — changed

### Decisions / lessons / plan
- `.memory/decisions/0035-echo-content-hash-canonical-form.md` — created, `in force`
- `.memory/lessons/2026-09-01-for-update-skip-locked-false-positives-the-claim-guard.md` — created
- `.memory/MEMORY.md` — changed: index lines appended (Edit, never rewritten)
- `plan/v1/P12-queue-recovery-and-echo-spike.md` — changed: corrections C1-C13, the reaper's real 4-state
  contract, 8 session-open/in-session decisions, the Dispatch plan, all step boxes, this file list

### Removed
- `_debug_reap.mjs` — a stray throwaway diagnostic script left at the repo root by a unit; deleted by the main
  session after verifying it held no secrets. Its leaked dev-DB rows were also cleaned.

## Risks / gotchas specific to this phase
- **The `check-single-claim` guard will probably flag the reaper.** The reaper's UPDATE carries `WHERE j.status='processing'`. The P03 guard bans a **second statement that SETs** `status='processing'` — a WHERE predicate is legitimate. If the guard is red here, fix the guard's pattern (SET-side only) and add a regression case to `scripts/__tests__/check-single-claim.test.ts`; do **not** reword the reaper to dodge it and do **not** weaken the guard to a substring match that matches nothing.
- **The `attempts` decrement is `prepared`-only, and this is the bug the mandatory test exists for.** Decrementing the "no attempt row" case drives the counter negative and creates an unbounded-retry path — a job that can never reach `max_attempts`. `GREATEST(0, …)` is a belt, not the fix; the `CASE` is the fix.
- **`dispatched` must never be requeued.** It is the "we may have delivered it" state. Automatically requeueing it sends a real person the same message twice, which is the report vector no pacing controls. Blind retry here is an invariant-2 violation, not an optimisation.
- **A repaired send that is never charged is a real revenue hole.** The blueprint's reaper is a bulk cross-tenant UPDATE with no tenant context and no price resolution. That is why step 4 exists: one work item per repaired attempt, keyed on `send_attempts.id`, so P18's guard table charges it exactly once. Do not shortcut it by "P18 will scan for repairs" — the delta already rejected that.
- **The echo evidence row is not an inbox row.** P12 writes ids and hashes only. There is **no `messages` table in v1 at all** — the inbox is v2 (ADR 0021). P21 wraps this handler in a dispatcher and adds the dead-letter write; it does not change this statement. and no body, JID, phone number or preview may be written or logged here. When P21 lands, its handler must take the *update* path on an existing evidence row rather than inserting a second one.
- **Do not build `ambiguous_send_policy = 'resend_once'`.** v1 ships `ask_me` behaviour only and no column for the alternative. Any automatic requeue of an ambiguous send is a loosening that needs its own ADR plus the "inert during a restriction pause" guard; adding the column now invites someone to flip it later. Record the descope in the session log and carry it into P13's file if it stays open.
- **SPIKE-2 cannot be answered synthetically.** A mock WS endpoint replays whatever we make it replay. If no real number is available, the honest outcome is "not answered" — split to P12a and leave P23 blocked. Writing a synthetic run up as a SPIKE-2 result would be exactly the kind of false evidence invariant 7 exists to prevent.
- **The two SPIKE-2 forks, decided before you start so the result cannot be rationalised.** (a) Echo arrives in ≥8/10 trials within the window ⇒ keep `shouldSyncHistoryMessage:()=>false`, record the observed latency distribution, and set the window from data. (b) Echo does not arrive ⇒ either implement the **narrow** filter `shouldSyncHistoryMessage: (msg) => msg.key?.fromMe === true && msgTimestamp >= now − reconcileWindow` (still no history in the inbox; keep the P08 runtime config assertion green; re-run the spike to confirm the change works) **or** write the ADR that echo reconciliation is unavailable and re-size the human-review workload in decisions/day at the current measured send rate. Anything between 3/10 and 8/10 is fork (b) with the numbers stated.
- **Repeated `kill -9` on a real number carries a real risk.** It lands on the founder's own at-risk number with no appeal path (ADR 0013). Keep step 10 to ~10-20 spaced trials, never a loop; this is our own account being crash-tested, which is legitimate — but it is not free, and it is not a reason to build any reconnection trick.
- **Copy honesty.** The unresolved explanation says what is true and nothing more: we could not confirm delivery, WhatsApp did not acknowledge before the connection dropped, retrying may deliver it twice, discarding may leave it unsent. No "guaranteed", no "never lost", no blame on WhatsApp, no promised time. Both button strings are verbatim from the blueprint and go through `check-copy.ts`.
- **`blocked_needs_review` is a stop, not a strand.** The job row keeps its payload, is visible in the panel with a count, and one human click moves it. A state that is silently unclaimable with no surface is a stranded job under invariant 5 — assert the panel query returns it in the integration test, not just the row's status.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P13 — pacing-ledger-and-warmup. Read plan/v1/P13-pacing-ledger-and-warmup.md and follow it exactly:
one phase, one session. Deps P12 are done (see plan/README.md). Do not start P14.
P13 is sized L — split it at the ledger/reserve line if your session is a single sitting.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
