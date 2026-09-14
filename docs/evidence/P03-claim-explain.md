# P03 Unit D — claim-jobs.sql EXPLAIN evidence

Date: 2026-08-26 (original captures); regenerated 2026-08-27 for ADR 0026
(P03 close, C1 CRITICAL fix — the `i`/`ls` joins are now tenant-qualified:
`JOIN whatsapp_instances i ON i.id = j.instance_id AND i.client_id =
j.client_id` and `JOIN instance_lease_state ls ON ls.instance_id =
j.instance_id AND ls.client_id = j.client_id`).

Scope: `EXPLAIN (ANALYZE, BUFFERS)` of the exact, byte-unmodified statement in
`db/queries/claim-jobs.sql`, run against the fixture in
`db/seeds/queue-explain-fixture.sql` (200,000 `queued` `message_jobs` rows,
5 clients × 10 instances × 4,000 jobs, spread 70/20/10 across the current +
next-2-month partitions). All captures below ran **inside a transaction that
was rolled back** (`BEGIN; ... EXPLAIN (ANALYZE, BUFFERS) <statement>; ...
ROLLBACK;`) — `EXPLAIN ANALYZE` really executes the UPDATE, so a claim was
genuinely taken and then undone each time, never left committed.

**ADR 0026 regeneration result: the plan shape is UNCHANGED.** Both new
captures below (2026-08-27, against the amended statement) still show: no
`Seq Scan on message_jobs` anywhere, every `message_jobs` access via a
per-partition child of `message_jobs_claim_idx`, and the `i`/`ls` joins
remain cheap single-row probes (`i.id = $instance_id` is still the sole
qualifying condition Postgres can use for an index/seq scan — a table
lookup on `whatsapp_instances`/`instance_lease_state`'s tiny row count either
way — the new `AND i.client_id = j.client_id` / `AND ls.client_id =
j.client_id` predicates land as an extra `Filter:` clause on that same
single-row probe, not a new scan). The original two 2026-08-26 captures are
kept below for the still-relevant Sort-node data-dependency finding (d);
they predate ADR 0026 and used the pre-amendment statement (no `client_id`
predicate on the `i`/`ls` joins) — superseded for index/Seq-Scan purposes by
the new captures, not deleted, since finding (d)'s root-cause analysis is
still accurate and unaffected by the amendment (it concerns the `message_jobs`
read side, which the amendment does not touch).

## (e) Fixture parameters used

| Param                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `$client_id`              | `a0000000-0000-4000-a000-000000000001` (fixture client 1)             |
| `$instance_id`            | `b0000000-0000-4000-a000-000000000101` (fixture client 1, instance 1) |
| `$band` (`priority_rank`) | `10` (high)                                                           |
| `$fence`                  | `7` (every fixture `instance_lease_state.current_fence`)              |
| `$worker`                 | `explain-probe`                                                       |
| `$claim_expiry_ms`        | `30000`                                                               |
| `$ledger_date`            | `2026-08-26`                                                          |

This `(client, instance)` pair has 4,000 jobs total; of the 1,333 in band 10,
~933 have `next_attempt_at <= now()` (the current-month, "mostly eligible
now" 70% bucket the fixture's header describes) — i.e. this probe is
deliberately **not** a trivially-selective lookup, it is the fixture's
heaviest realistic single-instance backlog case.

## (a0) ADR 0026 — amended-statement captures (2026-08-27)

Same fixture params as (e) above, same amended `db/queries/claim-jobs.sql`
(the tenant-qualified `i`/`ls` joins). Two captures, one immediately after an
explicit `ANALYZE message_jobs`, to check the amendment doesn't introduce its
own stats-sensitivity — it does not; both are structurally identical to each
other and to the pre-amendment shape.

Note the `Index Cond` band bind below reads `(priority_rank = 10)`, plain
integer, versus `(priority_rank = '10'::smallint)` in section (a)'s
pre-ADR-0026 capture — an artifact of how each capture's driver bound the
parameter, not a behavioral difference: both resolve to the same
`smallint` value and the planner picks the identical per-partition child
index either way (see (b)).

### ADR 0026 capture 1 (before an explicit re-`ANALYZE`)

```
Update on message_jobs j  (cost=6.59..31.32 rows=1 width=146) (actual time=0.512..0.517 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Buffers: shared hit=37 read=19 dirtied=11
  CTE eligible
    ->  Limit  (cost=1.57..6.17 rows=1 width=64) (actual time=0.252..0.255 rows=1 loops=1)
          Buffers: shared hit=8 read=15 dirtied=8
          ->  LockRows  (cost=1.57..917.12 rows=199 width=64) (actual time=0.250..0.253 rows=1 loops=1)
                Buffers: shared hit=8 read=15 dirtied=8
                ->  Nested Loop Left Join  (cost=1.57..915.13 rows=199 width=64) (actual time=0.241..0.244 rows=1 loops=1)
                      Filter: ((j_4.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                      Buffers: shared hit=7 read=15 dirtied=8
                      ->  Nested Loop  (cost=1.42..830.81 rows=199 width=90) (actual time=0.235..0.238 rows=1 loops=1)
                            Join Filter: (i.session_epoch = j_4.session_epoch)
                            Buffers: shared hit=7 read=15 dirtied=8
                            ->  Merge Append  (cost=1.28..806.40 rows=199 width=86) (actual time=0.149..0.150 rows=1 loops=1)
                                  Sort Key: j_4.next_attempt_at, j_4.id
                                  Buffers: shared hit=7 read=7 dirtied=2
                                  ->  Index Scan using message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m08 j_5  (cost=0.42..786.91 rows=197 width=86) (actual time=0.107..0.108 rows=1 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = 10) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=4 read=4 dirtied=2
                                  ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_6  (cost=0.42..8.45 rows=1 width=86) (actual time=0.024..0.024 rows=0 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = 10) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=1 read=2
                                  ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_7  (cost=0.41..8.45 rows=1 width=86) (actual time=0.016..0.016 rows=0 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = 10) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=2 read=1
                            ->  Materialize  (cost=0.14..21.43 rows=1 width=124) (actual time=0.083..0.084 rows=1 loops=1)
                                  Buffers: shared read=8 dirtied=6
                                  ->  Nested Loop  (cost=0.14..21.43 rows=1 width=124) (actual time=0.078..0.079 rows=1 loops=1)
                                        Buffers: shared read=8 dirtied=6
                                        ->  Nested Loop  (cost=0.14..17.10 rows=1 width=102) (actual time=0.056..0.057 rows=1 loops=1)
                                              Buffers: shared read=5 dirtied=4
                                              ->  Nested Loop  (cost=0.14..15.96 rows=1 width=80) (actual time=0.046..0.047 rows=1 loops=1)
                                                    Buffers: shared read=4 dirtied=3
                                                    ->  Index Scan using whatsapp_instances_pkey on whatsapp_instances i  (cost=0.14..8.17 rows=1 width=42) (actual time=0.023..0.023 rows=1 loops=1)
                                                          Index Cond: (id = 'b0000000-0000-4000-a000-000000000101'::uuid)
                                                          Filter: ((deleted_at IS NULL) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (health_state = 'connected'::wa_health))
                                                          Buffers: shared read=3 dirtied=2
                                                    ->  Seq Scan on instance_lease_state ls  (cost=0.00..7.78 rows=1 width=38) (actual time=0.022..0.022 rows=1 loops=1)
                                                          Filter: ((instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (current_fence = 7))
                                                          Rows Removed by Filter: 4
                                                          Buffers: shared read=1 dirtied=1
                                              ->  Seq Scan on clients c  (cost=0.00..1.14 rows=1 width=22) (actual time=0.010..0.010 rows=1 loops=1)
                                                    Filter: ((id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (status = 'active'::client_status))
                                                    Rows Removed by Filter: 4
                                                    Buffers: shared read=1 dirtied=1
                                        ->  Seq Scan on wallet_accounts w  (cost=0.00..4.32 rows=1 width=22) (actual time=0.020..0.021 rows=1 loops=1)
                                              Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid))
                                              Rows Removed by Filter: 4
                                              Buffers: shared read=3 dirtied=2
                      ->  Index Scan using campaigns_pkey on campaigns cp  (cost=0.15..0.41 rows=1 width=42) (actual time=0.004..0.004 rows=0 loops=1)
                            Index Cond: (id = j_4.campaign_id)
                            Filter: (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid)
  ->  Nested Loop  (cost=0.42..25.15 rows=1 width=146) (actual time=0.338..0.339 rows=1 loops=1)
        Buffers: shared hit=11 read=16 dirtied=8
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=0.260..0.261 rows=1 loops=1)
              Buffers: shared hit=8 read=15 dirtied=8
        ->  Append  (cost=0.42..25.08 rows=3 width=26) (actual time=0.053..0.054 rows=1 loops=1)
              Buffers: shared hit=3 read=1
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.42..8.44 rows=1 width=26) (actual time=0.050..0.050 rows=1 loops=1)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
                    Buffers: shared hit=3 read=1
              ->  Index Scan using message_jobs_y2026m09_pkey on message_jobs_y2026m09 j_2  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m10_pkey on message_jobs_y2026m10 j_3  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
Planning:
  Buffers: shared hit=1174 read=99
Planning Time: 10.516 ms
Execution Time: 1.641 ms
```

### ADR 0026 capture 2 (immediately after an explicit `ANALYZE message_jobs`)

```
Update on message_jobs j  (cost=5.87..30.60 rows=1 width=146) (actual time=0.293..0.297 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Buffers: shared hit=61 dirtied=2
  CTE eligible
    ->  Limit  (cost=1.28..5.45 rows=1 width=64) (actual time=0.117..0.119 rows=1 loops=1)
          Buffers: shared hit=27
          ->  LockRows  (cost=1.28..752.43 rows=180 width=64) (actual time=0.116..0.118 rows=1 loops=1)
                Buffers: shared hit=27
                ->  Nested Loop Left Join  (cost=1.28..750.63 rows=180 width=64) (actual time=0.099..0.102 rows=1 loops=1)
                      Join Filter: (cp.id = j_4.campaign_id)
                      Filter: ((j_4.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                      Buffers: shared hit=25
                      ->  Nested Loop  (cost=1.28..746.47 rows=180 width=90) (actual time=0.088..0.090 rows=1 loops=1)
                            Join Filter: (i.session_epoch = j_4.session_epoch)
                            Buffers: shared hit=24
                            ->  Merge Append  (cost=1.28..730.56 rows=180 width=86) (actual time=0.058..0.059 rows=1 loops=1)
                                  Sort Key: j_4.next_attempt_at, j_4.id
                                  Buffers: shared hit=13
                                  ->  Index Scan using message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m08 j_5  (cost=0.42..711.31 rows=178 width=86) (actual time=0.034..0.034 rows=1 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = 10) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=7
                                  ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_6  (cost=0.42..8.45 rows=1 width=86) (actual time=0.011..0.011 rows=0 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = 10) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                                  ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_7  (cost=0.41..8.45 rows=1 width=86) (actual time=0.012..0.012 rows=0 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = 10) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                            ->  Materialize  (cost=0.00..13.22 rows=1 width=124) (actual time=0.029..0.030 rows=1 loops=1)
                                  Buffers: shared hit=11
                                  ->  Nested Loop  (cost=0.00..13.21 rows=1 width=124) (actual time=0.026..0.027 rows=1 loops=1)
                                        Buffers: shared hit=11
                                        ->  Nested Loop  (cost=0.00..10.04 rows=1 width=102) (actual time=0.020..0.021 rows=1 loops=1)
                                              Buffers: shared hit=8
                                              ->  Nested Loop  (cost=0.00..8.90 rows=1 width=80) (actual time=0.017..0.017 rows=1 loops=1)
                                                    Buffers: shared hit=7
                                                    ->  Seq Scan on whatsapp_instances i  (cost=0.00..5.95 rows=1 width=42) (actual time=0.011..0.011 rows=1 loops=1)
                                                          Filter: ((deleted_at IS NULL) AND (id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (health_state = 'connected'::wa_health))
                                                          Rows Removed by Filter: 7
                                                          Buffers: shared hit=5
                                                    ->  Seq Scan on instance_lease_state ls  (cost=0.00..2.95 rows=1 width=38) (actual time=0.006..0.006 rows=1 loops=1)
                                                          Filter: ((instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (current_fence = 7))
                                                          Rows Removed by Filter: 4
                                                          Buffers: shared hit=2
                                              ->  Seq Scan on clients c  (cost=0.00..1.14 rows=1 width=22) (actual time=0.003..0.003 rows=1 loops=1)
                                                    Filter: ((id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (status = 'active'::client_status))
                                                    Rows Removed by Filter: 4
                                                    Buffers: shared hit=1
                                        ->  Seq Scan on wallet_accounts w  (cost=0.00..3.16 rows=1 width=22) (actual time=0.005..0.005 rows=1 loops=1)
                                              Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid))
                                              Rows Removed by Filter: 4
                                              Buffers: shared hit=3
                      ->  Materialize  (cost=0.00..1.00 rows=1 width=42) (actual time=0.010..0.010 rows=0 loops=1)
                            Buffers: shared hit=1
                            ->  Seq Scan on campaigns cp  (cost=0.00..1.00 rows=1 width=42) (actual time=0.007..0.007 rows=0 loops=1)
                                  Filter: (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid)
                                  Buffers: shared hit=1
  ->  Nested Loop  (cost=0.42..25.14 rows=1 width=146) (actual time=0.166..0.167 rows=1 loops=1)
        Buffers: shared hit=31
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=0.125..0.125 rows=1 loops=1)
              Buffers: shared hit=27
        ->  Append  (cost=0.42..25.08 rows=3 width=26) (actual time=0.021..0.021 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.42..8.44 rows=1 width=26) (actual time=0.019..0.019 rows=1 loops=1)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
                    Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m09_pkey on message_jobs_y2026m09 j_2  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m10_pkey on message_jobs_y2026m10 j_3  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
Planning:
  Buffers: shared hit=1273
Planning Time: 5.118 ms
Execution Time: 0.581 ms
```

**ADR 0026 finding:** in both new captures, `whatsapp_instances i` and
`instance_lease_state ls` resolve via a single-row probe keyed on
`id`/`instance_id` (an `Index Scan using whatsapp_instances_pkey` in capture
1, a cost-`5.95`/`2.95` `Seq Scan` with an equality `Filter` in capture 2 —
the same kind of plan-shape variance already documented in finding (d) below
for these tiny tables, not something the amendment introduced) — the added
`AND i.client_id = j.client_id` / `AND ls.client_id = j.client_id` predicates
show up as one extra clause inside that same `Filter:`/`Index Cond:` line,
never a second scan or a join reordering. Cost and actual-time for both nodes
stay in the same single-digit-cost, sub-millisecond range as the
pre-amendment captures below. `db/tests/claim-plan.test.ts`
(`claim_plan_uses_message_jobs_claim_idx_and_never_seq_scans`) reran green
against the amended statement in this same session — see the session's own
test output for its independent, automated confirmation of "no `Seq Scan on
message_jobs`, no genuine `Sort` node" on its own smaller fixture.

## (a) Verbatim EXPLAIN output (2026-08-26, pre-ADR-0026 statement)

Two captures are shown. They are **the same statement, the same bind values,
against the same unmodified fixture data** — the only thing that differed
between them was which random sample `ANALYZE message_jobs` happened to draw
immediately beforehand. See finding (d) for why both are reported rather than
picking the one that "looks nicer." Kept for the Sort-node data-dependency
finding (d), which the ADR 0026 amendment does not affect (see (a0) above for
the current, amended-statement captures).

### Capture 1 — clean plan (immediately after a fresh `ANALYZE message_jobs`)

```
Update on message_jobs j  (cost=6.41..31.14 rows=1 width=146) (actual time=0.193..0.197 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Buffers: shared hit=50 dirtied=1
  CTE eligible
    ->  Limit  (cost=1.43..5.99 rows=1 width=64) (actual time=0.057..0.060 rows=1 loops=1)
          Buffers: shared hit=19 dirtied=1
          ->  LockRows  (cost=1.43..858.89 rows=188 width=64) (actual time=0.057..0.059 rows=1 loops=1)
                Buffers: shared hit=19 dirtied=1
                ->  Nested Loop Left Join  (cost=1.43..857.01 rows=188 width=64) (actual time=0.049..0.051 rows=1 loops=1)
                      Filter: ((j_4.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                      Buffers: shared hit=18
                      ->  Nested Loop  (cost=1.28..778.70 rows=188 width=90) (actual time=0.047..0.049 rows=1 loops=1)
                            Join Filter: (i.session_epoch = j_4.session_epoch)
                            Buffers: shared hit=18
                            ->  Nested Loop  (cost=1.28..769.25 rows=188 width=98) (actual time=0.037..0.038 rows=1 loops=1)
                                  Buffers: shared hit=13
                                  ->  Merge Append  (cost=1.28..763.70 rows=188 width=86) (actual time=0.026..0.027 rows=1 loops=1)
                                        Sort Key: j_4.next_attempt_at, j_4.id
                                        Buffers: shared hit=10
                                        ->  Index Scan using message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m08 j_5  (cost=0.42..744.34 rows=186 width=86) (actual time=0.016..0.016 rows=1 loops=1)
                                              Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                              Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                              Buffers: shared hit=4
                                        ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_6  (cost=0.42..8.45 rows=1 width=86) (actual time=0.007..0.007 rows=0 loops=1)
                                              Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                              Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                              Buffers: shared hit=3
                                        ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_7  (cost=0.41..8.45 rows=1 width=86) (actual time=0.003..0.003 rows=0 loops=1)
                                              Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                              Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                              Buffers: shared hit=3
                                  ->  Materialize  (cost=0.00..3.20 rows=1 width=44) (actual time=0.010..0.010 rows=1 loops=1)
                                        Buffers: shared hit=3
                                        ->  Nested Loop  (cost=0.00..3.20 rows=1 width=44) (actual time=0.009..0.009 rows=1 loops=1)
                                              Buffers: shared hit=3
                                              ->  Seq Scan on clients c  (cost=0.00..1.14 rows=1 width=22) (actual time=0.004..0.004 rows=1 loops=1)
                                                    Filter: ((id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (status = 'active'::client_status))
                                                    Rows Removed by Filter: 4
                                                    Buffers: shared hit=1
                                              ->  Seq Scan on wallet_accounts w  (cost=0.00..2.05 rows=1 width=22) (actual time=0.003..0.004 rows=1 loops=1)
                                                    Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid))
                                                    Rows Removed by Filter: 1
                                                    Buffers: shared hit=2
                            ->  Materialize  (cost=0.00..6.63 rows=1 width=48) (actual time=0.009..0.009 rows=1 loops=1)
                                  Buffers: shared hit=5
                                  ->  Nested Loop  (cost=0.00..6.63 rows=1 width=48) (actual time=0.009..0.009 rows=1 loops=1)
                                        Buffers: shared hit=5
                                        ->  Seq Scan on whatsapp_instances i  (cost=0.00..4.81 rows=1 width=26) (actual time=0.005..0.005 rows=1 loops=1)
                                              Filter: ((deleted_at IS NULL) AND (id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (health_state = 'connected'::wa_health))
                                              Rows Removed by Filter: 4
                                              Buffers: shared hit=4
                                        ->  Seq Scan on instance_lease_state ls  (cost=0.00..1.81 rows=1 width=22) (actual time=0.003..0.003 rows=1 loops=1)
                                              Filter: ((instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (current_fence = '7'::bigint))
                                              Rows Removed by Filter: 4
                                              Buffers: shared hit=1
                      ->  Index Scan using campaigns_pkey on campaigns cp  (cost=0.15..0.40 rows=1 width=42) (actual time=0.000..0.000 rows=0 loops=1)
                            Index Cond: (id = j_4.campaign_id)
                            Filter: (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid)
  ->  Nested Loop  (cost=0.42..25.15 rows=1 width=146) (actual time=0.092..0.093 rows=1 loops=1)
        Buffers: shared hit=23 dirtied=1
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=0.061..0.061 rows=1 loops=1)
              Buffers: shared hit=19 dirtied=1
        ->  Append  (cost=0.42..25.08 rows=3 width=26) (actual time=0.010..0.010 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.42..8.44 rows=1 width=26) (actual time=0.008..0.008 rows=1 loops=1)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
                    Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m09_pkey on message_jobs_y2026m09 j_2  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m10_pkey on message_jobs_y2026m10 j_3  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
Planning:
  Buffers: shared hit=753
Planning Time: 3.796 ms
Execution Time: 0.537 ms
```

### Capture 2 — same statement, same bind values, an earlier `ANALYZE` sample

```
Update on message_jobs j  (cost=735.38..760.19 rows=5 width=146) (actual time=5.839..5.844 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Buffers: shared hit=3907 read=11 dirtied=5
  CTE eligible
    ->  Limit  (cost=734.94..734.96 rows=1 width=64) (actual time=5.624..5.628 rows=1 loops=1)
          Buffers: shared hit=3875 read=8 dirtied=3
          ->  LockRows  (cost=734.94..734.96 rows=1 width=64) (actual time=5.623..5.626 rows=1 loops=1)
                Buffers: shared hit=3875 read=8 dirtied=3
                ->  Sort  (cost=734.94..734.95 rows=1 width=64) (actual time=5.602..5.605 rows=1 loops=1)
                      Sort Key: j_4.next_attempt_at, j_4.id
                      Sort Method: quicksort  Memory: 105kB
                      Buffers: shared hit=3873 read=8 dirtied=3
                      ->  Nested Loop Left Join  (cost=31.42..734.93 rows=1 width=64) (actual time=0.181..5.406 rows=933 loops=1)
                            Filter: ((j_4.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                            Buffers: shared hit=3867 read=8 dirtied=3
                            ->  Nested Loop  (cost=31.27..734.52 rows=1 width=90) (actual time=0.175..5.137 rows=933 loops=1)
                                  Buffers: shared hit=3867 read=8 dirtied=3
                                  ->  Nested Loop  (cost=31.27..732.46 rows=1 width=84) (actual time=0.163..3.688 rows=933 loops=1)
                                        Buffers: shared hit=2003 read=6 dirtied=1
                                        ->  Nested Loop  (cost=31.27..731.40 rows=1 width=78) (actual time=0.152..2.754 rows=933 loops=1)
                                              Buffers: shared hit=1071 read=5
                                              ->  Nested Loop  (cost=31.27..729.58 rows=1 width=88) (actual time=0.146..0.916 rows=933 loops=1)
                                                    Join Filter: (i.session_epoch = j_4.session_epoch)
                                                    Buffers: shared hit=138 read=5
                                                    ->  Seq Scan on whatsapp_instances i  (cost=0.00..4.81 rows=1 width=26) (actual time=0.014..0.022 rows=1 loops=1)
                                                          Filter: ((deleted_at IS NULL) AND (id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (health_state = 'connected'::wa_health))
                                                          Rows Removed by Filter: 53
                                                          Buffers: shared hit=4
                                                    ->  Append  (cost=31.27..722.41 rows=189 width=86) (actual time=0.129..0.799 rows=933 loops=1)
                                                          Buffers: shared hit=134 read=5
                                                          ->  Bitmap Heap Scan on message_jobs_y2026m08 j_5  (cost=31.27..704.57 rows=187 width=86) (actual time=0.129..0.679 rows=933 loops=1)
                                                                Recheck Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()) AND (status = 'queued'::job_status))
                                                                Filter: (scheduled_at <= now())
                                                                Heap Blocks: exact=100
                                                                Buffers: shared hit=132 read=1
                                                                ->  Bitmap Index Scan on message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx  (cost=0.00..31.23 rows=187 width=0) (actual time=0.116..0.116 rows=933 loops=1)
                                                                      Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                                                      Buffers: shared hit=32 read=1
                                                          ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_6  (cost=0.42..8.45 rows=1 width=86) (actual time=0.032..0.032 rows=0 loops=1)
                                                                Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                                                Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                                                Buffers: shared hit=1 read=2
                                                          ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_7  (cost=0.41..8.45 rows=1 width=86) (actual time=0.022..0.022 rows=0 loops=1)
                                                                Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                                                Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                                                Buffers: shared hit=1 read=2
                                              ->  Seq Scan on instance_lease_state ls  (cost=0.00..1.81 rows=1 width=22) (actual time=0.000..0.002 rows=1 loops=933)
                                                    Filter: ((instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (current_fence = '7'::bigint))
                                                    Rows Removed by Filter: 53
                                                    Buffers: shared hit=933
                                        ->  Seq Scan on clients c  (cost=0.00..1.04 rows=1 width=22) (actual time=0.000..0.001 rows=1 loops=933)
                                              Filter: ((id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (status = 'active'::client_status))
                                              Rows Removed by Filter: 8
                                              Buffers: shared hit=932 read=1 dirtied=1
                                  ->  Seq Scan on wallet_accounts w  (cost=0.00..2.05 rows=1 width=22) (actual time=0.001..0.001 rows=1 loops=933)
                                        Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid))
                                        Rows Removed by Filter: 8
                                        Buffers: shared hit=1864 read=2 dirtied=2
                            ->  Index Scan using campaigns_pkey on campaigns cp  (cost=0.15..0.40 rows=1 width=42) (actual time=0.000..0.000 rows=0 loops=933)
                                  Index Cond: (id = j_4.campaign_id)
                                  Filter: (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid)
  ->  Nested Loop  (cost=0.42..25.23 rows=5 width=146) (actual time=5.678..5.680 rows=1 loops=1)
        Buffers: shared hit=3879 read=8 dirtied=3
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=5.636..5.636 rows=1 loops=1)
              Buffers: shared hit=3875 read=8 dirtied=3
        ->  Append  (cost=0.42..25.08 rows=3 width=26) (actual time=0.019..0.020 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.42..8.44 rows=1 width=26) (actual time=0.016..0.016 rows=1 loops=1)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
                    Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m09_pkey on message_jobs_y2026m09 j_2  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m10_pkey on message_jobs_y2026m10 j_3  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
Planning:
  Buffers: shared hit=1243 read=25
Planning Time: 2.597 ms
Execution Time: 6.108 ms
```

## (b) Partitions actually scanned

**All 3** existing `message_jobs` partitions (`message_jobs_y2026m08`,
`message_jobs_y2026m09`, `message_jobs_y2026m10`) are scanned by the
`eligible` CTE's read side in **both** captures — as an `Append`/`Merge
Append` over the three partitions' own copies of the claim index, one branch
per partition, unconditionally. This is exactly the accepted, by-design
behaviour the query's header comment describes: `claim-jobs.sql` carries **no
`created_at` predicate**, so the planner cannot prune any partition by date —
adding one to "optimize" this would strand jobs whose `scheduled_at` lands in
a future partition, which is explicitly rejected. **Do not add a
`created_at` predicate to work around this.**

(The second, write-side `Append` — the `UPDATE ... FROM eligible e WHERE
j.id = e.id AND j.created_at = e.created_at` — _does_ show runtime partition
pruning, `(never executed)` on `m09`/`m10`: that pruning is driven by the
actual `e.created_at` value coming out of the CTE at execution time, a
different (and unproblematic) mechanism from planning-time `created_at`
pruning, and does not contradict the point above.)

## (c) Per-partition cost for the near-empty/future partitions

In both captures, the `message_jobs_y2026m09` and `message_jobs_y2026m10`
branches (the two partitions with **no** currently-eligible row for this
exact `(client, instance, band)` — all their band-10 jobs for this instance
are the fixture's future-scheduled 20%/10% buckets) cost **`0.41`–`0.42` to
`8.45`** total cost units and run in **`0.003`–`0.032` ms** actual time each,
returning 0 rows via a plain single-probe `Index Scan` on that partition's
own copy of the claim index. This is cheap and near-constant per partition —
a single index-range probe, not a scan proportional to partition size.

**This phase's fixture cannot directly measure a genuinely OLD, accumulated
partition** (only current + 2 future months exist — no retention/expiry
history has built up yet at P03). The number above is the closest available
proxy (a partition with data but zero rows matching this probe): **if** that
proxy holds for real old partitions too, partition growth costs roughly one
cheap index probe (`<0.05 ms`) per additional partition, and P26 would only
need empty-partition detachment for cost reasons once the partition count
gets large enough that N × ~8 cost units becomes material (dozens+), not at
P03's scale of 3. **This is an extrapolation, not a direct measurement** —
flagged for P26 to re-verify directly against a real multi-month-old,
low/zero-`queued`-row partition set once retention/expiry exists, rather than
trusting this proxy blindly.

## (d) Index usage and Sort-node finding — **does not match the dispatch's literal expectation; reported honestly**

Two separate, real findings surfaced while gathering this evidence. Neither
was "fixed" by reshaping the fixture to dodge them — both are reported as-is.

**1. The literal string `message_jobs_claim_idx` never appears in any
partition-scan EXPLAIN line, by normal PostgreSQL behavior — this is not a
bug.** `message_jobs_claim_idx` is the _parent_ index on the partitioned
table `message_jobs`; Postgres auto-creates one **child index per partition**
that inherits from it (verified via `pg_inherits`/`pg_index` — see query
below), each with an **auto-generated name** derived from its own column
list, e.g. `message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx`.
The parent index itself is never scanned directly (a partitioned table's
parent relation holds no rows). Both captures above _do_ use these
per-partition children exclusively for every `message_jobs` access, and
**never** a `Seq Scan on message_jobs` (or any of its partitions) anywhere in
either plan — that half of point (d) holds in both captures. Any
`claim-plan.test.ts`-style assertion must therefore match the per-partition
child naming pattern (or resolve the actual child index names from the
catalog), never the literal parent string.

```sql
SELECT indexrelid::regclass AS index_name, indrelid::regclass AS table_name
FROM pg_index
WHERE indrelid IN ('message_jobs'::regclass, 'message_jobs_y2026m08'::regclass)
ORDER BY table_name, index_name;
--            index_name                            |      table_name
-- message_jobs_claim_idx                            | message_jobs            (parent - never scanned directly)
-- message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx | message_jobs_y2026m08  (child - actually scanned)
```

**2. Whether a genuine `Sort` node appears is data/statistics-dependent, and
was observed to flip between two `ANALYZE` runs against the SAME unmodified
data.** Capture 1 (above) has **no** `Sort` node — the read side is a `Merge
Append` over three already-ordered per-partition `Index Scan`s (their
`Sort Key: j_4.next_attempt_at, j_4.id` line is `Merge Append`'s own
"what order my inputs already arrive in" annotation, **not** a sort
operation — a real `Sort` node is a distinct plan line with its own
`cost=.../actual time=...` and, when it executes, a `Sort Method: ...
Memory: ...` line). Capture 2, same statement, same params, same table
contents, taken after a _different_ `ANALYZE message_jobs` sample, **does**
contain a genuine `Sort` node (`Sort (cost=734.94..734.95 ...) Sort Method:
quicksort Memory: 105kB`), fed by a `Bitmap Heap Scan` on
`message_jobs_y2026m08` instead of an ordered `Index Scan`.

Root cause, established by direct experimentation (not guessed): this
probe's `(client_id, instance_id, priority_rank)` triple is **not a rare
value** in this fixture — it matches ~933 of the partition's 140,000+ rows
(this single instance holds 4,000 of the table's 200,000 rows, ~1,333 of
those in band 10, ~933 of those currently eligible). `ANALYZE`'s statistics
sampling is random; at this exact concentration the estimated cost of "walk
the ordered index and stop at `LIMIT 1`" versus "bitmap-collect the ~900
matching rows then sort them" comes out close enough that which one wins can
change between samples. **Both plans are fast in absolute terms** — 0.537 ms
and 6.108 ms execution time respectively, both well under the claim's
30-second lease expiry and dominated by shared-buffer hits, not disk I/O —
so this is not a correctness or a p99-latency emergency. It IS a genuine
reason `db/tests/claim-plan.test.ts` (Task 3) cannot assert "no Sort node"
against _this_ 200k/50-instance fixture's own heaviest-backlog probe without
being flaky; that test instead self-seeds a **smaller, realistically-selective**
fixture (many instances, no single instance holding a large fraction of the
table) where the ordered-index plan is not a coin flip — see that file's own
header comment for the measured justification.

**Practical implication for P26 / operations:** a single instance
accumulating several hundred+ simultaneously-_eligible_ `queued` jobs in one
priority band (a real backlog, e.g. pacing stalled or a burst under a
degraded connection) pushes the claim query onto the more expensive of two
still-fast plans. Worth a queue-depth-per-instance-per-band alert threshold
at that phase, not a schema change now.

## Fixture load command

```
psql -h 127.0.0.1 -p 55432 -U wp -d wp -v ON_ERROR_STOP=1 -f db/seeds/queue-explain-fixture.sql
```

Result: `INSERT 0 200000` for `message_jobs`, ~2.5s wall time; re-run is
idempotent (`DELETE 200000` / `DELETE 50` / `DELETE 5` on the second run,
followed by the identical re-`INSERT` counts).
