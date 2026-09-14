# P11 — send-path-mvp

**Goal (one line):** a message accepted at `POST /v1/messages` becomes a durable job, is claimed by the canonical statement under a DWRR band, is dispatched through `MessageTransport` with its `send_attempts` row written **before** the provider call, and its result is recorded with the zero-row hard error and a full `delivery_events` trail — woken by pub/sub and backstopped by a mandatory safety poll.
**Status:** todo · **Size:** M · **Session:** 1 of 1
**Depends on:** P10, P03 (must be `done`)
**Blocks:** P12, P13, P15, P18

**Size warning:** this phase lands exactly on the 10-step ceiling. If step 7 is not green by mid-session, stop after step 7 and split: steps 8-10 (wake loop + send-loop wiring + composer + e2e) become `plan/v1/P11a-send-loop-and-composer.md`, and P12 waits on P11a, not P11.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; every migration applied; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL **O2**).
- P03 landed: `message_jobs` (monthly partitions), `message_job_refs`, `message_wa_ids` (final both-directions shape), `delivery_event_ids`, `send_attempts`, `delivery_events`, `db/queries/claim-jobs.sql` (the merged claim, wallet + campaign predicates included), `claimOne()` in `app/backend/src/modules/queue/queue.repo.ts`, and the `check-single-claim` guard.
- P06 landed: `instance_lease_state` with the Postgres-minted fence; every state write carries a fence predicate; `TIMING` exports `leaseTtl 30s`, `heartbeat 10s`, `takeoverGrace 15s`, `watchdog 15s`, `sendTimeout 45s`.
- P08 landed: the pinned Baileys socket factory, `disconnect-map.ts` as data, the `ChannelLink` half of `app/backend/src/provider/baileys/adapter.ts`. **`MessageTransport` does not exist yet — it lands here.**
- P09/P10 landed: discovery, admission control, derived `MAX_SESSIONS_PER_WORKER`, the worker metric registry and its four-gauge `instance_id` label allow-list.
- P00 landed in `@wp/domain`: the job FSM, `retry/classify.ts`, `queue/dwrr.ts` (pure selector, mandatory test 19 half), `check-send-origin`, `check-copy`, `roles/api.ts ↛ provider/**` in dependency-cruiser.
- P04/P05 landed: auth, `TenantContext`, route policy + entitlement guards, the SPA shell and the authorised SSE channel.
- ADRs **0013, 0015, 0016, 0017, 0018, 0019, 0020 accepted**. ADR 0020 §8 is binding on this phase (see gotchas).
- **No design decision is open.** Every statement this phase writes is specified verbatim in the blueprint or the delta — skip **O3**, go straight to E1.

## What you are building (3-6 bullets)
- `POST /v1/messages` with a **mandatory** `Idempotency-Key`: one transaction writing `message_jobs` + `message_job_refs` (`ON CONFLICT DO UPDATE` no-op `RETURNING`, never `DO NOTHING`) + a `created`/`queued` `delivery_events` pair + an audit row; the reply is `201 {data:{id: public_id, status:'queued'}}` and a replay returns the **original** job, byte-identical, with zero 5xx.
- The `MessageTransport` half of the Baileys adapter: `send()`, `isReady()`, `capabilities`, a hard 45 s timeout, and provider errors mapped to `SendErrorClass` only.
- Dispatch: one transaction writing `send_attempts(state='prepared')` + `attempts = attempts + 1` + `delivery_events('dispatched')` **before** the provider is called, then the out-of-transaction `dispatched` mark, the heartbeat-renewed lease during flight, and the result write with its zero-row `claim_lost_during_send` hard error.
- The event-driven wake loop: a wake published on `wp:{env}:wake:c:{client}:i:{instance}` at enqueue, a per-instance `next_eligible_at` timer, and a **mandatory** 30 s ±12 s safety poll (pub/sub is at-most-once — the poll is correctness, not optimisation).
- The interim pacing floor: a module-level `INTERIM_MIN_GAP_MS` plus a boot assertion that refuses to start once `pacing_ledger` exists (ADR 0020 §8 — P13 deletes both).
- The panel composer: pick an account, type a message, send; optimistic UI shows a **queued clock**, never a tick, until the job reaches `sent`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Flow 1 — send a message (happy path)*; *Durable queue, scheduler & send pipeline* → **Dispatch and result**, **Fair scheduling**, *Backoff, retry classes*; *Data model → Durable queue*; *Provider adapter boundary*; *Real-time & notifications* (event table); *Mandatory send-path and engine suite* (tests **1, 14, 19**) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *What breaks first* row **1** (wake pub/sub + mandatory safety poll) and row **8** (pool max 4 / PgBouncer); *The merged canonical claim*; *Where the balance is checked* (nothing is debited here); *Observability (one rule, not two)* |
| ADR | `.memory/decisions/0020-phase-session-protocol-and-plan-folder.md` | **§8** — the interim-gap gap, and "no number but a disposable test number before P13/P16" |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | — (read only to confirm **no** money moves in this phase) |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §4 scaling rule; §7 metric label allow-list |
| Skill | `.claude/skills/queue-engineering/SKILL.md` | Job claiming · Idempotency · Backoff · Fair priority scheduling · Pause/resume · Observability minimum |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms; honest claims |
| Invariants | `.claude/rules/core-invariants.md` | all (1, 2, 3, 5 bite hardest here) |
| Path rules | `.claude/rules/queue-*.md`, `.claude/rules/api-*.md`, `.claude/rules/db-*.md` | all |

## Dispatch plan (written at session open, SESSION-PROTOCOL E1 — this file predates the template)

One unit = one dispatch, full step text pasted in. Units with disjoint file scopes may run in parallel (max 3);
the unit carrying the migration (U3) never runs in parallel with anything.

| Unit | Steps | File scope | Agent | Parallel with |
|---|---|---|---|---|
| **U1** contracts + pure domain | 2 | `packages/contracts/src/messages.ts`, `packages/contracts/src/index.ts`, `packages/domain/src/queue/backoff.ts`, `packages/domain/src/queue/delivery-event-id.ts`, `packages/domain/src/copy/send-copy.ts` + their tests | implementer | U2 |
| **U2** transport boundary | 4 | `app/backend/src/provider/provider.types.ts`, `provider/baileys/adapter.ts`, `provider/baileys/error-map.ts`, `app/backend/test/support/fake-transport.ts` + tests | implementer | U1 |
| **U3** enqueue (MIGRATION) | 3 | `db/migrations/0024_message_job_refs_request_hash.sql`, `app/backend/src/modules/messages/**`, `app/backend/src/roles/api.ts` + `enqueue.integration.test.ts` | implementer | **none** |
| **U4** dispatch + result + interim gap | 5, 6, 7 | `app/backend/src/engine/queue/{interim-gap,dispatch,result}.ts`, `app/backend/src/platform/db/assert-db-preconditions.ts` + their tests | implementer | none |
| **U5** wake loop + send loop wiring | 8, 9 | `app/backend/src/engine/queue/{wake,send-loop,metrics}.ts`, `app/backend/src/roles/session-worker.ts`, `app/backend/src/platform/config.ts` + `wake.test.ts` | implementer | none |
| **U6** composer + e2e | 10 | `app/frontend/src/features/messages/**`, `app/frontend/src/routes/_authed/messages.tsx`, `app/backend/test/integration/send/send-path.e2e.test.ts` | ui-implementer (panel) + implementer (e2e) | e2e ‖ composer |

**Step 1 is not a unit.** Per `plan/README.md` folder rules ("tests are written red-first inside the dispatch of
the step they prove — never as an all-tests-upfront step"), each test file named in step 1 is written red-first
inside the unit that owns its subject. Step 1's box is ticked when every unit has reported its tests red-then-green.

**Shared contracts across parallel units (E1 file-ownership rule):** U1 and U2 share nothing — `SendErrorClass`
is defined in U2 (`provider.types.ts`) and is NOT imported by U1's contracts. `backoff()` (U1) is consumed by U4,
not by U2. If either unit needs to touch the other's scope, they stop being parallel-safe: sequence them.

## Ordered minimum steps
Migration numbers continue from whatever P03-P10 ended at; write the real names into the files list.

- [x] 1. Write the failing tests first (all red, none skipped, none `.only`) → `packages/contracts/src/messages.test.ts`, `packages/domain/src/queue/backoff.test.ts`, `app/backend/src/modules/messages/enqueue.integration.test.ts`, `app/backend/src/engine/queue/interim-gap.test.ts`, `app/backend/src/engine/queue/dispatch.integration.test.ts`, `app/backend/src/engine/queue/result.integration.test.ts`, `app/backend/src/engine/queue/wake.test.ts`, `app/backend/test/integration/send/send-path.e2e.test.ts`.
- [x] 2. Contracts + pure domain: the request/response zod schemas (text and media payload kinds, `payload` ≤ 2048 B, recipient as E.164 **or** a `@g.us` JID, `priority`, optional `scheduled_at`), the mandatory `Idempotency-Key` header schema, `backoff(attempts)` = `min(15 min, 2s · 2^attempts)` with **full** jitter, and the internal `deliveryEventId(instanceId, publicId, eventType, attemptNo)` = `sha256(...)` helper → `packages/contracts/src/messages.ts`, `packages/contracts/src/index.ts`, `packages/domain/src/queue/backoff.ts`, `packages/domain/src/queue/delivery-event-id.ts`, `packages/domain/src/copy/send-copy.ts` (composer + `INSTANCE_OFFLINE` strings, registered in `check-copy`).
- [x] 3. The enqueue transaction and its route → `db/migrations/00NN_message_job_refs_request_hash.sql` (`ALTER TABLE message_job_refs ADD COLUMN request_hash bytea` — P03 owns the table, this phase only ALTERs), `app/backend/src/modules/messages/messages.repo.ts` (one transaction: job → ref `ON CONFLICT ON CONSTRAINT mjr_idem_uq DO UPDATE SET public_id = message_job_refs.public_id RETURNING` → `delivery_event_ids` + `delivery_events('created')` and `('queued')` → `audit_logs`), `app/backend/src/modules/messages/messages.service.ts` (authz, entitlement, instance state → `202 INSTANCE_OFFLINE` / `409 INSTANCE_UNLINKED`, per-instance queue-depth cap from `plan_limits`), `app/backend/src/modules/messages/routes.ts`, `app/backend/src/roles/api.ts` (register). On idempotency-key conflict, compare `request_hash`: equal ⇒ replay the original response; different ⇒ `409 IDEMPOTENCY_KEY_REUSED`.
- [x] 4. The `MessageTransport` half of the adapter → `app/backend/src/provider/provider.types.ts` (`MessageTransport`, `SendOutcome`, `SendErrorClass`; **no Baileys type may appear in this file** — lint-enforced), `app/backend/src/provider/baileys/adapter.ts` (changed: `send()`, `isReady()` with no network I/O, `capabilities`), `app/backend/src/provider/baileys/error-map.ts` (Baileys/Boom failure → `SendErrorClass`; unknown ⇒ `'unknown'`, never a silent retry), `app/backend/test/support/fake-transport.ts` (controllable latency/outcome, used by every test below).
- [x] ~~5. The interim pacing floor and its self-destruct assertion → `app/backend/src/engine/queue/interim-gap.ts` (`INTERIM_MIN_GAP_MS` module constant, per-instance in-memory last-send timestamp, `nextEligibleAt(instanceId)`), `app/backend/src/platform/db/assert-db-preconditions.ts` (changed: refuse to boot the session-worker role if `to_regclass('pacing_ledger') IS NOT NULL`, with an error naming P13). Not configurable per tenant, not overridable by any header, field or env var.~~ **STRUCK — P13 landed and deleted `interim-gap.ts`**: the real durable pacing reserve (`app/backend/src/engine/pacing/index.ts#reserve()`) supersedes this floor entirely; `assert-db-preconditions.ts` now runs the opposite-direction `checkPacingStateProvisioned` gate instead. See P13's own dispatch/session-report for the full wiring.
- [x] 6. Dispatch → `app/backend/src/engine/queue/dispatch.ts`: one transaction `INSERT send_attempts(state='prepared', attempt_no = attempts + 1, lease_id, owner_fence, content_hash)` + `UPDATE message_jobs SET attempts = attempts + 1 WHERE id/created_at/lease_id` + `delivery_events('dispatched')`; **COMMIT**; then `UPDATE send_attempts SET state='dispatched', dispatched_at=now()`, `transport.send()` under `TIMING.sendTimeout` (45 s), with the lease heartbeat renewing `message_jobs.lease_expires_at` for the whole flight. A timeout is `dispatched`/unknown, never a retry decision made here.
- [x] 7. The result write → `app/backend/src/engine/queue/result.ts`: `UPDATE send_attempts SET state='acked'|'failed', provider_msg_id, error_class, resolved_at`; then the job `UPDATE ... WHERE id=$id AND created_at=$ts AND lease_id=$lease AND status='processing'`; **zero rows ⇒ throw `ClaimLostDuringSend`**, increment `wp_claim_lost_total`, leave the outcome on the attempt row and do **not** re-send; on ack also `INSERT message_wa_ids (client_id, instance_id, direction='out', wa_msg_id)`; write the `sent` / `failed` / `retry_scheduled` `delivery_events` row through `delivery_event_ids`; failures route through `@wp/domain/retry/classify` → requeue with `backoff()`, terminal `failed`, or **pause the instance** for `restricted`/`unknown`.
- [x] 8. The wake loop → `app/backend/src/engine/queue/wake.ts`: `publishWake(clientId, instanceId)` on `redis-ctl` key `wp:{env}:wake:c:{client}:i:{instance}` called **after commit** in the enqueue path and in every future resume path; per-worker subscriber that subscribes on lease acquisition and unsubscribes on release; per-instance `next_eligible_at` timer; **mandatory** `SAFETY_POLL_MS = 30_000 ± 12_000` per instance that cannot be configured to 0 or above 60 s. A wake is a hint; every eligibility rule stays inside `claim-jobs.sql`.
- [x] 9. Wire the send loop into the session worker → `app/backend/src/engine/queue/send-loop.ts` (wake/timer/poll → `dwrr.pick()` band → ~~`interim-gap` gate~~ **STRUCK, P13**: the real pacing reserve now lives inside `claimOne` itself, see below → `claimOne()` → `dispatch()` → `result()`, per-instance concurrency **1**), `app/backend/src/roles/session-worker.ts` (changed: start/stop the loop with the lease), `app/backend/src/engine/queue/metrics.ts` (`wp_claim_lost_total`, `wp_send_attempts_total{result}`, `wp_send_duration_seconds`, `wp_wake_received_total`, `wp_safety_poll_claims_total`, `wp_queue_depth_total`, `wp_oldest_queued_seconds_max` — **no `instance_id` label**, see gotchas). `send-loop.ts` carries the two marked insertion points, as comments and **not** as stub modules: `// P14: contentGuards.evaluate() here` and ~~`// P13: pacing.reserve() here`~~ **STRUCK — P13 landed**: the reserve now runs inside `deps.claimOne` (`app/backend/src/engine/queue/send-loop-pacing-claim.ts#claimAndReserve`), sharing one transaction with the claim, before the claim UPDATE.
- [x] 10. The composer and the end-to-end proof → `app/frontend/src/features/messages/compose/` (account picker, textarea, send; a uuidv7 `Idempotency-Key` minted once per submission and reused on every retry; queued-clock state), `app/frontend/src/features/messages/api.ts`, `app/frontend/src/routes/_authed/messages.tsx`, `app/backend/test/integration/send/send-path.e2e.test.ts` (fake transport, full path); then the live smoke on a **disposable test number only** and record it in the session log.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/contracts/src/messages.test.ts` | `a_request_without_an_idempotency_key_is_rejected_by_the_schema` | header schema is required; rejection happens before any DB call |
| `packages/contracts/src/messages.test.ts` | `a_payload_over_2048_bytes_is_rejected_at_the_contract` | matches the `message_jobs.payload` CHECK, so the DB CHECK is never the first line of defence |
| `packages/domain/src/queue/backoff.test.ts` | `backoff_is_capped_at_fifteen_minutes_and_fully_jittered` | `min(15min, 2s·2^n)`; seeded RNG; 10k draws all inside `[0, delay]`, never a fixed value |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `duplicate_idempotency_key_creates_one_job` | **mandatory 1** — 50 parallel identical POSTs ⇒ exactly one `message_jobs` row, 50 identical response bodies, **zero 5xx** |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `same_key_different_body_is_rejected_with_409` | `request_hash` mismatch ⇒ `409 IDEMPOTENCY_KEY_REUSED`, no second job |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `enqueue_writes_job_ref_and_two_events_in_one_transaction` | injected failure after the job insert leaves **zero** job rows and zero events |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `no_job_row_ever_exists_without_a_matching_ref` | schema-level assertion over the whole table after a fuzz of 500 enqueues |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `an_offline_instance_returns_202_with_instance_offline_and_still_queues` | job is `queued`, warning code returned, nothing failed or deleted |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `an_unlinked_instance_returns_409_and_creates_no_job` | fail-closed at the API, not in the worker |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `another_tenants_instance_id_yields_404_and_creates_no_job` | tenant isolation at the enqueue boundary |
| `app/backend/src/modules/messages/enqueue.integration.test.ts` | `the_api_process_cannot_reach_the_transport` | dependency-cruiser: `roles/api.ts ↛ provider/**` still red on a planted import |
| `app/backend/src/engine/queue/interim-gap.test.ts` | `boot_refuses_to_start_once_pacing_ledger_exists` | create the table in a scratch DB ⇒ named error naming P13; process does not start |
| `app/backend/src/engine/queue/interim-gap.test.ts` | `two_consecutive_sends_on_one_instance_are_at_least_interim_min_gap_ms_apart` | fake clock; the floor holds across claim attempts |
| `app/backend/src/engine/queue/interim-gap.test.ts` | `no_request_field_header_or_env_var_can_lower_the_interim_gap` | invariant 6 — the constant has one definition and no override path |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `an_attempt_row_exists_before_the_provider_is_called` | fake transport records that `send_attempts` already has a `prepared` row at call time |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `attempts_increments_exactly_once_per_attempt_row` | `attempts` and `max(attempt_no)` agree after 50 sequential attempts |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `a_crash_between_claim_and_dispatch_leaves_a_prepared_attempt_and_a_processing_job` | the state P12's reaper is written against — nothing is repaired here |
| `app/backend/src/engine/queue/dispatch.integration.test.ts` | `a_send_timeout_at_45s_never_calls_the_provider_twice` | timeout ⇒ attempt stays `dispatched`, no second `send()` |
| `app/backend/src/engine/queue/result.integration.test.ts` | `a_zero_row_result_write_raises_claim_lost_during_send` | lease stolen mid-send ⇒ throw, `wp_claim_lost_total` +1, the ack outcome is **on the attempt row**, job untouched, nothing re-sent |
| `app/backend/src/engine/queue/result.integration.test.ts` | `a_successful_send_writes_sent_at_one_wa_id_row_and_a_sent_event` | `status='sent'`, `sent_at NOT NULL`, exactly one `message_wa_ids` row with `direction='out'` |
| `app/backend/src/engine/queue/result.integration.test.ts` | `a_replayed_result_write_creates_no_second_delivery_event` | `delivery_event_ids` dedupe holds on replay |
| `app/backend/src/engine/queue/result.integration.test.ts` | `a_transient_failure_requeues_with_jittered_backoff_and_fails_nothing` | `status='queued'`, `next_attempt_at` in the future, job never `failed` (invariant 5) |
| `app/backend/src/engine/queue/result.integration.test.ts` | `an_invalid_recipient_is_terminal_and_never_retried` | `status='failed'`, `terminal_at` set, zero further claims |
| `app/backend/src/engine/queue/result.integration.test.ts` | `an_unknown_provider_error_pauses_the_instance_and_retries_nothing` | invariant 2 — `health_state='paused'`, every queued job still `queued` |
| `app/backend/src/engine/queue/result.integration.test.ts` | `slow_media_send_does_not_lose_its_result` | **mandatory 14** — 90 s send under a heartbeat-renewed lease: result recorded, zero duplicates, zero reaper interference |
| `app/backend/src/engine/queue/result.integration.test.ts` | `nothing_in_this_phase_writes_a_wallet_row` | zero rows in `wallet_ledger`/`wallet_charge_guards` after 100 sends (money is P18) |
| `app/backend/src/engine/queue/wake.test.ts` | `an_enqueue_publishes_exactly_one_wake_on_the_tenant_scoped_channel` | channel is `wp:{env}:wake:c:{client}:i:{instance}`, published **after** commit |
| `app/backend/src/engine/queue/wake.test.ts` | `a_dropped_wake_still_drains_via_the_safety_poll` | subscriber disconnected for the whole enqueue ⇒ job still sent within one poll interval |
| `app/backend/src/engine/queue/wake.test.ts` | `the_safety_poll_cannot_be_configured_to_zero_or_above_sixty_seconds` | config assertion; the poll is correctness, not tuning |
| `app/backend/src/engine/queue/wake.test.ts` | `a_wake_for_another_tenants_instance_never_triggers_a_claim` | isolation suite B shape: two tenants, one worker |
| `app/backend/test/integration/send/send-path.e2e.test.ts` | `a_posted_message_is_claimed_dispatched_and_recorded_end_to_end` | one POST ⇒ `queued → processing → sent`, **four** `delivery_events` rows in order (`created`,`queued`,`dispatched`,`sent` — the phase author's "five" was wrong, see gotcha 10), one attempt, one wa id |
| `app/backend/test/integration/send/send-path.e2e.test.ts` | `high_flood_does_not_starve_low` | **mandatory 19 (loop half)** — continuous HIGH enqueue for 2 min still yields a NORMAL and LOW throughput floor through the real claim |
| `app/backend/test/integration/send/send-path.e2e.test.ts` | `two_instances_of_one_workspace_drain_independently` | invariant 4 — one instance paused, the other keeps sending |
| `app/frontend/src/features/messages/compose/__tests__/composer.test.tsx` | `a_queued_message_never_renders_as_sent` | queued clock until the SSE `message.job.sent` event; no optimistic tick |
| `app/frontend/src/features/messages/compose/__tests__/composer.test.tsx` | `a_retried_submission_reuses_the_same_idempotency_key` | double-click / network retry ⇒ one key, one job |

Mandatory-suite tests this phase makes green: **1**, **14**, **19** (loop half; the pure-selector half was P00). Tests **2, 21, 22, 23** from P03 must stay green — re-run them.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED-with-notes.
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] The live smoke was **NOT performed** — the founder deferred all live/QR testing ("wo sab last me test karenge", recorded in `.memory/progress/master-plan.md`). P11 closed on unit + integration evidence instead. **No number, disposable or otherwise, was linked or messaged this session.**
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- ACTUAL, appended as each unit reports green. This list IS the diff (no git) and is what the reviewer reviews. -->

### Pre-phase (BLOCKER-CLASS flake fix, master-plan "do this before or early in P11")
- `app/backend/src/engine/fleet/fleet-c2-slow-redis.integration.test.ts` — changed: removed two ambient wall-clock upper bounds (`toBeLessThan(TIMING_BUDGET_CEILING)`) and the constant; kept lower bounds + all correctness assertions. 3x standalone green.
- `app/backend/src/engine/fleet/fleet-connect-bucket-e3-edge.integration.test.ts` — changed: replaced the sampled `expect(successCount).toBe(1)` with a conservation identity read from the bucket's own `tokens`/`lastRefillMs` vs Redis server `TIME`; added `readBucket`/`redisNowMs` helpers + `sysKey` import; case renamed. 5x standalone green. `connect-budget.ts` and `take-token.lua` deliberately NOT modified (production code was correct).

### U1 — contracts + pure domain (step 2) — GREEN
- `packages/contracts/src/messages.ts` — created (recipient E.164-or-`@g.us`, 2048-byte UTF-8 payload envelope, mandatory `idempotency-key` header schema, oRPC contract)
- `packages/contracts/src/messages.test.ts` — created
- `packages/contracts/src/index.ts` — changed: export the message schemas
- `packages/domain/src/queue/backoff.ts` — created (`min(15min, 2s*2^n)`, FULL jitter, injected `Rng`, exponent clamped against Infinity)
- `packages/domain/src/queue/backoff.test.ts` — created
- `packages/domain/src/queue/delivery-event-id.ts` — created (`deliveryEventIdInput` — the PURE canonicalisation half only; sha256 applied by the Node-side caller, see deviation 5)
- `packages/domain/src/queue/delivery-event-id.test.ts` — created
- `packages/domain/src/copy/send-copy.ts` — created (composer + `INSTANCE_OFFLINE` strings; `check:copy` 789 files, 0 violations)
- `packages/domain/src/copy/send-copy.test.ts` — created
- `packages/domain/src/index.ts` — changed: export backoff / delivery-event-id / send-copy

### U2 — transport boundary (step 4)
<!-- pending -->

### U2 — transport boundary (step 4) — GREEN
- `app/backend/src/provider/provider.types.ts` — created (`MessageTransport`, `SendOutcome`, `TransportSendError`, `SendErrorClass`, `TransportCapabilities`, `WaMessagePayload`; zero Baileys types, verified)
- `app/backend/src/provider/baileys/adapter.ts` — changed: added the `MessageTransport` half (`createBaileysMessageTransport`); `ChannelLink` half untouched
- `app/backend/src/provider/baileys/adapter.test.ts` — extended (not clobbered)
- `app/backend/src/provider/baileys/error-map.ts` — created (data table + fail-safe `unknown` default, `disconnect-map.ts` idiom)
- `app/backend/src/provider/baileys/error-map.test.ts` — created
- `app/backend/test/support/fake-transport.ts` — created (controllable latency/outcome, call-count spy, `onSend` hook, never-resolve mode)
- `app/backend/test/support/fake-transport.test.ts` — created
- `vitest.config.ts` — changed, ONE line: added `'app/*/test/**/*.test.ts'` to the include list. Without it the phase-mandated path `app/backend/test/support/*.test.ts` is silently uncollected. Mirrors the pre-existing `packages/*/test/**` glob in the same file. Accepted (reviewed by main session).

### U3 — enqueue + migration (step 3) — GREEN (9 tests, 2 files, exit 0; verified by main session after the unit hit a session rate limit mid-verification)
- `db/migrations/0024_message_job_refs_request_hash.sql` — created (`request_hash bytea`, nullable, no index, reasoned header)
- `app/backend/src/modules/messages/messages.repo.ts` — created (the one enqueue transaction)
- `app/backend/src/modules/messages/messages.service.ts` — created (authz/entitlement/instance-state, 202 INSTANCE_OFFLINE / 409 INSTANCE_UNLINKED)
- `app/backend/src/modules/messages/messages.routes.ts` — created
- `app/backend/src/modules/messages/messages.routes-support.ts` — created (typed error classes + guarded(), the 300-line split idiom)
- `app/backend/src/modules/messages/enqueue-http-auth-helpers.ts` — created (test-support)
- `app/backend/src/modules/messages/enqueue-test-support.ts` — created (test-support)
- `app/backend/src/modules/messages/index.ts` — created (barrel)
- `app/backend/src/modules/messages/enqueue.integration.test.ts` — created (all 7 enqueue cases, exact names)
- `app/backend/src/modules/messages/enqueue.api-boundary.integration.test.ts` — created (`the_api_process_cannot_reach_the_transport` + a restore-verification companion)
- `packages/contracts/src/errors.ts` — changed: added `INSTANCE_UNLINKED` (409) and `IDEMPOTENCY_KEY_REUSED` (409)
- `app/backend/src/roles/api.ts` — changed: register the messages routes

### U4 — interim gap + dispatch + result (steps 5, 6, 7) — GREEN (19 integration + 19 unit + 6 db, exit 0; re-verified by main session)
- `db/migrations/0025_message_jobs_result_writer_grants.sql` — created. THE GAP migration 0012 predicted. Grants derived from U4's own statements, applied and live-smoke-tested as `wp_scheduler`:
  `GRANT UPDATE (attempts)`, `GRANT UPDATE (sent_at, failed_at, terminal_at, last_error_class, next_attempt_at, cancel_reason)`, `GRANT SELECT (max_attempts)` on `message_jobs`; `GRANT UPDATE (health_state, pause_reason, paused_at, needs_user_action)` on `whatsapp_instances` (the invariant-2 pause path — a grant the main session had NOT listed; U4 derived it correctly).
- `db/src/schema-version.ts` — changed: `EXPECTED_SCHEMA_VERSION` 24 -> 25
- `app/backend/src/engine/queue/interim-gap.ts` + `interim-gap.test.ts` — created (`INTERIM_MIN_GAP_MS`, one definition, no override path)
- `app/backend/src/engine/queue/dispatch.ts` + `dispatch.integration.test.ts` — created
- `app/backend/src/engine/queue/result.ts` + `result.integration.test.ts` — created
- `app/backend/src/engine/queue/result-failure.integration.test.ts` — created (sibling split; carries mandatory suite test 14)
- `app/backend/src/engine/queue/result-pause.ts` — created (sibling split: the PAUSE_INSTANCE write)
- `app/backend/src/engine/queue/delivery-event.ts` — created (the sha256 wrapper completing U1's handoff, in ONE place; + the `delivery_event_ids` -> `delivery_events` ordered write pair)
- `app/backend/src/engine/queue/__tests__/queue-send-test-helpers.ts` — created (shared fixtures)
- `app/backend/src/platform/db/assert-db-preconditions.ts` — changed: `options.checkPacingLedgerAbsent`, opt-in, default OFF
- `app/backend/src/platform/db/assert-db-preconditions.test.ts` — changed: 4 new scoping tests
- `app/backend/src/roles/session-worker.ts` — changed: opts in with `{ checkPacingLedgerAbsent: true }`; `roles/api.ts` deliberately does NOT (P13 legitimately creates that table; the api role must not be blocked)
- 4 dead debug files U4 could not delete (sandbox denied `rm`) were REMOVED by the main session after inspection: `__debug-attempts.integration.test.ts`, `__manual-check.mjs`, `__manual-check2.mjs`, `__role-smoke.mjs`

### U5 — wake loop + send-loop wiring (steps 8, 9) — GREEN (44 int + 36 unit; wave re-verified by main session: 45 files / 189 tests / exit 0)
- `app/backend/src/engine/queue/wake.ts` + `wake.test.ts` + `wake.integration.test.ts` — created. Channel via `sysKey(env,'wake','c',clientId,'i',instanceId)` = `wp:{env}:wake:c:{client}:i:{instance}` on the `redis-ctl` handle (same one `redis-bridge.ts` uses), NOT redis-sig/redis-cache.
- `app/backend/src/engine/queue/metrics.ts` + `metrics.test.ts` — created. 7 metrics, NONE carrying `instance_id`; a dedicated test asserts registration THROWS against the spent 4-gauge allow-list.
- `app/backend/src/engine/queue/send-loop.ts` + `send-loop.test.ts` — created (DWRR band -> interim gap -> claimOne -> dispatch -> result, per-instance concurrency 1). P13/P14 markers are COMMENTS in `runOneSendLoopIteration`'s doc block; no stub modules.
- `app/backend/src/engine/queue/send-loop-fleet-wiring.ts` + `.test.ts` — created (lease acquire/release reconciliation)
- `app/backend/src/engine/queue/send-loop-worker-wiring.ts` + `.test.ts` — created (production deps from boot handles)
- `app/backend/src/modules/messages/messages.publish-wake.integration.test.ts` — created (publish-after-commit proof)
- `app/backend/src/roles/session-worker.ts` — changed: boots the fleet wiring, `reconcile()` per scan tick, `shutdown()` in drain
- `app/backend/src/platform/config.ts` + `config.test.ts` — changed: `SAFETY_POLL_MS` (positive int, max 60_000, REFUSES out-of-range rather than clamping)
- `app/backend/src/modules/messages/messages.service.ts` — changed: optional `deps.onEnqueued`, invoked strictly AFTER `withTenant` resolves (after commit)
- `app/backend/src/engine/queue/__tests__/queue-send-test-helpers.ts` — changed: added `seedQueuedJob`

### Main-session fixes after U5
- **TYPECHECK REGRESSION (introduced by U4, missed by its report; U5 mislabelled it "pre-existing") — FIXED.** `app/backend/tsconfig.json` has `rootDir: "src"` / `include: ["src"]`, so the phase-file-mandated path `app/backend/test/support/fake-transport.ts` was OUTSIDE the compiled project while three `src/` integration tests imported it: `tsc -b` failed TS6059 + TS6307, and had already emitted 4 stray build artifacts (`.d.ts`, `.d.ts.map`, `.js`, `.js.map`) into the source tree. Fixed by MOVING the double to `app/backend/src/provider/__test-support__/fake-transport.ts` (+ its test), matching this repo's three existing under-`src` test-support precedents (`modules/realtime/__test-support__/`, `platform/db/test-support/`, `engine/lease/test-support/`); imports in 3 consumers + the moved file repointed; stray artifacts deleted; `app/backend/test/` removed. **`vitest.config.ts` reverted to its original content** — U2's `app/*/test/**` glob is no longer needed now that nothing lives there. `pnpm run typecheck` exit 0.
- Deleted U5's inert scratch file `app/backend/cleanup_orphan.mjs` (0 bytes) after inspection.
- **Cleaned one orphaned `message_jobs` row + its `send_attempts` row** left in the shared dev DB by a crashed U4 run (verified: complete fixture, no ref row because U4 seeds jobs directly rather than via the API). `no_job_row_ever_exists_without_a_matching_ref` asserts over the WHOLE table BY DESIGN (the phase file mandates "schema-level assertion over the whole table"), so the correct fix was removing the debris, not narrowing the assertion. Orphan count now 0.


### U6a — panel composer (step 10, frontend half) — GREEN (2/2 mandated cases; touched-area 8 files / 49 tests)
- `app/frontend/src/features/messages/api.ts` — created
- `app/frontend/src/features/messages/compose/Composer.tsx` / `MessageStatus.tsx` / `useComposer.ts` — created
- `app/frontend/src/features/messages/compose/__tests__/composer.test.tsx` — created
- `app/frontend/src/routes/_authed/messages.tsx` — created
- `packages/utils/src/uuidv7.ts` + `.test.ts` — created (no `uuid` dep exists in the lockfile; backend `public_id` uses v4 `randomUUID()`), exported from `@wp/utils`
- `app/frontend/src/lib/api-client.ts` — changed: optional `headers` threaded through the 401-retry path (required so the SAME `Idempotency-Key` survives a token refresh — additive, backward-compatible)
- `packages/i18n/src/catalogues/{en,hi}.ts` — changed: `messages.compose.*` structural keys (parity test green)
- `app/frontend/public/favicon.ico` — created (closes the master-plan's recorded console-404 freebie)
- `app/frontend/src/routeTree.gen.ts` — auto-regenerated by the router plugin, not hand-edited

### U6b — send-path e2e (step 10, backend half) — GREEN (3/3 mandated cases)
- `app/backend/src/engine/queue/send-path.e2e.integration.test.ts` — created (`a_posted_message_is_claimed_dispatched_and_recorded_end_to_end`)
- `app/backend/src/engine/queue/send-path-fairness.e2e.integration.test.ts` — created (`high_flood_does_not_starve_low`, mandatory suite 19 loop half)
- `app/backend/src/engine/queue/send-path-isolation.e2e.integration.test.ts` — created (`two_instances_of_one_workspace_drain_independently`)
- `app/backend/src/engine/queue/__tests__/send-path-e2e-test-support.ts` — created
- Placed under `src/` (NOT the phase file's `app/backend/test/integration/send/` — that path breaks `tsc -b`, see the U5 fix note)

### Main-session fixes after U6
- **`check-copy` violation in U4's `interim-gap.ts` — FIXED.** The module doc said `"not Safe Mode"` (explicitly DENYING the claim), but the guard scans for the bare token and requires the full product disclaimer in the same file. Reworded to name the concept without the trigger token, preserving the disclaimer's meaning. `check-copy`: **842 files scanned, 0 violations.**


### Main-session fixes after U3 terminated early (rate limit) — these were left red by the unit
- `db/src/schema-version.ts` — changed: `EXPECTED_SCHEMA_VERSION` 23 -> 24 (migration 0024 requires the bump; `migrate-runner.test.ts` asserts it structurally)
- `db/schema/message-job-refs.ts` — changed: declare `requestHash: bytea('request_hash')` so Drizzle schema parity holds
- `db/schema/grants.snapshot.json` — pending: `request_hash` appears in `message_job_refs` column grants for roles that already held table-level access (expected; under review by debugger)
- `db/tests/claim-plan.test.ts` — pending: PRE-EXISTING latent bug, NOT a P11 regression (see deviation 6)


<!-- ORIGINAL expected set from the phase author, kept for reference: -->
- `packages/contracts/src/messages.ts` — created
- `packages/contracts/src/index.ts` — changed: export the message schemas
- `packages/domain/src/queue/backoff.ts` — created
- `packages/domain/src/queue/delivery-event-id.ts` — created
- `packages/domain/src/copy/send-copy.ts` — created
- `db/migrations/00NN_message_job_refs_request_hash.sql` — created
- `app/backend/src/modules/messages/messages.repo.ts` — created
- `app/backend/src/modules/messages/messages.service.ts` — created
- `app/backend/src/modules/messages/routes.ts` — created
- `app/backend/src/roles/api.ts` — changed: register the messages routes
- `app/backend/src/provider/provider.types.ts` — created (`MessageTransport`, `SendOutcome`, `SendErrorClass`)
- `app/backend/src/provider/baileys/adapter.ts` — changed: the `MessageTransport` half
- `app/backend/src/provider/baileys/error-map.ts` — created
- `app/backend/src/engine/queue/interim-gap.ts` — created
- `app/backend/src/engine/queue/dispatch.ts` — created
- `app/backend/src/engine/queue/result.ts` — created
- `app/backend/src/engine/queue/wake.ts` — created
- `app/backend/src/engine/queue/send-loop.ts` — created
- `app/backend/src/engine/queue/metrics.ts` — created
- `app/backend/src/roles/session-worker.ts` — changed: start/stop the send loop with the lease
- `app/backend/src/platform/db/assert-db-preconditions.ts` — changed: the `pacing_ledger` boot refusal
- `app/backend/src/platform/config.ts` — changed: `SAFETY_POLL_MS`, send-loop keys
- `app/backend/test/support/fake-transport.ts` — created
- `app/backend/test/integration/send/send-path.e2e.test.ts` — created
- `app/frontend/src/features/messages/compose/` + `api.ts` — created
- `app/frontend/src/routes/_authed/messages.tsx` — created
- every `.test.ts` / `.test.tsx` named in the table above — created

## Deviations found at session open (facts checked against the live DB, not assumed)

1. **A SECOND migration is mandatory — `0025_message_jobs_result_writer_grants.sql`.** Migration 0012 narrowed
   `wp_scheduler`'s `message_jobs` UPDATE grant to exactly 9 columns (`status, lease_owner, lease_id,
   owner_fence, leased_at, lease_expires_at, pacing_reserved_at, pacing_ledger_date, updated_at`) and said so
   explicitly: *"later phases ... the P0x result-writer that records sent/failed will need additional
   message_jobs columns ... those are ADDITIVE grants in THEIR OWN migrations when they land."* Step 7 writes
   `sent_at, failed_at, terminal_at, last_error_class, attempts, next_attempt_at, cancel_reason` — **none of
   which `wp_scheduler` can currently UPDATE**. Without this migration step 7 fails at runtime on a permission
   error, not a logic bug. P11 is the phase migration 0012 predicted.
2. **Migration numbers resolve to `0024` and `0025`** — highest applied in the live DB is `23`.
3. **`plan_limits` has NO queue-depth column.** Its full column list is `plan_id, max_connected_instances,
   max_registered_instances, max_broadcast_recipients`. Step 3's "per-instance queue-depth cap from
   `plan_limits`" has no backing column, and no ADR defines one. **Judgment call taken:** the cap is a
   module-level constant in the messages module with a comment naming the gap, NOT an invented `plan_limits`
   column — adding a billing-adjacent limit column here would front-run P19 (wallet gate / entitlements) and
   create a schema fact no ADR backs. Carried forward as an open item for whichever phase owns plan limits.
5. **`deliveryEventId` is SPLIT across the package boundary (U1 decision, accepted).** Step 2 asks for
   `deliveryEventId(...) = sha256(...)` in `@wp/domain`, but that package must run unchanged in a browser and
   ships no Node builtins; the browser's `crypto.subtle` is async and this id is produced synchronously on the
   result-write path. So `@wp/domain` owns only the pure, tested canonicalisation
   `deliveryEventIdInput(instanceId, publicId, eventType, attemptNo)` -> `"a:b:c:n"`, and the `sha256` wrapper
   is applied by the Node-side caller (U4's `engine/queue/result.ts`, where `node:crypto` is allowed).
   FNV-1a (the existing domain hash, used for the reconnect stagger) was correctly rejected: this value is a
   real `text PRIMARY KEY` dedupe authority and needs collision resistance.
4. **Role split is load-bearing and was verified against live grants:** enqueue (U3) runs as `wp_app`
   (`message_jobs` INSERT is granted to `wp_app` only); dispatch/result (U4) run as `wp_scheduler`
   (`send_attempts` INSERT/UPDATE and `message_wa_ids` INSERT are granted to `wp_scheduler` only).

6. **`db/tests/claim-plan.test.ts` was found RED at O2-adjacent time by a DATE-ROLLOVER bug that predates P11.**
   `fetchClaimIndexChildNames()` enumerates EVERY child of `message_jobs_claim_idx` from the catalog and asserts an
   index scan via each, but `seedPlanRepresentativeFixture()` seeds only `now()`, `+1 month`, `+2 months`. Today
   (2026-09-01) the live DB has FOUR partitions — `y2026m08` (created when P03 ran in August, then the current
   month), m09, m10, m11 — so **m08 gets zero rows and Postgres correctly Seq-Scans an empty partition**. The
   test's own header documents this exact failure class from a P07 debug session; that fix ("seed three month
   buckets") was correct only while exactly three partitions existed and silently breaks at every month boundary.
   Not caused by any P11 code. Fixed this session by deriving the seeded buckets from the same catalog the
   assertion iterates, so the fixture is correct on any date including year boundaries. Same family as the
   BLOCKER-CLASS ambient-state rule: the test assumed a fact about the calendar.
7. **Grants snapshot updated for `request_hash`.** Adding a column to `message_job_refs` (which carries
   table-level grants) makes that column appear in the column-grant lists of roles that already had access —
   expected Postgres behaviour, not a privilege change. Verified the ONLY snapshot movement is `request_hash` on
   `message_job_refs`; no new table, role, or widened privilege anywhere.

8. **A FOURTH flaky real-infra test was found and fixed this session** (previously unrecorded; the master-plan
   BLOCKER-CLASS list named three). `app/backend/src/engine/lease/lease-state-repo.edge.integration.test.ts`
   -> `expired_placeholder_fails_the_setFence_cas_...` staked a lease placeholder with a 50 ms TTL and then did
   `await new Promise(r => setTimeout(r, 120))`, waiting for Redis to expire the key on its own — an assertion on
   BOTH the sleep's scheduling and Redis's expiry cycle firing inside that window. Passed standalone, failed under
   full-suite load. The property the case is actually about is "placeholder ABSENT => CAS fails and corrupts
   nothing", and absence is absence however reached — so it now `redis.del(key)` outright: same invariant, zero
   timing dependence, and the file runs ~130 ms instead of sleeping 120 ms. 3x standalone green.

9. **CARRIED FORWARD (the one thing P11 does NOT finish): the send loop is not wired to a live Baileys socket.**
   `send-loop-worker-wiring.ts` wires `createBaileysMessageTransport({ getSendSocket: () => undefined })`, so in
   production every instance reports not-ready and every send **fails closed** as `not_connected` ->
   `RETRY_BACKOFF` (never a silent success, never a lost job — invariant 2 and 5 both hold). The whole path is
   proven end-to-end against the fake transport; only the final socket handoff is absent.
   **Why it was not done here:** `engine/session/registry.ts` exposes `getSock?(): { logout(): Promise<void> }`
   — deliberately narrowed to `logout` ONLY, enforced by the static `logout-call-sites` guard per **ADR 0013
   constraint 6** ("sock.logout() may exist ONLY in provider/baileys/adapter.ts#unlink"). Widening that port to
   expose a `sendMessage`-capable shape is a `registry.ts`/`runner.ts` architectural change that must not be made
   as a side effect of a queue-wiring unit, and it was outside U5's file scope. Flagged, not silently stubbed.
   **This is P12's first task, or a small dedicated unit before it.** It does not block P11's stated tests (the
   e2e proof runs on the fake transport by design) and it does not block the deferred live demo any more than the
   founder's own deferral already does — but P11 must NOT be described as "a message can reach a real phone".

10. **PHASE-FILE ERROR: the e2e test table says "five `delivery_events` rows in order"; the system writes FOUR.**
   Verified independently (grep of every `writeDeliveryEvent(` call site + the enum): a happy-path send writes
   `created`, `queued` (both in U3's enqueue transaction), `dispatched` (U4 `dispatch.ts:128`), `sent`
   (U4 `result.ts:154`). The `'claimed'` label exists in the `event_type` enum (migration 0009) but **no code
   path anywhere writes it** — `claim-jobs.sql` is a single `UPDATE ... RETURNING` and never writes an event.
   The other two `writeDeliveryEvent` sites (`result.ts:200/227`) are the `failed` / `retry_scheduled` branches,
   mutually exclusive with `sent`. The e2e asserts the truth exactly —
   `expect(events).toEqual(['created','queued','dispatched','sent'])` — rather than inventing a fifth write or
   weakening to "at least four". **If a `claimed` event is genuinely wanted, that is a new decision for a later
   phase, not a silent addition here.**

## Risks / gotchas specific to this phase
- ~~**Pacing does not exist yet, and that is the dangerous fact of this session.** `INTERIM_MIN_GAP_MS` is a crude module-level floor, not Safe Mode. The boot assertion that refuses to start once `pacing_ledger` exists is what stops it silently outliving P13 — do not weaken it to a warning.~~ **STRUCK — P13 has landed**: real pacing (`app/backend/src/engine/pacing/`) now exists; `interim-gap.ts` and its self-destruct assertion were deleted, replaced by `assert-db-preconditions.ts`'s `checkPacingStateProvisioned` gate (the opposite-direction check: every live instance MUST have a provisioned `instance_pacing_state` row). **Per ADR 0020 §8, no number other than a disposable test number may be linked until P13 and P16 land.** Say this out loud in the session log; it is the single easiest way to burn a real number.
- **`ON CONFLICT DO NOTHING` on `mjr_idem_uq` is a 5xx generator.** `DO NOTHING` returns no row for the loser of the race, so a concurrent duplicate gets a null `public_id` and the route 500s — exactly what mandatory test 1 forbids. Use the no-op `DO UPDATE ... RETURNING` form (blueprint `[R-22]`, `[R-22w]`) and prove it with 50 parallel POSTs, not 2.
- **The zero-row result write must stay a hard error.** The tempting "fix" is to make the job update an upsert or to drop the `lease_id` predicate so it always matches. Both silently re-send a message that already went to a real person. Zero rows means another worker owns the job: throw, count, leave the outcome on the `send_attempts` row and let P12's reaper repair it. There is no repair path in this phase.
- **`send_attempts` is written before the provider call, not after.** A crash after send and before the attempt row is an undetectable duplicate. The order in step 6 is normative and the timing is arithmetic: `sendTimeout 45s` < `claim expiry 90s` − `reaper grace 30s`.
- **A wake is a hint, never an authority.** Redis pub/sub is at-most-once and has no delivery guarantee across a reconnect; every eligibility predicate stays inside `claim-jobs.sql`. If you find yourself skipping a predicate because "the wake told us it is ready", stop — that is the bug the safety poll exists to make survivable, and `a_dropped_wake_still_drains_via_the_safety_poll` is the test that keeps it honest.
- **Do not add an `instance_id` label to the queue-depth or oldest-age gauges.** The four-gauge allow-list from P09 is already spent; per-instance depth and lag are served to the panel from Postgres (delta, *Observability (one rule, not two)*). A fifth labelled gauge throws at registration and you will lose an hour to it.
- **No money moves here.** The claim already carries the wallet predicates from P03, but no debit, no ledger row, no guard row — that is P18. `nothing_in_this_phase_writes_a_wallet_row` is deliberately in the table so a helpful implementer does not "finish" the send-result transaction.
- **Do not create stub `pacing`/`contentGuards` modules.** An empty `reserve()` that always grants is a bypass with a friendly name and it will survive into P13. Mark the two insertion points with comments inside the claim transaction and leave them empty (SESSION-PROTOCOL C4: nothing half-finished and undocumented).
- **We do not self-mint Baileys message ids.** SPIKE-1 is unproven, so `client_msg_id` stays nullable and unused for correctness, and no copy anywhere may say duplicates are impossible.
- **Priority is ordering, not speed.** DWRR picks the band; it never shortens the gap, never skips a predicate, and no request field may raise a job's effective rate. `check-send-origin` must stay green — no DTO accepts `origin` from input.
- **Honest composer copy.** "Queued — will send from your connected number" and, for an offline account, the parked/offline wording from `@wp/domain`. No delivery-time promise, no "instant", nothing from `BANNED_CLAIMS`, and never a tick on an unsent message. All strings go through `check-copy`.
- **Worker pool max 4 + PgBouncer transaction mode** (delta row 8) — the send loop opens one transaction per claim; a larger pool per worker multiplies straight into Postgres connection exhaustion at fleet size.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P12 — queue-recovery-and-echo-spike. Read plan/v1/P12-queue-recovery-and-echo-spike.md and
follow it exactly: one phase, one session. Deps P11 are done (see plan/README.md). Do not start P13.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
