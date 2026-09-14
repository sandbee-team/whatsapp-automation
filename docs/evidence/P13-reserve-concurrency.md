# P13 evidence — `reserve()` atomicity under parallel load + local latency

**What this evidences:** P13 step 7's core claim — `reserve-pacing.sql`'s single conditional `UPDATE` is
genuinely atomic under real parallel Postgres connections (not merely correct in a single-threaded read) —
plus a local `reserve()` round-trip latency measurement captured while producing this artefact (P13a Unit
U2, step 10).

**Date:** 2026-09-02
**Machine context:** Windows 11 dev box; PostgreSQL 17 + Redis 7 in Docker Desktop, reachable at
`127.0.0.1:55432` (Postgres) / `127.0.0.1:56379` (Redis). Single local machine, single Postgres instance, no
network hop, no connection pooler (PgBouncer) in front of it for this run.

**Caveat (read before citing this anywhere):** this is a **local dev measurement**, not the P26 load proof.
It has no concurrent CPU/IO contention from other tenants, no PgBouncer transaction-mode pooling overhead,
and one Postgres instance on the same physical machine as the test runner. Treat the numbers below as a
sanity check that `reserve()` is fast enough to not be the pacing bottleneck at dev scale — not as a
capacity or SLO number for production traffic. The atomicity result (grant/deny counts) is a genuine proof
regardless of scale; the latency numbers are not.

## 1. Verbatim test run

Test: `reserve_is_atomic_under_50_parallel_claims`, in
`app/backend/src/engine/pacing/reserve-concurrency.integration.test.ts`. The committed test runs **200
iterations** (4 rounds of 50 concurrent `reserve()` calls each, `for (let iteration = 0; iteration < 200 /
50; iteration += 1)`), against an instance seeded with `dailyCap: 10` — so the atomicity invariant proven is
"exactly 10 grants, exactly 190 denies, `pacing_ledger.consumed_count = 10`" out of 200 total concurrent
attempts across the 4 rounds.

Command:

```
cd app/backend
vitest run --config vitest.config.ts src/engine/pacing/reserve-concurrency.integration.test.ts --reporter=verbose
```

Verbatim output (whole file, all 4 tests in this suite — the atomicity/concurrency test set P13 Unit U4
wrote):

```
 RUN  v4.1.11 D:/kd/wp/app/backend

stdout | src/engine/pacing/reserve-concurrency.integration.test.ts > reserve() atomicity under parallel load > reserve_is_atomic_under_50_parallel_claims
[reserve_is_atomic_under_50_parallel_claims] n=200 p50=61.96ms p95=126.26ms p99=133.55ms

 ✓ src/engine/pacing/reserve-concurrency.integration.test.ts > reserve() atomicity under parallel load > reserve_is_atomic_under_50_parallel_claims 425ms
 ✓ src/engine/pacing/reserve-concurrency.integration.test.ts > reserve() atomicity under parallel load > parallel_group_claims_never_exceed_eff_group_daily_cap 66ms
 ✓ src/engine/pacing/reserve-concurrency.integration.test.ts > reserve() atomicity under parallel load > tier_below_4_yields_zero_group_sends 21ms
 ✓ src/engine/pacing/reserve-concurrency.integration.test.ts > reserve() atomicity under parallel load > new_conversation_cap_and_cold_ratio_are_atomic 49ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  11:03:02
   Duration  1.75s (transform 305ms, setup 19ms, import 1.04s, tests 564ms, environment 0ms)
```

Every assertion in `reserve_is_atomic_under_50_parallel_claims` is on the **exact** count the DB constraint
enforces (`grants === 10`, `denies === 190`, `pacing_ledger.consumed_count === 10`) — the concurrency
invariant itself, never a sampled/bounded outcome.

## 2. `reserve()` latency (p50 / p95 / p99)

Measured **in-process**, wrapping each individual `reserve()` call inside the 200-iteration loop above with
`performance.now()` immediately before the call and immediately after it resolves — so each sample includes
one client↔PG round trip on localhost (the `ensurePacingLedgerRow` + `ensureDailyUsageRow` + the
`reserve-pacing.sql` conditional `UPDATE` itself; a denial's `pacing-deny-reason.sql` follow-up query is
included when a call is denied, since that follow-up is part of what the caller actually waited on). This is
a non-asserting capture only (`.claude/rules/core-invariants.md`'s "no ambient-state assertions" rule) — it
logs a summary and asserts nothing about timing.

| Percentile | Latency   |
| ---------- | --------- |
| p50        | 61.96 ms  |
| p95        | 126.26 ms |
| p99        | 133.55 ms |

**Sample count:** n = 200 (every call across all 4 rounds of 50 concurrent `reserve()` invocations,
regardless of grant/deny outcome).

**Method note:** all 200 calls in a round are issued concurrently via `Promise.all`, so each sample's
latency reflects real contention on the same `pacing_ledger` row (50-way concurrent `UPDATE`s racing against
one row) — this is not an isolated best-case single-connection latency number, which is why p50 (~62 ms) is
noticeably higher than a single uncontended `reserve()` call would be. It is, however, a fair number for
"how long does a `reserve()` call take when four instances' worth of eligible jobs all become claimable
inside the same tick" — a realistic worst case for this repo's actual claim-loop shape, at dev-machine scale
only (see caveat above).
