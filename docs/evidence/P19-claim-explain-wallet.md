# P19 Unit U3 — wallet-gate `EXPLAIN` evidence

Date: 2026-09-04.

Scope: re-run of the `db/tests/claim-plan.test.ts` self-seeded EXPLAIN
capture (`explainClaim()`, same helper the file's own
`claim_plan_uses_message_jobs_claim_idx_and_never_seq_scans` case uses),
proving the ADR 0019 S4 wallet-stop predicates already in
`db/queries/claim-jobs.sql` (`w.state NOT IN ('empty','frozen') AND
w.balance_minor >= w.max_rate_minor`) resolve `wallet_accounts` via an index
probe on its own primary key, not a scan proportional to table size. This
file does NOT edit `db/queries/claim-jobs.sql` — the statement captured
below is byte-identical to the one P03 captured; only the fixture changed.

## Why a fresh capture, not a reuse of P03's

`docs/evidence/P03-claim-explain.md` (2026-08-26/27) already shows
`wallet_accounts` in every one of its captures — but as a
`Seq Scan on wallet_accounts w (cost=0.00..2.05 rows=1)` (capture 1) /
`(cost=0.00..3.16 rows=1)` (ADR 0026 capture 2), never an index scan. That
is legitimate, correct planner behaviour for a genuinely tiny table (P03's
fixture seeds exactly 5 `wallet_accounts` rows) — a Seq Scan over 1-4 rows
is cheaper than an index probe, and Postgres is right to pick it. The P19
dispatch anticipated this exact finding and asked for a fixture where
`wallet_accounts` has real cardinality, so the planner's GENUINE preference
(not an assumption) can be observed. This capture seeds **5,000** throwaway
`wallet_accounts` rows (`seedManyWalletAccountsForCardinality`,
`db/tests/helpers/claim-plan-fixture.ts`) alongside `claim-plan.test.ts`'s
existing self-seeded 15-instance/300-job-each fixture
(`seedPlanRepresentativeFixture`), then re-runs the identical
`EXPLAIN (ANALYZE, BUFFERS)` of the exact loaded `claim-jobs` statement,
inside a `BEGIN; ... ROLLBACK;` transaction (same as P03 — `EXPLAIN ANALYZE`
really executes the UPDATE, so a claim was genuinely taken and then undone).

## Fixture parameters used

| Param                         | Value                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wallet_accounts` cardinality | 5,000 throwaway single-wallet clients (`seedManyWalletAccountsForCardinality`) + the probe's own 1 client's wallet — 5,001 total rows in the table at capture time |
| `$client_id`                  | `e11539b8-d832-4d2d-b974-dd92288c7754` (self-seeded probe client, `seedPlanRepresentativeFixture`)                                                                 |
| `$instance_id`                | `277de753-f28e-4b11-8ecb-155f6b5cb3e8` (that client's instance 0 of 15)                                                                                            |
| `$band` (`priority_rank`)     | `10` (high) — `claim-plan.test.ts`'s own `PROBE_BAND`                                                                                                              |
| `$fence`                      | `7` (`PROBE_FENCE`, `db/tests/helpers/claim-plan-fixture.ts`)                                                                                                      |
| `$worker`                     | `claim-plan-test`                                                                                                                                                  |
| `$claim_expiry_ms`            | `30000`                                                                                                                                                            |
| probe client's own wallet     | `state='active'`, `balance_minor=100_000`, `max_rate_minor=100` (ample balance, matches `seedPlanRepresentativeFixture`'s existing seed — unchanged by this unit)  |

This is a **selective** single-client probe (`wallet_accounts` has 5,001
rows total; the claim only ever needs exactly 1 of them, keyed by
`client_id`) — the realistic shape a claim actually runs under: one instance
claiming for one already-known client, never a cross-tenant wallet scan.

## Verbatim `EXPLAIN (ANALYZE, BUFFERS)` capture

```
Update on message_jobs j  (cost=20.46..57.49 rows=1 width=142) (actual time=0.159..0.163 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Update on message_jobs_y2026m11 j_4
  Buffers: shared hit=52
  CTE eligible
    ->  Limit  (cost=2.26..20.19 rows=1 width=64) (actual time=0.048..0.051 rows=1 loops=1)
          Buffers: shared hit=24
          ->  LockRows  (cost=2.26..934.56 rows=52 width=64) (actual time=0.048..0.050 rows=1 loops=1)
                Buffers: shared hit=24
                ->  Nested Loop Left Join  (cost=2.26..934.04 rows=52 width=64) (actual time=0.045..0.047 rows=1 loops=1)
                      Join Filter: (cp.id = j_5.campaign_id)
                      Filter: ((j_5.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                      Buffers: shared hit=23
                      ->  Nested Loop  (cost=2.26..932.13 rows=52 width=90) (actual time=0.041..0.043 rows=1 loops=1)
                            Join Filter: (i.session_epoch = j_5.session_epoch)
                            Buffers: shared hit=22
                            ->  Merge Append  (cost=1.16..898.13 rows=52 width=86) (actual time=0.019..0.020 rows=1 loops=1)
                                  Sort Key: j_5.next_attempt_at, j_5.id
                                  Buffers: shared hit=10
                                  ->  Index Scan using message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m08 j_6  (cost=0.28..540.59 rows=25 width=86) (actual time=0.008..0.008 rows=1 loops=1)
                                        Index Cond: ((client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid) AND (instance_id = '277de753-f28e-4b11-8ecb-155f6b5cb3e8'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                                  ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_7  (cost=0.28..344.59 rows=25 width=86) (actual time=0.005..0.005 rows=1 loops=1)
                                        Index Cond: ((client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid) AND (instance_id = '277de753-f28e-4b11-8ecb-155f6b5cb3e8'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                                  ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_8  (cost=0.28..6.06 rows=1 width=86) (actual time=0.003..0.003 rows=0 loops=1)
                                        Index Cond: ((client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid) AND (instance_id = '277de753-f28e-4b11-8ecb-155f6b5cb3e8'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=2
                                  ->  Index Scan using message_jobs_y2026m11_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m11 j_9  (cost=0.28..6.06 rows=1 width=86) (actual time=0.003..0.003 rows=0 loops=1)
                                        Index Cond: ((client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid) AND (instance_id = '277de753-f28e-4b11-8ecb-155f6b5cb3e8'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=2
                            ->  Materialize  (cost=1.10..33.22 rows=1 width=124) (actual time=0.021..0.022 rows=1 loops=1)
                                  Buffers: shared hit=12
                                  ->  Nested Loop  (cost=1.10..33.22 rows=1 width=124) (actual time=0.020..0.021 rows=1 loops=1)
                                        Buffers: shared hit=12
                                        ->  Nested Loop  (cost=0.82..24.90 rows=1 width=102) (actual time=0.014..0.015 rows=1 loops=1)
                                              Buffers: shared hit=9
                                              ->  Nested Loop  (cost=0.54..16.59 rows=1 width=80) (actual time=0.010..0.010 rows=1 loops=1)
                                                    Buffers: shared hit=6
                                                    ->  Index Scan using whatsapp_instances_client_idx on whatsapp_instances i  (cost=0.27..8.29 rows=1 width=42) (actual time=0.006..0.006 rows=1 loops=1)
                                                          Index Cond: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
                                                          Filter: ((deleted_at IS NULL) AND (id = '277de753-f28e-4b11-8ecb-155f6b5cb3e8'::uuid) AND (health_state = 'connected'::wa_health))
                                                          Rows Removed by Filter: 14
                                                          Buffers: shared hit=3
                                                    ->  Index Scan using instance_lease_state_client_idx on instance_lease_state ls  (cost=0.27..8.29 rows=1 width=38) (actual time=0.004..0.004 rows=1 loops=1)
                                                          Index Cond: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
                                                          Filter: ((instance_id = '277de753-f28e-4b11-8ecb-155f6b5cb3e8'::uuid) AND (current_fence = '7'::bigint))
                                                          Buffers: shared hit=3
                                              ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.30 rows=1 width=22) (actual time=0.004..0.004 rows=1 loops=1)
                                                    Index Cond: (id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
                                                    Filter: (status = 'active'::client_status)
                                                    Buffers: shared hit=3
                                        ->  Index Scan using wallet_accounts_pkey on wallet_accounts w  (cost=0.28..8.31 rows=1 width=22) (actual time=0.005..0.005 rows=1 loops=1)
                                              Index Cond: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
                                              Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor))
                                              Buffers: shared hit=3
                      ->  Materialize  (cost=0.00..1.00 rows=1 width=42) (actual time=0.003..0.003 rows=0 loops=1)
                            Buffers: shared hit=1
                            ->  Seq Scan on campaigns cp  (cost=0.00..1.00 rows=1 width=42) (actual time=0.003..0.003 rows=0 loops=1)
                                  Filter: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
                                  Buffers: shared hit=1
  ->  Nested Loop  (cost=0.28..37.30 rows=1 width=142) (actual time=0.080..0.081 rows=1 loops=1)
        Buffers: shared hit=27
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=0.054..0.055 rows=1 loops=1)
              Buffers: shared hit=24
        ->  Append  (cost=0.28..37.22 rows=4 width=26) (actual time=0.005..0.005 rows=1 loops=1)
              Buffers: shared hit=3
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.28..12.30 rows=1 width=26) (actual time=0.004..0.004 rows=1 loops=1)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
                    Buffers: shared hit=3
              ->  Index Scan using message_jobs_y2026m09_pkey on message_jobs_y2026m09 j_2  (cost=0.28..8.30 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m10_pkey on message_jobs_y2026m10 j_3  (cost=0.28..8.30 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m11_pkey on message_jobs_y2026m11 j_4  (cost=0.28..8.30 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
Planning:
  Buffers: shared hit=791
Planning Time: 1.884 ms
Execution Time: 0.253 ms
```

(4 `message_jobs` monthly partitions appear here, not P03's 3 —
`claim-plan.test.ts`'s fixture derives its bucket list from whatever
partitions actually exist in the catalog at run time, unrelated to this
unit's wallet change; see that file's own header comment.)

## `wallet_accounts` access method — interpretation

```
->  Index Scan using wallet_accounts_pkey on wallet_accounts w  (cost=0.28..8.31 rows=1 width=22) (actual time=0.005..0.005 rows=1 loops=1)
      Index Cond: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
      Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor))
      Buffers: shared hit=3
```

- **Access method: `Index Scan using wallet_accounts_pkey`** — an index
  probe, never a scan. `wallet_accounts.client_id` is the table's own
  primary key (`db/migrations/0004_wallet_and_pricing.sql`), so this is the
  narrowest possible access path: the planner walks straight to the one row
  for this client via the PK, then evaluates the two ADR 0019 S4 predicates
  (`state NOT IN ('empty','frozen')`, `balance_minor >= max_rate_minor`) as
  a post-probe `Filter:` on that single candidate row — never a condition
  that could match more than one row, so there is no "which rows pass the
  filter" scan component at all.
- **`loops=1`**: the wallet probe executes exactly once for this claim, not
  once per candidate job or once per partition — confirms it is a single
  client-scoped lookup, not a scan proportional to `message_jobs` candidate
  count or `wallet_accounts` table size.
- **No `Seq Scan on wallet_accounts` anywhere in this plan** (verified by
  the same substring assertion `claim-plan.test.ts`'s new
  `claim_plan_probes_wallet_accounts_by_primary_key_and_never_scans_it` case
  runs against every capture, not just this one-off).
- **`cost=0.28..8.31`, `actual time=0.005ms`, `Buffers: shared hit=3`**: cheap
  and dominated by shared-buffer hits, consistent with a single indexed
  row-lookup on a table now holding 5,001 rows.

## Diff against `docs/evidence/P03-claim-explain.md`

The single meaningful difference is the `wallet_accounts` access method,
directly caused by table cardinality (5 rows in P03's fixture vs 5,001 here)
— not a change to `claim-jobs.sql`, which is byte-identical in both
captures:

```diff
- ->  Seq Scan on wallet_accounts w  (cost=0.00..2.05 rows=1 width=22) (actual time=0.003..0.004 rows=1 loops=1)
-       Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid))
-       Rows Removed by Filter: 1
-       Buffers: shared hit=2
+ ->  Index Scan using wallet_accounts_pkey on wallet_accounts w  (cost=0.28..8.31 rows=1 width=22) (actual time=0.005..0.005 rows=1 loops=1)
+       Index Cond: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
+       Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor))
+       Buffers: shared hit=3
```

Everything else — `message_jobs` access exclusively via per-partition
children of `message_jobs_claim_idx`, no `Seq Scan on message_jobs`
anywhere, `whatsapp_instances`/`instance_lease_state`/`clients` each a
cheap single-row probe, `campaigns` a `Seq Scan` on an empty table (correct,
cheapest plan for zero rows) — matches P03's finding shape unchanged. P03's
own finding (d) already established that BOTH the Seq Scan and (at higher
selectivity) an Index Scan are legitimate, fast plans for this tiny table;
this capture does not contradict that, it demonstrates the specific
condition (real cardinality) under which the planner's own choice flips to
the index probe the phase's step 10 asked to observe.

## Conclusion

`db/queries/claim-jobs.sql`'s wallet-stop predicates resolve
`wallet_accounts` via a single-row, `client_id`-keyed index probe
(`wallet_accounts_pkey`) once the table has realistic cardinality, `loops=1`
every time, never a `Seq Scan` at this row count, and never a second/
repeated scan. At P19's actual production table size (5,000+ clients, one
wallet row each) this is exactly the access pattern the phase requires. No
change to `claim-jobs.sql` was made or is warranted by this evidence.

## Fixture/run commands used

```
cd db
npx vitest run --config vitest.config.ts tests/claim-plan.test.ts
```

(The verbatim capture above was produced by a throwaway script that called
the exact same `seedManyWalletAccountsForCardinality` +
`seedPlanRepresentativeFixture` + `explainClaim` helpers
`claim-plan.test.ts`'s own new case uses, deleted after this evidence file
was written — the automated test is the reusable, re-runnable proof; this
document is its evidence artefact.)
