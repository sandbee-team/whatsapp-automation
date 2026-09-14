# P06 Unit U1 — claim-jobs.sql EXPLAIN evidence (re-filed after migration 0018)

Date: 2026-08-31.

Scope: this is a re-file of the `EXPLAIN (ANALYZE, BUFFERS)` evidence for the
exact, byte-unmodified statement in `db/queries/claim-jobs.sql`, run against
the same fixture and same bind parameters as `docs/evidence/P03-claim-explain.md`
section (a0)/(e), after `db/migrations/0018_instance_lease_state.sql` landed
(P06 session-lease-and-fence Unit U1). It confirms the claim's plan shape is
still healthy post-0018, not a re-derivation of P03's own findings — see
`docs/evidence/P03-claim-explain.md` for the full index-usage/Sort-node
analysis (points a-d), which stays the historical record and is unaffected by
this migration.

**What changed in 0018 that could plausibly affect this plan, and why it
doesn't:** `instance_lease_state` gained a `released_at` column, new storage
params (`fillfactor = 60`, more aggressive autovacuum), a new **partial**
index `ils_stale_idx (lease_seen_at) WHERE owner_worker_id IS NOT NULL`, a
grant/policy change (`wp_scheduler`'s INSERT/UPDATE revoked, `wp_app` granted
instead, plus a new `lease_owner_renew` policy for `wp_app`), and a new
SECURITY DEFINER function `wp_lease_scan_unowned`. None of this touches
`claim-jobs.sql`'s own join predicate on `instance_lease_state`
(`ls.instance_id = j.instance_id AND ls.client_id = j.client_id AND
ls.current_fence = $fence`, unchanged since ADR 0026/P03) or its role
(`wp_scheduler`, whose SELECT grant on `instance_lease_state` is untouched by
0018 — only INSERT/UPDATE were revoked). `ils_stale_idx` leads with
`lease_seen_at`, not `instance_id`/`current_fence`, so it is not a candidate
index for this query's `ls` probe either way; `instance_lease_state` is still
a handful of rows per fixture client, so the planner still reaches for a
`Seq Scan` on it (see capture below), exactly as in every P03 capture.

## Fixture and parameters (identical to P03 section (e))

Reloaded via `db/seeds/queue-explain-fixture.sql` immediately before this
capture (`psql -f db/seeds/queue-explain-fixture.sql`, `INSERT 0 200000` for
`message_jobs`, idempotent re-run).

| Param                     | Value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `$client_id`              | `a0000000-0000-4000-a000-000000000001` (fixture client 1)             |
| `$instance_id`            | `b0000000-0000-4000-a000-000000000101` (fixture client 1, instance 1) |
| `$band` (`priority_rank`) | `10` (high)                                                           |
| `$fence`                  | `7` (every fixture `instance_lease_state.current_fence`)              |
| `$worker`                 | `explain-probe`                                                       |
| `$claim_expiry_ms`        | `30000`                                                               |
| `$ledger_date`            | `2026-08-31`                                                          |

Captured inside a transaction that was rolled back (`BEGIN; EXPLAIN (ANALYZE,
BUFFERS) <statement>; ROLLBACK;`), same procedure as `claim-plan.test.ts`'s
harness — `EXPLAIN ANALYZE` genuinely executes the UPDATE, so a claim was
taken and then undone, never left committed. `ANALYZE message_jobs` was run
immediately beforehand (same as P03 capture 2 / ADR 0026 capture 2's "fresh
ANALYZE" branch).

## Verbatim EXPLAIN output

```
Update on message_jobs j  (cost=5.94..30.67 rows=1 width=146) (actual time=0.215..0.220 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Buffers: shared hit=62 read=1 dirtied=1
  CTE eligible
    ->  Limit  (cost=1.28..5.52 rows=1 width=64) (actual time=0.049..0.052 rows=1 loops=1)
          Buffers: shared hit=25
          ->  LockRows  (cost=1.28..772.58 rows=182 width=64) (actual time=0.047..0.050 rows=1 loops=1)
                Buffers: shared hit=25
                ->  Nested Loop Left Join  (cost=1.28..770.76 rows=182 width=64) (actual time=0.043..0.045 rows=1 loops=1)
                      Join Filter: (cp.id = j_4.campaign_id)
                      Filter: ((j_4.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                      Buffers: shared hit=24
                      ->  Nested Loop  (cost=1.28..765.30 rows=182 width=90) (actual time=0.040..0.042 rows=1 loops=1)
                            Join Filter: (i.session_epoch = j_4.session_epoch)
                            Buffers: shared hit=23
                            ->  Merge Append  (cost=1.28..743.43 rows=182 width=86) (actual time=0.019..0.020 rows=1 loops=1)
                                  Sort Key: j_4.next_attempt_at, j_4.id
                                  Buffers: shared hit=10
                                  ->  Index Scan using message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m08 j_5  (cost=0.42..724.15 rows=180 width=86) (actual time=0.012..0.012 rows=1 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=4
                                  ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_6  (cost=0.42..8.45 rows=1 width=86) (actual time=0.003..0.004 rows=0 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                                  ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_7  (cost=0.41..8.45 rows=1 width=86) (actual time=0.003..0.003 rows=0 loops=1)
                                        Index Cond: ((client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                            ->  Materialize  (cost=0.00..19.15 rows=1 width=124) (actual time=0.020..0.021 rows=1 loops=1)
                                  Buffers: shared hit=13
                                  ->  Nested Loop  (cost=0.00..19.14 rows=1 width=124) (actual time=0.019..0.020 rows=1 loops=1)
                                        Buffers: shared hit=13
                                        ->  Nested Loop  (cost=0.00..12.73 rows=1 width=102) (actual time=0.013..0.014 rows=1 loops=1)
                                              Buffers: shared hit=8
                                              ->  Nested Loop  (cost=0.00..10.37 rows=1 width=80) (actual time=0.010..0.010 rows=1 loops=1)
                                                    Buffers: shared hit=6
                                                    ->  Seq Scan on whatsapp_instances i  (cost=0.00..5.95 rows=1 width=42) (actual time=0.005..0.006 rows=1 loops=1)
                                                          Filter: ((deleted_at IS NULL) AND (id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (health_state = 'connected'::wa_health))
                                                          Rows Removed by Filter: 4
                                                          Buffers: shared hit=3
                                                    ->  Seq Scan on instance_lease_state ls  (cost=0.00..4.42 rows=1 width=38) (actual time=0.004..0.004 rows=1 loops=1)
                                                          Filter: ((instance_id = 'b0000000-0000-4000-a000-000000000101'::uuid) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (current_fence = '7'::bigint))
                                                          Rows Removed by Filter: 4
                                                          Buffers: shared hit=3
                                              ->  Seq Scan on clients c  (cost=0.00..2.34 rows=1 width=22) (actual time=0.003..0.004 rows=1 loops=1)
                                                    Filter: ((id = 'a0000000-0000-4000-a000-000000000001'::uuid) AND (status = 'active'::client_status))
                                                    Rows Removed by Filter: 18
                                                    Buffers: shared hit=2
                                        ->  Seq Scan on wallet_accounts w  (cost=0.00..6.40 rows=1 width=22) (actual time=0.005..0.006 rows=1 loops=1)
                                              Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor) AND (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid))
                                              Rows Removed by Filter: 17
                                              Buffers: shared hit=5
                      ->  Materialize  (cost=0.00..2.28 rows=1 width=42) (actual time=0.001..0.002 rows=0 loops=1)
                            Buffers: shared hit=1
                            ->  Seq Scan on campaigns cp  (cost=0.00..2.28 rows=1 width=42) (actual time=0.001..0.001 rows=0 loops=1)
                                  Filter: (client_id = 'a0000000-0000-4000-a000-000000000001'::uuid)
                                  Buffers: shared hit=1
  ->  Nested Loop  (cost=0.42..25.15 rows=1 width=146) (actual time=0.086..0.088 rows=1 loops=1)
        Buffers: shared hit=29
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=0.054..0.055 rows=1 loops=1)
              Buffers: shared hit=25
        ->  Append  (cost=0.42..25.08 rows=3 width=26) (actual time=0.006..0.007 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.42..8.44 rows=1 width=26) (actual time=0.004..0.004 rows=1 loops=1)
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
  Buffers: shared hit=755
Planning Time: 1.737 ms
Execution Time: 0.340 ms
```

## Confirmations

- **Partition count actually scanned:** all 3 existing `message_jobs`
  partitions (`message_jobs_y2026m08`, `message_jobs_y2026m09`,
  `message_jobs_y2026m10`) — same as every P03 capture, unaffected by 0018
  (`claim-jobs.sql` still carries no `created_at` predicate, by design).
- **No `Seq Scan on message_jobs`** anywhere in the plan — every
  `message_jobs` access goes through a per-partition child of
  `message_jobs_claim_idx` (read side: `Merge Append` over three ordered
  `Index Scan`s; write side: per-partition `Index Scan` on each partition's
  own PK).
- **No genuine `Sort` node** — the `Sort Key: j_4.next_attempt_at, j_4.id`
  line under `Merge Append` is that node's own "what order my inputs already
  arrive in" annotation (see P03 finding (d) for the distinction), not a
  `Sort (cost=... )` node; none appears anywhere in this plan.
- The `ls` (`instance_lease_state`) join still resolves via a cheap
  single-row `Seq Scan` with an equality `Filter` on
  `(instance_id, client_id, current_fence)` — cost `0.00..4.42`, actual time
  `0.004 ms` — the same shape and same order of magnitude as every P03/ADR
  0026 capture; the new `ils_stale_idx` (keyed on `lease_seen_at`, a
  different column) is not a candidate for this predicate and does not
  appear in the plan.
- **The `i`/`ls` join landed tenant-qualified in P03 (ADR 0026)** — this
  capture re-files the plan after 0018's storage-parameter, index, and grant
  changes on `instance_lease_state`; it is not a re-derivation of ADR 0026's
  own finding, which is unaffected by 0018 and stays fully documented in
  `docs/evidence/P03-claim-explain.md`.

## Fixture load command

```
psql -h 127.0.0.1 -p 55432 -U wp -d wp -v ON_ERROR_STOP=1 -f db/seeds/queue-explain-fixture.sql
```
