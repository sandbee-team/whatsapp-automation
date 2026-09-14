# P18 — wallet-ledger-and-pricing

**Goal (one line):** Money moves — exactly once, only on a confirmed send: `wallet_charge_guards`, the append-only ledger write, the resolved price book, and the guard-first debit chained off the send-result job `UPDATE`, with reversals, rollups and the reconciler that proves the balance.
**Status:** done (2026-09-04) · **Size:** M (heavy) · **Session:** 1 of 1
**Depends on:** P12, P02 (and P03, P11, which P12 already required) — all `done`
**Blocks:** P19, P23, P24, P28

**Size warning.** This phase fits in 10 steps but they are not small ones. The **pre-agreed split line is after step 7**: if the session clock runs out, steps 8-10 (rollup, reconciler, guards/registration) become `plan/v1/P18a-wallet-rollups-and-reconciler.md`, a row is added to `plan/README.md`, and P18a's prompt is written instead of P19's. Do not silently carry unfinished work forward (SESSION-PROTOCOL C4).

## Prerequisites (facts, not phases)
- Postgres **17** + Redis 7 up via `infra/compose/docker-compose.dev.yml`; the `ROLE=migrate` runner applies cleanly on a fresh volume.
- **P02 already created** `price_lists`, `price_list_items`, `client_pricing`, `wallet_accounts` (`max_rate_minor bigint NOT NULL CHECK (> 0)`, no default), `wallet_ledger` (PK `(client_id, seq)`, monthly `PARTITION BY RANGE (created_at)`) and the non-partitioned `wallet_ledger_ext_refs`, plus the `default_inr` placeholder seed and the boot assertion that no wallet row has `max_rate_minor = 0`. **This phase creates none of those again** — it `ALTER`s or reads them.
- **P03 already put both wallet predicates inside `db/queries/claim-jobs.sql`** (`w.state NOT IN ('empty','frozen')`, `w.balance_minor >= w.max_rate_minor`, `wallet_accounts` joined `INNER`). **P18 changes no claim SQL.** The states/UX/wake around those predicates are P19.
- P11 owns the send-result write and P12 owns the reaper/echo reconciler; both exist and are green. This phase edits those files, it does not create a second result statement or a second reaper.
- `wp_app` has **no UPDATE/DELETE grant on `wallet_ledger` / `wallet_ledger_ext_refs`** (P02, grant snapshot). Append-only is a grant, not a habit.
- ADRs **0017-0020 accepted**. `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL **O2**).
- **O3: skip it.** ADR 0019 plus the delta's *Wallet and metering* section specify this phase verbatim, including the SQL. No `/feature` run; go straight to E1. Any deviation from the SQL below is a `/decide`, not an edit.

## What you are building (3-6 bullets)
- `wallet_charge_guards` (monthly-partitioned, PK `(send_attempt_id, kind)`) — **the** idempotency authority for send-linked money — plus `wallet_daily_summary` and `wallet_reconcile_findings`.
- The price book: `resolvePriceKey`, `resolveRateMinor` (client override → price list, hard error on an unpriced key) and `materialiseMaxRate` written **in the same transaction as any pricing change**.
- `db/queries/debit-send.sql` — the delta's guard-first CTE, copied verbatim, chained off the job `UPDATE`'s `RETURNING`, wired into the existing send-result transaction in the fixed lock order `message_jobs → send_attempts → wallet_accounts → campaign_counters`.
- Reversals: `refund_send` for `reconciled_lost` only where a `debit_send` guard exists; and the reaper's per-tenant charger so a repaired send is charged exactly once instead of delivered free.
- The nightly rollup + reconciler checks A-E with `wp_wallet_drift_minor`, and the CI guard that no second statement anywhere may touch `wallet_accounts.balance_minor`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | **`Wallet and metering` — the whole section**: *Where the balance is checked*; *The debit* (copy the SQL verbatim; read all three fixed defects); *Reversals*; *Reconciliation that finishes*; *Pricing and top-up*; *Observability* |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *Schema delta → Wallet, pricing and usage*; *Migration placement rule*; *Load model* (12 statements / 3.2 KB per send) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | §1-3 (schema, exactly-once, `frozen` absorbing), §7 (refunds), §8 (reconciliation), §11 (pricing is pricing, not cost) |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | — |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | *Durable queue… → Dispatch and result* (the zero-row `claim_lost_during_send` case) and *The reaper (every 15s)* |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/database.md`, `.claude/rules/queue-workers.md` | all |
| Protocol | `plan/SESSION-PROTOCOL.md` | O1-O3, E1-E3, C1-C7 |

## Ordered minimum steps
Migration numbers: use the next two free 4-digit numbers after whatever P17 left, and write the real names into the files list. Below they are `NNNN`.
Test directory: use the one that already exists (`db/tests/` from P02). Do not create a second `db/test/`.

- [x] 1. **Write the failing tests first** (each unit wrote its named tests red-first; PG-backed cases live in `*.integration.test.ts` siblings) (all red, none skipped, none `.only`) → `db/tests/wallet-guards-schema.test.ts`, `app/backend/src/modules/wallet/pricing.test.ts`, `app/backend/src/modules/wallet/debit.integration.test.ts`, `app/backend/src/modules/wallet/refund.integration.test.ts`, `app/backend/src/modules/queue/reaper-charge.integration.test.ts`, `app/backend/src/modules/wallet/rollup.test.ts`, `app/backend/src/modules/wallet/reconcile.test.ts`.
- [x] 2. **Migration — the money tables this phase owns** (U1 done 2026-09-04: migrations 0051 + 0052) → `db/migrations/NNNN_wallet_guards_and_rollups.sql`, `db/schema/wallet-guards.ts`, `db/src/partitions.ts` (changed: register `wallet_charge_guards` on the monthly cadence). `wallet_charge_guards (send_attempt_id bigint, kind wallet_entry_kind, client_id uuid NOT NULL, ledger_seq bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, PRIMARY KEY (send_attempt_id, kind, created_at)) PARTITION BY RANGE (created_at)` — `created_at` is **passed in from `send_attempts.created_at`, never `now()`** (see gotchas); `wallet_daily_summary` PK `(client_id, day, instance_id)` with **`instance_id NOT NULL`**; `wallet_reconcile_findings (id, client_id NOT NULL, kind, detail jsonb, amount_minor, corrected_at, created_at)`. RLS `ENABLE`+`FORCE` + the `client_id` policy on parent **and** every partition; grants: `wp_app` R/W on guards, `wp_admin_app` SELECT only.
- [x] 3. **The price book** (U2 done 2026-09-04; PG-backed cases live in `pricing.integration.test.ts`) → `app/backend/src/modules/wallet/pricing.ts`, `app/backend/src/modules/wallet/wallet.repo.ts`, `packages/domain/src/pricing.ts` (`PRICE_KEYS = ['text','media','group_text','group_media']`). `resolvePriceKey(job)` from `payload_kind` + `target_kind`; `resolveRateMinor(tx, clientId, priceKey)` = `client_pricing.override_items` → active price list, and an **unpriced key throws a named error** (never a zero rate); `materialiseMaxRate(tx, clientId)` sets `wallet_accounts.max_rate_minor = MAX(effective rate)` and is called **inside** every pricing-change transaction (ADR 0019 §11).
- [x] 4. **The debit statement, verbatim** (U3 done 2026-09-04; ADR 0038 amendments + `::wallet_state` casts in the CASE) → `db/queries/debit-send.sql` (the delta's `WITH upd … guard … acct … INSERT INTO wallet_ledger … RETURNING seq`, plus the same-transaction `UPDATE wallet_charge_guards SET ledger_seq = $seq`), loader entry in `db/src/queries.ts`. Header comment states: guard row first and its `RETURNING` gates the account update; **never** `balance + (SELECT … FROM ins)`; `frozen` is absorbing in the `CASE`; lock order `message_jobs → send_attempts → wallet_accounts → campaign_counters`; this file is the only writer of `balance_minor` for sends.
- [x] 5. **Wire the debit into the existing send-result transaction** (U3 done 2026-09-04; actual file `engine/queue/result.ts`) → `app/backend/src/modules/queue/send-result.ts` (changed — use P11's actual filename; do **not** add a second result statement), `app/backend/src/modules/wallet/charge.ts` (`chargeSend(tx, {attemptId, jobId, jobCreatedAt, leaseId, clientId, instanceId, campaignId, priceKey, rateMinor})`). Zero rows from the job `UPDATE` ⇒ existing `claim_lost_during_send` hard error and **no guard, no account update, no ledger row**. Makes step 1's debit tests green.
- [x] 6. **Reversals** (U4 done 2026-09-04; refund is in-transaction via `UnresolvedActionDeps.refundSend`, sink fallback idempotent; `reconciler.ts` only widened for `clientId`) → `db/queries/refund-send.sql`, `app/backend/src/modules/wallet/refund.ts`. `refund_send` keyed `(send_attempt_id,'refund_send')`, inserted **only if** a `debit_send` guard exists for that attempt; amount = the ledger row's `rate_minor`, never a re-resolved price. Called from the `reconciled_lost` path in P12's reconciler (`app/backend/src/modules/queue/reconciler.ts`, changed). Nothing else refunds — no charge, no refund.
- [x] 7. **Repaired sends are charged** (U5 done 2026-09-04; list `tenantKey(env, client, 'charge')` + index set `sysKey(env, 'sys', 'wallet', 'charge-pending')`, in-cron drain; reaper.ts itself unchanged — the emit lives in the real sink) → `app/backend/src/modules/queue/reaper.ts` (changed: emit one work item per job repaired to `sent`, on `wp:{env}:charge:c:{client}`, bounded, best-effort), `app/backend/src/modules/wallet/charger.worker.ts` (per-tenant consumer applying the same guard-keyed debit inside `withTenant`). Correctness rests on the guard + reconciler check B, **not** on the work item arriving.
- [x] 8. **Rollup and metrics (off the hot path)** (U2 metrics `platform/metrics/wallet-metrics.ts`; U8b `rollup.ts`, hourly idempotent) → `app/backend/src/modules/wallet/rollup.ts` (cron: ledger → `wallet_daily_summary`, re-runnable, upsert by `(client_id, day, instance_id)`), `app/backend/src/platform/metrics/wallet.ts`: `wp_wallet_debits_total{price_key}`, `wp_wallet_refunds_total{reason}`, `wp_wallet_drift_minor`, `wp_wallet_clients_empty` — **no `client_id`/`instance_id` label on any of them** (delta *Observability*). Per-client figures come from the rollup, over SQL.
- [x] 9. **Reconciler A-E** (U8a/U8b + fix migrations 0054-0056; definer functions owned by wp_admin_app, writes per tenant as wp_app) → `app/backend/src/modules/wallet/reconcile.ts`, `db/queries/wallet-reconcile.sql`. A: continuity over the last 200 entries per client anchored on `checkpoint_seq`/`checkpoint_balance_minor` (never a full aggregate) + `balance_after_minor(max seq) = wallet_accounts.balance_minor`; B: one set-based statement over `send_attempts` (`state='acked' AND resolved_at ∈ [$from,$to) AND NOT EXISTS (guard)`, with `created_at >= $from - interval '2 days'` for pruning); C: the inverse; D: rollup parity; E: orphan guards (`ledger_seq = 0 AND created_at < now() - interval '10 minutes'`). Findings → `wallet_reconcile_findings`; auto-correction **only** for B, via `adjustment_credit`/`adjustment_debit` with `reason='reconciliation'`, under a per-client daily cap that repaired-send findings are exempt from.
- [x] 10. **Guards and registration** (U7/U7b guard + CI step; U1 suite A; C2 suite B at `modules/wallet/__tests__/suite-b-wallet.integration.test.ts`; grants snapshot; `CROSS_TENANT_QUERIES` ×7; `SCHEDULER_LOOP_MODULES` ×4 wallet modules) → `scripts/check-single-debit.ts` (fails if any file other than `db/queries/debit-send.sql` / `refund-send.sql` / `wallet-reconcile.sql` writes `wallet_accounts.balance_minor` or `INSERT`s into `wallet_ledger`), `scripts/__tests__/check-single-debit.test.ts`, `scripts/ci.ps1` + `scripts/ci.sh` (changed: new guard step with its non-zero matched-file meta-assertion), `db/tests/isolation-suite-a.test.ts` (changed: three new tables; `wallet_charge_guards` stays on the exactly-three exemption list), `db/tests/isolation-suite-b.test.ts` (changed: charger, rollup, reconciler as two-tenant background paths), `db/schema/grants.snapshot.json` (changed), `db/src/isolation/tenant-tables.ts` (changed: `CROSS_TENANT_QUERIES` entry for the set-based reconciler statement, with role + reason + projected columns).

## Dispatch plan (written at E1, 2026-09-04 — groups the ordered steps into work units)
Verified facts that reshape the steps (all recorded in ADR 0038, `/decide` at E1):
- `send_attempts` has NO `created_at` column (only prepared_at/dispatched_at/resolved_at + `message_job_created_at`). The guard's `created_at` is therefore `message_jobs.created_at`, read IN-STATEMENT from the job row (never a JS `Date` bind — microsecond round-trip bug, see `dispatch.ts` header). Every writer (debit, repair, refund, reconciler) uses the same value ⇒ one partition row per attempt.
- `campaign_counters` does not exist yet (P23). Lock order documented as `message_jobs → send_attempts → wallet_accounts (→ campaign_counters when it exists)`.
- P11's result writer is `app/backend/src/engine/queue/result.ts` (not `modules/queue/send-result.ts`); the job UPDATE keeps P11's predicate `id + lease_id + status='processing' + client_id` (no `created_at = $jts` bind). The only `reconciled_lost` writer is `modules/queue/unresolved.service.ts#retryUnresolved` (the reconciler's no-evidence branch writes `abandoned`), so the refund is injected there (`UnresolvedActionDeps.refundSend`, in the same transaction) and `reconciler.ts` is NOT changed.
- The delta's final `INSERT … RETURNING seq` is wrapped as `ins AS (…)` + `SELECT job_rows, guard_rows, seq` so a zero-row job UPDATE is distinguishable from a guard conflict (both charge nothing).
- Cross-tenant reconciler checks A–E + rollup compute are read-only `SECURITY DEFINER` functions owned by `wp_admin_app`, EXECUTE → `wp_scheduler` (P12's `wp_reconcile_scan_unresolved` idiom, migration 0052); every WRITE (rollup upsert, findings, corrections) is per tenant via `withTenant` as `wp_app`.
- Multi-statement `.sql` files use `-- name:` sections; `loadNamedQuery(file, section)` added to `db/src/queries.ts`.
- Redis charger key follows the enforced grammar: list `tenantKey(env, clientId, 'charge')` = `wp:{env}:c:{client}:charge` (+ index set `sysKey(env,'charge','pending')`), not the phase text's `wp:{env}:charge:c:{client}`.
- Isolation suite B for wallet = `app/backend/src/modules/wallet/__tests__/suite-b-wallet.integration.test.ts` (repo convention), not `db/tests/isolation-suite-b.test.ts`.
- Cron loops are `setInterval`-based, so "nightly" = hourly re-runnable idempotent sweeps (rollup upserts today+yesterday UTC; reconciler window `[now-25h, now-10min)`).
- PG-backed pricing tests live in `pricing.integration.test.ts`; pure mapping/error tests in `pricing.test.ts`.

| Unit | Steps | Agent | Files (scope) | Runs |
|---|---|---|---|---|
| U1 | 1 (schema tests), 2 | db-engineer | migration 0051, `db/schema/wallet-guards.ts`+`index.ts`, `db/src/partitions.ts`, `db/src/queries.ts` (+test), `db/src/isolation/tenant-tables.ts`, `scripts/check-tenant-scope.ts` (TENANT_TABLES), `db/tests/helpers/isolation-fixtures.ts`, `db/tests/wallet-guards-schema.test.ts`, grants snapshot | alone (migration) |
| U2 | 3, 8 (metrics only) | implementer | `packages/domain/src/pricing.ts`+`index.ts`, `modules/wallet/pricing.ts`, `wallet.repo.ts`, `pricing.test.ts`, `pricing.integration.test.ts`, `platform/metrics/wallet-metrics.ts`+`.test.ts` | ∥ U7 |
| U7 | 10 (guard + CI) | implementer | `scripts/check-single-debit.ts`, `scripts/guards/single-debit-lib.ts`, `scripts/__tests__/check-single-debit.test.ts`, `scripts/guards/registry.ts`, `scripts/ci-steps.ts`, `package.json` | ∥ U2 |
| U3 | 4, 5 | implementer | `db/queries/debit-send.sql`, `modules/wallet/charge.ts`, `engine/queue/result.ts` (+`result-attempt-outcome.ts` RETURNING id, sibling split if needed), `engine/queue/send-loop.ts` (payloadKind), ResolveAckInput call sites, `debit.integration.test.ts` | alone (after U2) |
| U4 | 6 | implementer | `db/queries/refund-send.sql`, `modules/wallet/refund.ts`, `modules/wallet/wallet-sink.ts`, `modules/wallet/index.ts`, `modules/queue/repaired-send-sink.ts` (clientId on both methods) + 3 call sites, `unresolved.service.ts` (in-tx refund dep), `roles/api.ts` wiring, `refund.integration.test.ts` | alone (after U3) |
| U8 | 8 (rollup), 9 | db-engineer→implementer (one dispatch) | migration 0052 (definer fns), `db/queries/wallet-reconcile.sql`, `modules/wallet/rollup.ts`, `reconcile.ts`, `rollup.test.ts`, `reconcile.test.ts`, `scripts/registries/cross-tenant-queries.ts`, `packages/domain/src/timing.ts`, grants snapshot | alone (migration) |
| U5 | 7 | implementer | `modules/wallet/charger.worker.ts`, `engine/cron/cron-wiring-wallet.ts` (+`cron-wiring.ts` hook, `single-flight.ts` lock keys), `roles/cron.ts` (optional Redis), `modules/queue/reaper-charge.integration.test.ts` | after U8 |
| U9 | 10 (suites) | test-engineer (C2) | `modules/wallet/__tests__/suite-b-wallet.integration.test.ts`, suite A already covered by U1 | after U5 |

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `db/tests/wallet-guards-schema.test.ts` | `no_unique_index_on_a_partitioned_table_without_the_partition_key` | stays green over `wallet_charge_guards` (mandatory **21**) |
| `db/tests/wallet-guards-schema.test.ts` | `wallet_daily_summary_has_no_nullable_column_in_its_primary_key` | `instance_id NOT NULL`; the workspace total is a `SUM` |
| `db/tests/wallet-guards-schema.test.ts` | `no_money_column_is_a_floating_point_type` | catalog scan over the new tables; every `*_minor` is `bigint` |
| `app/backend/src/modules/wallet/pricing.test.ts` | `client_override_beats_the_default_price_list` | `client_pricing.override_items` wins per key |
| `app/backend/src/modules/wallet/pricing.test.ts` | `an_unpriced_price_key_is_a_named_error_not_a_zero_rate` | throws; nothing is charged at 0 |
| `app/backend/src/modules/wallet/pricing.test.ts` | `pricing_change_takes_effect_on_the_very_next_claim` | `max_rate_minor` rewritten in the same transaction; the next claim sees it (ADR 0019 §11) |
| `app/backend/src/modules/wallet/pricing.test.ts` | `a_pricing_change_never_reprices_a_past_ledger_row` | old `rate_minor`/`balance_after_minor` byte-identical |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `one_hundred_crash_injected_sends_produce_exactly_one_charge_each` | 100 sends with the process killed at randomised points, all replayed → 100 guards, 100 ledger rows, balance = start − 100×rate |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `replayed_send_result_leaves_balance_byte_identical` | asserts the **exact** prior `balance_minor` (not merely "one ledger row"), and it is not NULL |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `a_zero_row_result_write_charges_nothing` | `claim_lost_during_send` ⇒ 0 guards, 0 ledger rows, balance unchanged |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `a_debit_does_not_unfreeze_a_frozen_wallet` | `state` stays `frozen` through a successful send |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `a_debit_stamps_the_guard_with_its_ledger_seq` | no guard left at `ledger_seq = 0` after commit |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `a_debit_never_writes_health_state_or_pause_reason` | both columns byte-identical (the wallet stop is orthogonal) |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `balance_after_minor_is_continuous_across_a_concurrent_burst` | 3 instances of one client sending at once → `seq` gapless, each `balance_after` = previous + `amount` |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `a_repair_across_a_month_boundary_still_charges_once` | guard `created_at` comes from the attempt, so a repair in month N+1 hits the same partition row |
| `app/backend/src/modules/wallet/debit.integration.test.ts` | `a_claim_and_a_debit_do_not_deadlock` | claim + debit interleaved 200× → zero `deadlock detected` |
| `app/backend/src/modules/wallet/refund.integration.test.ts` | `reconciled_lost_refunds_exactly_once` | replayed twice → one `refund_send` guard, one ledger row |
| `app/backend/src/modules/wallet/refund.integration.test.ts` | `a_refund_without_a_debit_guard_is_a_no_op` | failed/cancelled/opted-out job → 0 ledger rows, balance unchanged |
| `app/backend/src/modules/queue/reaper-charge.integration.test.ts` | `claim_lost_then_repaired_send_is_charged_exactly_once` | reaper repairs `acked` → `sent`; exactly one `debit_send` even if the charger runs twice |
| `app/backend/src/modules/queue/reaper-charge.integration.test.ts` | `a_repaired_send_is_still_charged_when_the_work_item_is_dropped` | Redis flushed; reconciler check B produces the single debit |
| `app/backend/src/modules/wallet/rollup.test.ts` | `daily_summary_matches_the_ledger_for_the_day` | per `(client, day, instance)` sums equal; re-run changes nothing |
| `app/backend/src/modules/wallet/reconcile.test.ts` | `continuity_check_reads_at_most_two_hundred_entries_per_client` | statement-level assertion; no full-ledger aggregate |
| `app/backend/src/modules/wallet/reconcile.test.ts` | `a_missing_debit_is_detected_and_auto_corrected_once` | finding B → one `adjustment_debit`, `reason='reconciliation'` |
| `app/backend/src/modules/wallet/reconcile.test.ts` | `auto_correction_respects_the_daily_cap_except_for_repaired_sends` | cap enforced; repaired-send findings exempt |
| `app/backend/src/modules/wallet/reconcile.test.ts` | `an_orphan_guard_older_than_ten_minutes_is_reported` | check E finds what A-D cannot |
| `app/backend/src/modules/wallet/reconcile.test.ts` | `the_reconciler_never_updates_or_deletes_a_ledger_row` | runs as `wp_app`; any attempt is a permission error |
| `app/backend/src/platform/metrics/wallet.test.ts` | `wallet_metrics_carry_no_client_or_instance_label` | label allow-list; no per-client balance gauge |
| `scripts/__tests__/check-single-debit.test.ts` | `a_second_statement_updating_balance_minor_fails_the_guard` | red on a planted violation; reports a non-zero matched-file count |

Mandatory-suite tests this phase makes green: **none new** — but **21** must stay green over `wallet_charge_guards`, and **22** (`exactly_one_table_carries_a_reserve_counter`) must stay green because no wallet column is added to `pacing_ledger` and no wallet predicate enters `pacing.reserve()`. ADR 0019 gating tests delivered here: `replayed_send_result_leaves_balance_byte_identical`, `a_zero_row_result_write_charges_nothing`, `a_debit_does_not_unfreeze_a_frozen_wallet`, `claim_lost_then_repaired_send_is_charged_exactly_once`, `pricing_change_takes_effect_on_the_very_next_claim`.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (gate attempt 2, above).
- [x] Named tests above exist and pass; no test is skipped or `.only` (PG-backed cases live in `*.integration.test.ts` siblings; `continuity_check_reads_at_most_two_hundred_entries_per_client` is in `db/tests/wallet-reconcile-definer.test.ts` + the behavioural window test).
- [x] `reviewer` verdict recorded: APPROVED-with-notes (C1) and APPROVED-with-notes (fixes re-review); notes filed above.
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] `db/queries/debit-send.sql` diffed by hand against the delta at E1/C1: identical except the ADR 0038 amendments (P11 predicate without `created_at` bind, guard `created_at` = `u.created_at`, `ON CONFLICT (…, created_at)`, `ins` wrapper + `SELECT job_rows, guard_rows, seq`, `END::wallet_state`, ledger columns from `upd` instead of `$iid/$camp/$jid/$jts`).
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `db/migrations/0051_wallet_guards_and_rollups.sql` — created (U1)
- `db/migrations/0052_wallet_guards_client_index.sql` — created (U1 fix: client_id-leading non-unique index, suite-A rule)
- `db/schema/index.ts` — changed: SCHEMA_TABLES + export (U1)
- `db/src/queries.ts` + `db/src/queries.test.ts` — changed: `loadNamedQuery`/`splitNamedSections` (U1)
- `scripts/check-tenant-scope.ts` — changed: TENANT_TABLES mirror +3 (U1; file now exactly 300 lines)
- `db/tests/helpers/isolation-fixtures.ts` — changed: seed/cleanup/PROBE_SPECS for the 3 tables (U1)
- `db/schema/wallet-guards.ts` — created
- `db/queries/debit-send.sql` — created
- `db/queries/refund-send.sql` — created
- `db/queries/wallet-reconcile.sql` — created (U8a: 7 cross-tenant passthrough sections + `wallet-rollup-upsert`, `wallet-finding-insert`, `wallet-reconcile-daily-correction-count`, `wallet-adjustment-debit`)
- `db/migrations/0053_wallet_reconcile_functions.sql` — created (U8a: 7 read-only SECURITY DEFINER functions owned by wp_admin_app, EXECUTE → wp_scheduler)
- `db/tests/wallet-reconcile-definer.test.ts` — created (U8a; carries `continuity_check_reads_at_most_two_hundred_entries_per_client` as a `pg_get_functiondef` assertion)
- `scripts/registries/cross-tenant-queries.ts` — changed (U8a: 7 entries)
- `db/src/partitions.ts` — changed: monthly cadence for `wallet_charge_guards`
- `db/src/queries.ts` — changed: loader entries
- `db/src/isolation/tenant-tables.ts` — changed: new tables + `CROSS_TENANT_QUERIES` entry
- `db/schema/grants.snapshot.json` — changed: grants for the new tables
- `db/tests/wallet-guards-schema.test.ts` — created
- `db/tests/isolation-suite-a.test.ts` — changed
- `db/tests/isolation-suite-b.test.ts` — changed
- `packages/domain/src/pricing.ts` — created (U2); `packages/domain/src/index.ts` — changed: pricing exports (290/300 lines)
- `app/backend/src/modules/wallet/index.ts` — created (U2 barrel)
- `app/backend/src/modules/wallet/pricing.integration.test.ts` — created (U2)
- `app/backend/src/platform/metrics/wallet-metrics.ts` + `wallet-metrics.test.ts` — created (U2; repo naming `<x>-metrics.ts`)
- `app/backend/src/modules/wallet/pricing.ts` — created
- `app/backend/src/modules/wallet/wallet.repo.ts` — created
- `app/backend/src/modules/wallet/charge.ts` — created (U3: `chargeSend`, `chargeRepairedSend`)
- `app/backend/src/modules/wallet/debit.integration.test.ts` + `debit-crash-injection.integration.test.ts` + `debit-concurrency.integration.test.ts` — created (U3; nine named cases split at the line cap)
- `app/backend/src/engine/queue/result.ts` — changed (U3: debit chained off the job UPDATE via `chargeSend`; `payloadKind` required; 299 lines)
- `app/backend/src/engine/queue/result-attempt-outcome.ts` — changed (U3: `markAttempt` RETURNING id; `SendAttemptRowMissing`)
- `app/backend/src/engine/queue/result-ack-side-effects.ts` — created (U3: mechanical split of the send-frequency bucket write)
- `app/backend/src/engine/queue/send-loop.ts` — changed (U3: passes `payloadKind`; 297 lines); `send-loop-worker-wiring.ts` — changed (U3: `walletMetrics` wired)
- `app/backend/src/engine/queue/__tests__/queue-send-tenant-fixture.ts` — changed (U3: seeds `client_pricing`; wallet options; cleanup of guards/ledger)
- `app/backend/src/engine/queue/result.integration.test.ts`, `result-crash-window.integration.test.ts`, `result-delivery-event-transaction-survival.integration.test.ts`, `result-failure.integration.test.ts` — changed (U3: `payloadKind`); `result-wallet-debit.integration.test.ts` — created (U3)
- `db/src/index.ts` — changed (U3: barrel exports `loadNamedQuery`/`splitNamedSections`)
- `app/backend/src/modules/wallet/refund.ts` — created (U4); `refund.integration.test.ts` — created (U4)
- `app/backend/src/modules/wallet/wallet-sink.ts` — created (U4: real `RepairedSendSink`)
- `app/backend/src/modules/queue/repaired-send-sink.ts`, `reaper-row-effects.ts`, `reconciler-resolve.ts`, `reconciler.ts` — changed (U4: `clientId` on both sink methods)
- `app/backend/src/modules/queue/unresolved.service.ts` + `unresolved.routes.ts` — changed (U4: optional in-transaction `refundSend` dep; 273 lines)
- `app/backend/src/roles/api.ts` — changed (U4: real wallet sink + `refundSend` + wallet metrics wired; 219 lines)
- `app/backend/src/modules/wallet/charger.worker.ts` — created (U5)
- `app/backend/src/engine/cron/cron-wiring-wallet.ts` + `cron-wiring-wallet.test.ts` — created (U5: real sink, charger/rollup/reconcile loops)
- `app/backend/src/engine/cron/cron-wiring.ts` — changed (U5: real wallet sink for reaper + reconciler; new loops; 287 lines); `engine/cron/single-flight.ts` — changed (U5: `walletRollup`/`walletReconcile` lock keys)
- `app/backend/src/roles/cron.ts` — changed (U5: optional Redis for the charger; fail-safe warn when `REDIS_URL` is absent; 100 lines)
- `app/backend/src/modules/wallet/rollup.ts` — created (U8b); `rollup.integration.test.ts` — created (U8b)
- `app/backend/src/modules/wallet/reconcile.ts` + `reconcile-checks.ts` — created (U8b: check B in reconcile.ts, A/C/D/E in reconcile-checks.ts); `reconcile.test.ts` (unit), `reconcile.integration.test.ts`, `reconcile-checks.integration.test.ts`, `__tests__/reconcile-test-support.ts` — created (U8b)
- `app/backend/src/modules/wallet/charge.ts` — changed (U8b: `resolveAttemptPrice` exported)
- `packages/domain/src/timing.ts` + `timing.test.ts` — changed (U8b: `walletChargerDrainIntervalMs`, `walletRollupIntervalMs`, `walletReconcileIntervalMs`)
- `scripts/check-scheduler-queries.ts`, `scripts/guards/scheduler-queries-lib.ts`, `scripts/guards/scheduler-named-queries-lib.ts` (new), `scripts/guards/check-scheduler-queries.test.ts`, `scripts/guards/check-scheduler-named-queries.test.ts` (new) — changed/created (U8b: wallet loop modules pinned; `loadNamedQuery` sections recognised)
- `db/migrations/0054_wallet_reconcile_functions_fix.sql` — created (debugger: 42702 ambiguous OUT-param column in `wp_wallet_check_continuity`); `db/migrations/0055_wallet_check_continuity_loop_variable_fix.sql` — created (debugger: 42703 loop-variable reuse, found only by executing the fixed function); `db/tests/wallet-reconcile-definer-exec.test.ts` — created (execution tests for all 7 functions). `db/migrations/0056_wallet_rollup_parity_day_filter_fix.sql` — created (debugger: check D's `s.day = p_day` was a JOIN predicate on a FULL OUTER JOIN, not a filter — false `rollup_parity` findings for every other day; found by U8c's exact idempotency assertion); `db/src/schema-version.ts` → 56. U8c changed `reconcile.integration.test.ts`, `reconcile-checks.integration.test.ts`, `__tests__/reconcile-test-support.ts` (ambient-state-free drift assertion; per-client cap seeding; rollup-before-reconcile idempotency). `db/src/schema-version.ts` — changed (debugger: `EXPECTED_SCHEMA_VERSION` 50 → 55); `app/backend/src/engine/queue/__tests__/queue-send-test-helpers.ts` — changed (debugger: `seedDispatchedAttempt` binds `message_job_created_at` in-statement, never a round-tripped JS Date). Dev-DB recovery: one poisoned `schema_migrations` row (version 54, an earlier draft) deleted by the main session so the runner re-applied the corrected file — lesson filed
- `app/backend/src/modules/wallet/*.test.ts` — created (pricing, debit, refund, rollup, reconcile)
- ~~`app/backend/src/modules/queue/send-result.ts`~~ — does not exist; P11's writer is `engine/queue/result.ts` (listed above)
- `app/backend/src/modules/queue/reaper.ts` — NOT changed: the per-row `sink.onRepairedSent(attemptId, clientId)` hook from P12 already exists; the work-item emit lives in `modules/wallet/wallet-sink.ts` (U4/U5)
- `app/backend/src/modules/queue/reconciler.ts` — changed only for the sink signature; the `reconciled_lost` writer is `unresolved.service.ts` (above)
- `app/backend/src/modules/queue/reaper-charge.integration.test.ts` — created
- `app/backend/src/platform/metrics/wallet.ts` + `.test.ts` — created
- `scripts/check-single-debit.ts` + `scripts/guards/single-debit-lib.ts` + `scripts/__tests__/check-single-debit.test.ts` — created (U7); `scripts/guards/registry.ts` — changed: guard registered (298/300 lines); `package.json` — changed: `check:single-debit` script
- `db/queries/wallet-signup-credit.sql` — created (U7b: the signup-credit ledger INSERT moved out of `modules/tenancy/provisioning.repo.ts` so the guard's exemption list stays SQL-only — four sanctioned files)
- `app/backend/src/modules/tenancy/provisioning.repo.ts` — changed (U7b: loads the sanctioned statement)
- `scripts/ci-steps.ts` — changed: `single-debit` step after `single-reserve` (U7). `scripts/ci.ps1`/`ci.sh` are thin wrappers that delegate to ci-steps.ts and were NOT changed

## Risks / gotchas specific to this phase
- **The guard PK needs the partition key, and that is a real trap.** ADR 0019 and the delta write the PK as `(send_attempt_id, kind)` on a table `PARTITION BY RANGE (created_at)`; PostgreSQL rejects that, which is exactly why `wallet_charge_guards` sits on the suite-A exemption list. The executable form is `PRIMARY KEY (send_attempt_id, kind, created_at)` — **and it is only a true idempotency authority if every writer passes the same `created_at`**. So the guard's `created_at` is stamped from `send_attempts.created_at` (which the debit already carries), never `now()`; otherwise a reaper or reconciler repair that runs after a month boundary lands in a different partition and charges a second time. Test this explicitly in `debit.integration.test.ts` with an attempt dated in the previous month: `a_repair_across_a_month_boundary_still_charges_once`. If a session decides the ADR text should change instead, that is a `/decide` at C6.
- **The NULL-balance trap is the whole reason this phase exists.** `balance_minor = balance_minor + (SELECT amount FROM ins)` looks correct and is not: an empty scalar subquery is NULL in PostgreSQL, so a replayed result write nulls the balance, every later comparison evaluates NULL, the client silently stops sending, and the reconciler reports drift it cannot explain. Only the guard-row-first form is allowed. `replayed_send_result_leaves_balance_byte_identical` must assert the **exact** number, not "a row exists".
- **A zero-row job UPDATE must produce zero money.** Everything is chained off `upd`'s `RETURNING`. If anyone "simplifies" the CTE by running the guard insert independently, `claim_lost_during_send` starts charging for sends that another worker owns.
- **`frozen` is absorbing.** The `CASE` must have `WHEN w.state = 'frozen' THEN 'frozen'` as its first branch. Without it, a staff freeze silently clears on the next successful send. P19 owns the matching top-up-side test.
- **Do not put anything wallet-shaped inside `pacing.reserve()`** and do not add a reserve-like counter column to a wallet table — mandatory test 22 is a schema assertion and it will go red.
- **Do not touch `health_state` or `pause_reason` from any code in this phase.** A zero balance is orthogonal by decision (ADR 0019 §4); reusing `paused` would create an automatic transition *out of* `paused`, one refactor away from auto-resume after a restriction. That is a safety-boundary violation, not a style preference.
- **Lock order is not advisory.** `message_jobs → send_attempts → wallet_accounts → campaign_counters` in every transaction that touches two of them. The claim's `FOR UPDATE OF j SKIP LOCKED` exists so a claim never locks the hot `wallet_accounts` row; if a deadlock appears here, the bug is an added lock, not the debit.
- **One hot `wallet_accounts` row per client** (fillfactor 70, HOT updates). Fine at 2-3 instances (~₹0.45 worst-case overdraft, ADR 0019 §6). The pre-designed lever is bucketed counters and it is **deliberately not built** — if a workspace approaches ~50 instances, that is a `/decide`, not an improvisation.
- **Honest copy.** Any pricing string this phase produces says the price is **our pricing**, not a provider cost pass-through (there is no per-message provider cost in v1), and the seeded 15p/25p numbers are **placeholders** that may not reach a tenant-facing surface before the founder sets real ones. Never "ban-proof", never a delivery-speed promise. All new strings go through `scripts/check-copy.ts`.
- **No refund invention.** Delivered-but-unread, blocked recipient and after-ack undeliverable are **not** refunded (WhatsApp gives no reliable after-ack signal); the pricing page says so. Adding a "goodwill auto-refund" here would make the ledger fiction.
- **No `external_ref` in logs or metric labels**, ever — it can carry a UTR. Same rule as phone numbers and bodies.
- **P02 vs P18 ownership.** If `wallet_accounts` or `wallet_ledger` appear to be missing, the fix is in P02's migration, not a new `CREATE TABLE` here. Two creators for one table is a red grant snapshot next session.

## Fix round (2026-09-04)
- F1: `db/migrations/0057_wallet_check_continuity_window_anchor_fix.sql` — created (reviewer MAJOR-1: checkpoint anchor now derived from the same 200-row window; no second ordered scan); `db/src/schema-version.ts` → 57; `db/tests/wallet-reconcile-continuity-window.test.ts` — created (MAJOR-2: behavioural window proofs — seam break at seq 101 reported with `anchored_on = 'checkpoint'`, corruption at seq 50 outside the window silent, inside-window break pins seq 250 + 251 exactly; exactly one `LIMIT 200` and no `ORDER BY seq … LIMIT 1` in the function body); `app/backend/src/modules/wallet/wallet-checkpoint-and-signup-shape.integration.test.ts` — created (replaces C2's red test; the old file was deleted by the main session).
- F2 (mechanical): `recipientJid` added at every `resolveAck` test call site — `engine/queue/*.integration.test.ts` and `modules/wallet/*.integration.test.ts` (14 files; one placeholder jid each, no logic change); `suite-b-wallet.integration.test.ts` trimmed to 300 lines (prose only).
- F2: `scripts/check-scheduler-queries.ts` (MAJOR-3: `charger.worker.ts` pinned), `engine/queue/result.ts` + test call sites (MINOR-4: `recipientJid` required, no `?? ''`), `modules/wallet/charger.worker.ts` + `wallet-edge-cases-charger-queue.integration.test.ts` (C2: `enqueue`/`drainOnce` bounded by `TIMING.redisCommandTimeoutMs`; a hung Redis drops the item with a warn and never stalls the reaper).

- Re-review (fixes only): `VERDICT: APPROVED-with-notes` — 1 WARNING + 2 SUGGESTIONS, all applied by the main session as trivial edits: `charger.worker.ts` enqueue order is now `sadd → lpush → ltrim` (a timeout can leave an indexed empty list, never an invisible item), the full-batch re-index `sadd` is bounded and best-effort, and the charger-queue test header describes the enforced bound.

## C2 test-engineer (2026-09-04)
Created (all `app/backend/src/modules/wallet/`): `__tests__/suite-b-wallet.integration.test.ts` (charger, rollup, reconciler as two-tenant background paths — the step-10 suite-B deliverable), `wallet-edge-cases.integration.test.ts`, `wallet-edge-cases-concurrency.integration.test.ts`, `wallet-edge-cases-boundaries.integration.test.ts`, `wallet-edge-cases-partitioning.integration.test.ts`, `wallet-edge-cases-charger-queue.integration.test.ts`, `wallet-edge-cases-stamp-guard.integration.test.ts`, `wallet-checkpoint-and-signup-shape.integration.test.ts` (rewritten in the fix round from C2's red `checkpoint-balance-not-initialised-at-signup` test: a ledger-less balance IS drift by design — the production signup writes seq 1 + `entry_seq 1`, which check A accepts; fixture wallets without ledger rows are the thing being reported). Findings turned into fixes: the charger's `enqueue` had no bound on a hung (connected, non-responding) Redis command — `createRedis` sets `connectTimeout` but no `commandTimeout` — fixed in the fix round with a local `TIMING.redisCommandTimeoutMs` race. Open item filed: no monthly checkpoint writer exists yet (`checkpoint_seq`/`checkpoint_balance_minor` stay 0), so check A's checkpoint anchor is inert until P19/P28 adds one; continuity over the last 200 entries and the balance identity still hold.

## C1 reviewer verdict (2026-09-04)
`VERDICT: APPROVED-with-notes` — 3 MAJOR, 2 MINOR, 2 NOTE, 0 CRITICAL. Fixed in the fix round: MAJOR-1 (check A's checkpoint anchor read the globally oldest ledger row, not the oldest of its 200-row window → migration 0057 + behavioural window test), MAJOR-2 (boundedness proven behaviourally: a break outside the window is NOT reported, a break at the window/checkpoint seam IS), MAJOR-3 (`charger.worker.ts` added to `SCHEDULER_LOOP_MODULES`), MINOR-4 (`recipientJid` required on `ResolveAckInput`; no `?? ''` coercion). Filed as notes (not fixed): MINOR-5 (check B repaired branch records no finding on a transient guard-conflict/job-status-changed no-op — transient by construction, re-scanned next hour), NOTE-6 (guard-kind literals duplicated at four call sites; a shared constant is a P19 tidy-up), NOTE-7 (`wallet-stamp-guard` is a per-partition PK-prefix probe; bind `created_at` from the debit's own RETURNING if the hot-path statement count ever matters).

## C5 gate attempt 1 (2026-09-04 15:01) — RED at step `integration`, 2 of 372 files
- `engine/queue/send-path-fairness.e2e.integration.test.ts` › `high_flood_does_not_starve_low`: `UnpricedKeyError` — its tenant fixture seeds a wallet without `client_pricing`; since P18 the result path fails closed on an unpriced tenant (correct behaviour, stale fixture). Fixed in the fixture (+ every other fixture that seeds `wallet_accounts` without pricing and drives a real send).
- `platform/redis/isolation-suite-c.integration.test.ts`: one leaked key `wp:test-wallet-edge-charger-queue:c:<uuid>:charge` from C2's charger-queue test (non-grammar env label, no cleanup). Fixed: env `test` + key cleanup in the wallet Redis tests; suite C's grammar now accepts the two P18 production key shapes (`wp:{env}:c:{uuid}:charge`, `wp:{env}:sys:wallet:charge-pending`). Lesson filed.
Steps after `integration` (build) did not run in attempt 1; guard counts come from attempt 2. Fix files: `engine/queue/send-path-fairness.e2e.integration.test.ts` (client_pricing seed), `platform/redis/isolation-suite-c.integration.test.ts` (`WALLET_CHARGE_LIST_KEY_GRAMMAR`), `modules/wallet/wallet-edge-cases-charger-queue.integration.test.ts` + `__tests__/suite-b-wallet.integration.test.ts` (env `test`, shared cleanup), `engine/queue/__tests__/queue-send-test-helpers.ts` (`cleanupChargerRedisKeys`). Lesson: `.memory/lessons/2026-09-04-p18-gate-reds-fixture-pricing-and-redis-key-hygiene.md`.

## C5 evidence — gate attempt 2 (2026-09-04 17:22, log `%TEMP%\wp-gate-20260904-172229.log`), verbatim tail
```
 Test Files  372 passed (372)
      Tests  1338 passed (1338)
   Start at  17:23:38
   Duration  329.91s (transform 4.71s, setup 1.12s, import 100.15s, tests 180.34s, environment 25ms)


--- CI step: build (pnpm run build) ---

> wp@0.0.0 build D:\kd\wp
> tsc -b


CI GREEN — all 26 steps passed

EXITCODE:0
```
Guard counts (C4): depcruise 934 · no-deep-module-import 366 · api-never-imports-provider 55 · server-kit-never-imports-baileys 37 · eslint no-plain-set/no-offset-pagination/key-construction 1009 · domain-determinism 90 · check-tree 11 · tenant-scope 1076 (581 scanned, 0 violations) · send-origin 1009/366 · copy 1403 · sql-lint 126 · role-boot 13 · single-claim 1306 · single-reserve 1306 · **single-debit 1229 (1229 scanned, 0 violations)** · no-auto-requeue 1306 · no-raw-hex 839 · serialisation-boundary 919 · ui-client-directive 10 · shutdown-purity 710 · placement-neutrality 710 · box-memory 1 · capacity-gate 142 · no-direct-publish 788 · no-insecure-tls 1210 · health-writers 1306 · **scheduler-queries 10 (10 modules, 0 violations)** · forbidden-mechanisms 1335. E3 unit suite: 273 files / 1622 tests green.

## C4 structure check (2026-09-04)
All 31 guards green with non-zero counts (above). No file outside the ADR 0014 tree; no deep module import (depcruise green; `modules/wallet` ↔ `modules/queue` only via `index.ts`); no raw `db.select()` outside `platform/db`; no `OFFSET`; money is `bigint` everywhere (schema test `no_money_column_is_a_floating_point_type`). Three new tenant tables in suite A; wallet suite B added; no new HTTP route this phase; four wallet metrics obey the label allow-list (`price_key`, `reason`, none tenant-scoped); no new tenant-facing copy string (check-copy 1403 files, 0 violations). Descoped/open items are written above ("Open items carried forward") and go into the P19 file/master-plan via C6.

## C3 invariant check (2026-09-04, written)
1. **durable-first** — PASS. No new send path; the debit is chained off the existing job UPDATE inside the result transaction. Nothing sends.
2. **fail-safe** — PASS. An unpriced tenant throws `UnpricedKeyError` before any write (job stays `processing`, attempt outcome preserved); a missing attempt row throws `SendAttemptRowMissing` before any write; a zero-row job UPDATE commits no money; the charger drops a work item on a hung Redis and never throws into the reaper; the reconciler isolates per-client failures. Blast radius is one job / one client, never the number. No wallet code writes `health_state`/`pause_reason` (asserted byte-identical).
3. **idempotency at storage** — PASS with the documented caveat. The guard PK `(send_attempt_id, kind, created_at)` sits on a PARTITIONED table (the one blueprint exemption, ADR 0019 §1); it is a true authority because every writer stamps `created_at` from the job row in-statement (ADR 0038 §1), proven by `a_repair_across_a_month_boundary_still_charges_once`, the partitioning edge-case test and the reconciler's check B. Refund/adjustment guards use the same key.
4. **tenant isolation** — PASS. All three new tables lead with `client_id NOT NULL`, carry RLS ENABLE+FORCE + `tenant_isolation` (parent and every guard partition), are in `TENANT_TABLE_COVERAGE`/`TENANT_TABLES`, seeded in suite A; cross-tenant reads are 7 read-only SECURITY DEFINER functions (owner wp_admin_app, EXECUTE wp_scheduler) registered in `CROSS_TENANT_QUERIES`; every write is per tenant via `withTenant`; suite B covers charger, rollup and reconciler as two-tenant background paths.
5. **pause preserves work** — PASS. No new job state, no delete, no fail; the wallet stop itself (state `empty`) is P19's claim-side behaviour and touches no queued job.
6. **no evasion** — PASS. No rotation/proxy/fingerprint/auto-resume; nothing tenant-settable loosens a limit; no new tenant-facing copy strings (pricing strings are internal doc comments only; placeholders stay placeholders). `check-copy` scan green.
7. **tests are evidence** — PASS. Every unit reported verbatim tails; the one full-gate tail is pasted under C5 below.

## Open items carried forward (NOT done in P18)
- No monthly **checkpoint writer** exists (`checkpoint_seq`/`checkpoint_balance_minor` stay 0), so check A's checkpoint anchor is inert until one is added (P19 or P28); continuity over the last 200 entries and the balance identity hold today.
- Reconciler findings are **not deduplicated**: a persistent A/D anomaly is re-reported every hourly sweep until fixed (design choice; P28 may add a dedupe key).
- A refund that lifts `empty → active` must **publish a wake** (ADR 0019 §5) — P19's wake machinery; a `// P19:` marker sits in `refund.ts`.
- `roles/cron.ts` runs the charger only when `REDIS_URL` is set; otherwise one warn and check B is the sole charger. Deploy config must set it for the cron role.
- Reviewer NOTE-6 (shared guard-kind constant), NOTE-7 (`wallet-stamp-guard` per-partition probe), MINOR-5 (no finding on a transient check-B no-op) — filed, not fixed.
- The persistent dev DB's "Queue Fixture Client 1-5" wallets carry balances with no ledger rows and are correctly reported as drift by check A on every dev sweep (dev-only noise).
- `scripts/check-tenant-scope.ts` is at exactly 300 lines; the next table addition must reclaim prose first.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P19 — the zero-balance stop, top-up requests and a minimal staff credit path. Read
plan/v1/P19-wallet-stop-and-topups.md (plan/README.md's P19 row is authoritative for the exact filename)
and follow it exactly: one phase, one session. Deps P18 and P12 are done (see plan/README.md).
Do not start P20. Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
