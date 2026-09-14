# P23 U3 — campaign-predicate `EXPLAIN` evidence

Date: 2026-09-06.

Scope: re-run of the `db/tests/claim-plan.test.ts` self-seeded `EXPLAIN`
capture (`explainClaim()`, same helper the file's other two cases use),
proving the campaign allow-list predicate already in
`db/queries/claim-jobs.sql` (`LEFT JOIN campaigns cp ON cp.id =
j.campaign_id AND cp.client_id = j.client_id` … `AND (j.campaign_id IS NULL
OR cp.status IN ('running','expanding'))`) resolves `campaigns` via an index
probe on its own primary key, not a scan proportional to table size, once
the join is actually exercised by a real `campaign_id`.

## Why a fresh capture, not a reuse of P19's

`docs/evidence/P19-claim-explain-wallet.md` already shows `campaigns` in its
capture — but as `Seq Scan on campaigns cp (cost=0.00..1.00 rows=1)
(actual rows=0 loops=1)`, a legitimately cheap plan for a table that was, at
that point, **completely empty** (migration 0064 had not landed a writer
yet — `campaigns` was still a DDL shell with zero rows in the whole
database). That capture also never stamped any fixture job's `campaign_id`,
so the join's `Filter: (j_5.campaign_id IS NULL) OR …` was always trivially
true and the LEFT JOIN's right side was never genuinely walked for a real
row. This capture is materially different in two ways the P23 U3 dispatch
asked for: (1) `campaigns` now has real cardinality (5,000 throwaway
clients' worth of rows, `seedManyCampaignsForCardinality`, plus the probe
client's own running + 500 sibling campaigns), and (2) the probed job
itself carries a real, non-NULL `campaign_id` pointing at a `status =
'running'` row (`seedPlanRepresentativeFixture`'s new `withRunningCampaign`
option), so the join is actually executed for the returned row, not an
always-NULL passthrough.

`db/queries/claim-jobs.sql` itself is **byte-identical** to every prior
capture (P03, P19) — this unit does not edit that file. Only the fixture
changed.

## Fixture parameters used

| Param                      | Value                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `campaigns` cardinality    | 5,000 throwaway single-client campaigns (`seedManyCampaignsForCardinality`, 10 cancelled campaigns per throwaway client = 50,000 rows) + the probe client's own 1 running + 500 cancelled sibling campaigns — 50,501 total rows in the table at capture time                |
| `$client_id`               | `7ec85558-eba1-4a4d-859c-fb14838c6c6e` (self-seeded probe client, `seedPlanRepresentativeFixture`)                                                                                                                                                                          |
| `$instance_id`             | `0db6fc78-3ede-4d50-b3b4-002a84b65046` (that client's instance 0 of 15 — the probe instance)                                                                                                                                                                                |
| probed job's `campaign_id` | a real row, `status = 'running'`, `client_id` = the probe client's own id, `instance_id` = the probe instance — every one of the probe instance's `priority_rank = 10` (high-band) jobs is stamped with it (`seedPlanRepresentativeFixture`'s `withRunningCampaign` option) |
| `$band` (`priority_rank`)  | `10` (high) — `claim-plan.test.ts`'s own `PROBE_BAND`                                                                                                                                                                                                                       |
| `$fence`                   | `7` (`PROBE_FENCE`, `db/tests/helpers/claim-plan-fixture.ts`)                                                                                                                                                                                                               |
| `$worker`                  | `claim-plan-test`                                                                                                                                                                                                                                                           |
| `$claim_expiry_ms`         | `30000`                                                                                                                                                                                                                                                                     |
| probe client's own wallet  | `state='active'`, `balance_minor=100_000`, `max_rate_minor=100` (ample balance, unchanged by this unit)                                                                                                                                                                     |

This is a **selective** single-row probe (`campaigns` has 50,501 rows total;
the claim only ever needs exactly 1 of them, keyed by `campaign_id`) — the
realistic shape a claim actually runs under: one job claiming against one
already-known campaign, never a cross-tenant or cross-campaign scan.

## Verbatim `EXPLAIN (ANALYZE, BUFFERS)` capture

```
Update on message_jobs j  (cost=33.15..70.34 rows=1 width=142) (actual time=0.187..0.191 rows=1 loops=1)
  Update on message_jobs_y2026m08 j_1
  Update on message_jobs_y2026m09 j_2
  Update on message_jobs_y2026m10 j_3
  Update on message_jobs_y2026m11 j_4
  Buffers: shared hit=45 read=1 dirtied=1
  CTE eligible
    ->  Limit  (cost=2.93..32.87 rows=1 width=64) (actual time=0.072..0.075 rows=1 loops=1)
          Buffers: shared hit=30
          ->  LockRows  (cost=2.93..841.35 rows=28 width=64) (actual time=0.071..0.073 rows=1 loops=1)
                Buffers: shared hit=30
                ->  Nested Loop Left Join  (cost=2.93..841.07 rows=28 width=64) (actual time=0.068..0.070 rows=1 loops=1)
                      Filter: ((j_5.campaign_id IS NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))
                      Buffers: shared hit=29
                      ->  Nested Loop  (cost=2.64..608.04 rows=28 width=90) (actual time=0.061..0.063 rows=1 loops=1)
                            Join Filter: (i.session_epoch = j_5.session_epoch)
                            Buffers: shared hit=26
                            ->  Merge Append  (cost=1.58..566.41 rows=28 width=86) (actual time=0.034..0.035 rows=1 loops=1)
                                  Sort Key: j_5.next_attempt_at, j_5.id
                                  Buffers: shared hit=14
                                  ->  Index Scan using message_jobs_y2026m08_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m08 j_6  (cost=0.28..540.59 rows=25 width=86) (actual time=0.020..0.020 rows=1 loops=1)
                                        Index Cond: ((client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid) AND (instance_id = '0db6fc78-3ede-4d50-b3b4-002a84b65046'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=4
                                  ->  Index Scan using message_jobs_y2026m09_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m09 j_7  (cost=0.42..8.46 rows=1 width=86) (actual time=0.007..0.007 rows=1 loops=1)
                                        Index Cond: ((client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid) AND (instance_id = '0db6fc78-3ede-4d50-b3b4-002a84b65046'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=4
                                  ->  Index Scan using message_jobs_y2026m10_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m10 j_8  (cost=0.42..8.45 rows=1 width=86) (actual time=0.004..0.004 rows=0 loops=1)
                                        Index Cond: ((client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid) AND (instance_id = '0db6fc78-3ede-4d50-b3b4-002a84b65046'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                                  ->  Index Scan using message_jobs_y2026m11_client_id_instance_id_priority_rank_n_idx on message_jobs_y2026m11 j_9  (cost=0.41..8.45 rows=1 width=86) (actual time=0.003..0.003 rows=0 loops=1)
                                        Index Cond: ((client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid) AND (instance_id = '0db6fc78-3ede-4d50-b3b4-002a84b65046'::uuid) AND (priority_rank = '10'::smallint) AND (next_attempt_at <= now()))
                                        Filter: ((status = 'queued'::job_status) AND (scheduled_at <= now()))
                                        Buffers: shared hit=3
                            ->  Materialize  (cost=1.06..41.22 rows=1 width=124) (actual time=0.025..0.026 rows=1 loops=1)
                                  Buffers: shared hit=12
                                  ->  Nested Loop  (cost=1.06..41.22 rows=1 width=124) (actual time=0.024..0.025 rows=1 loops=1)
                                        Buffers: shared hit=12
                                        ->  Nested Loop  (cost=0.80..32.91 rows=1 width=102) (actual time=0.017..0.018 rows=1 loops=1)
                                              Buffers: shared hit=9
                                              ->  Nested Loop  (cost=0.53..20.59 rows=1 width=80) (actual time=0.012..0.013 rows=1 loops=1)
                                                    Buffers: shared hit=6
                                                    ->  Index Scan using whatsapp_instances_client_idx on whatsapp_instances i  (cost=0.27..12.29 rows=1 width=42) (actual time=0.007..0.007 rows=1 loops=1)
                                                          Index Cond: (client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid)
                                                          Filter: ((deleted_at IS NULL) AND (id = '0db6fc78-3ede-4d50-b3b4-002a84b65046'::uuid) AND (health_state = 'connected'::wa_health))
                                                          Rows Removed by Filter: 14
                                                          Buffers: shared hit=3
                                                    ->  Index Scan using instance_lease_state_pkey on instance_lease_state ls  (cost=0.26..8.29 rows=1 width=38) (actual time=0.004..0.004 rows=1 loops=1)
                                                          Index Cond: (instance_id = '0db6fc78-3ede-4d50-b3b4-002a84b65046'::uuid)
                                                          Filter: ((client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid) AND (current_fence = '7'::bigint))
                                                          Buffers: shared hit=3
                                              ->  Index Scan using clients_pkey on clients c  (cost=0.27..12.31 rows=1 width=22) (actual time=0.005..0.005 rows=1 loops=1)
                                                    Index Cond: (id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid)
                                                    Filter: (status = 'active'::client_status)
                                                    Buffers: shared hit=3
                                        ->  Index Scan using wallet_accounts_pkey on wallet_accounts w  (cost=0.27..8.30 rows=1 width=22) (actual time=0.006..0.006 rows=1 loops=1)
                                              Index Cond: (client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid)
                                              Filter: ((state <> ALL ('{empty,frozen}'::wallet_state[])) AND (balance_minor >= max_rate_minor))
                                              Buffers: shared hit=3
                      ->  Index Scan using campaigns_pkey on campaigns cp  (cost=0.29..8.31 rows=1 width=42) (actual time=0.005..0.005 rows=1 loops=1)
                            Index Cond: (id = j_5.campaign_id)
                            Filter: (client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid)
                            Buffers: shared hit=3
  ->  Nested Loop  (cost=0.28..37.47 rows=1 width=142) (actual time=0.102..0.104 rows=1 loops=1)
        Buffers: shared hit=34
        ->  CTE Scan on eligible e  (cost=0.00..0.02 rows=1 width=56) (actual time=0.076..0.077 rows=1 loops=1)
              Buffers: shared hit=30
        ->  Append  (cost=0.28..37.38 rows=4 width=26) (actual time=0.006..0.006 rows=1 loops=1)
              Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m08_pkey on message_jobs_y2026m08 j_1  (cost=0.28..12.30 rows=1 width=26) (actual time=0.004..0.004 rows=1 loops=1)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
                    Buffers: shared hit=4
              ->  Index Scan using message_jobs_y2026m09_pkey on message_jobs_y2026m09 j_2  (cost=0.42..8.44 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m10_pkey on message_jobs_y2026m10 j_3  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
              ->  Index Scan using message_jobs_y2026m11_pkey on message_jobs_y2026m11 j_4  (cost=0.29..8.31 rows=1 width=26) (never executed)
                    Index Cond: ((id = e.id) AND (created_at = e.created_at))
                    Filter: (status = 'queued'::job_status)
Planning:
  Buffers: shared hit=618 read=5
Planning Time: 2.515 ms
Execution Time: 0.336 ms
```

(4 `message_jobs` monthly partitions appear here, same as P19 — unrelated to
this unit's campaign change; see `claim-plan.test.ts`'s own header comment.)

## `campaigns` access method — interpretation

```
->  Index Scan using campaigns_pkey on campaigns cp  (cost=0.29..8.31 rows=1 width=42) (actual time=0.005..0.005 rows=1 loops=1)
      Index Cond: (id = j_5.campaign_id)
      Filter: (client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid)
      Buffers: shared hit=3
```

- **Access method: `Index Scan using campaigns_pkey`** — an index probe,
  never a scan. `campaigns.id` is the table's own primary key
  (`db/migrations/0010_claim_join_shells.sql`), and once the join has real
  cardinality on both sides the planner drives the lookup from the
  candidate job's own `campaign_id` (`Index Cond: (id = j_5.campaign_id)`),
  the narrowest possible access path — walk straight to the one campaign row
  this job references, then evaluate `cp.client_id = j.client_id` as a
  post-probe `Filter:` (never a condition that could match more than one
  row, since `id` is unique) and the allow-list status check up in the
  `Nested Loop Left Join`'s own `Filter:`.
- **`loops=1`**: the campaigns probe executes exactly once for this claim,
  not once per candidate job or once per client's whole campaign set —
  confirms it is a single, `campaign_id`-keyed lookup, not a scan
  proportional to `message_jobs` candidate count or `campaigns` table size.
- **No `Seq Scan on campaigns` anywhere in this plan** (verified by the same
  substring assertion `claim-plan.test.ts`'s new
  `claim_plan_probes_campaigns_by_primary_key_and_never_scans_it` case runs
  against every capture, not just this one-off).
- **`cost=0.29..8.31`, `actual time=0.005ms`, `Buffers: shared hit=3`**:
  cheap and dominated by shared-buffer hits, consistent with a single
  indexed row-lookup on a table now holding 50,501 rows.
- The allow-list predicate itself (`AND (j.campaign_id IS NULL OR
cp.status IN ('running','expanding'))`) shows up split across two plan
  nodes — the `Nested Loop Left Join`'s own `Filter: ((j_5.campaign_id IS
NULL) OR (cp.status = ANY ('{running,expanding}'::broadcast_status[])))`
  — exactly the fail-closed shape the canon describes: a `cancelled` or
  `failed` campaign (this fixture also seeds both, plus `paused`, for
  client_1 in `db/seeds/queue-explain-fixture.sql`) would fail that same
  filter and yield zero claims, without ever needing a second query or an
  application-level check.

## Diff against `docs/evidence/P19-claim-explain-wallet.md`

The two meaningful differences are (1) the `campaigns` access method,
directly caused by (a) real cardinality (0 non-throwaway rows in P19's
capture vs 50,501 here) and (b) a genuinely non-NULL `campaign_id` on the
probed job for the first time, and (2) the join shape simplifying from a
`Nested Loop Left Join` + separate `Materialize` sub-plan over `campaigns`
into a direct per-row index probe — not a change to `claim-jobs.sql`, which
is byte-identical in both captures:

```diff
-                      ->  Materialize  (cost=0.00..1.00 rows=1 width=42) (actual time=0.003..0.003 rows=0 loops=1)
-                            Buffers: shared hit=1
-                            ->  Seq Scan on campaigns cp  (cost=0.00..1.00 rows=1 width=42) (actual time=0.003..0.003 rows=0 loops=1)
-                                  Filter: (client_id = 'e11539b8-d832-4d2d-b974-dd92288c7754'::uuid)
-                                  Buffers: shared hit=1
+                      ->  Index Scan using campaigns_pkey on campaigns cp  (cost=0.29..8.31 rows=1 width=42) (actual time=0.005..0.005 rows=1 loops=1)
+                            Index Cond: (id = j_5.campaign_id)
+                            Filter: (client_id = '7ec85558-eba1-4a4d-859c-fb14838c6c6e'::uuid)
+                            Buffers: shared hit=3
```

Everything else — `message_jobs` access exclusively via per-partition
children of `message_jobs_claim_idx`, no `Seq Scan on message_jobs`
anywhere, `whatsapp_instances`/`instance_lease_state`/`clients`/
`wallet_accounts` each a cheap single-row probe via their own primary keys,
no genuine `Sort` node (the `Merge Append`'s `Sort Key:` annotation is not a
`Sort` node, same distinction P03/P19 already established) — matches P19's
finding shape unchanged. P19's own finding already established that BOTH a
`Seq Scan` (at near-zero cardinality) and an index probe (at real
cardinality) are legitimate, fast plans for a tiny/empty `campaigns` table;
this capture demonstrates the specific condition (real cardinality plus a
genuinely joined row) under which the planner's own choice flips to the
`campaigns_pkey` probe the phase's step 8 asked to observe.

## Conclusion

`db/queries/claim-jobs.sql`'s campaign allow-list predicate resolves
`campaigns` via a single-row, `campaign_id`-keyed index probe
(`campaigns_pkey`) once the table has realistic cardinality and the joined
job carries a real campaign reference, `loops=1` every time, never a
`Seq Scan` at this row count, and never a second/repeated scan. The
allow-list `Filter:` (`campaign_id IS NULL OR cp.status IN
('running','expanding')`) is evaluated in-plan alongside that probe — a
`paused`, `cancelled`, or `failed` campaign (all three now present in
`db/seeds/queue-explain-fixture.sql` for client_1, alongside a `running`
one and an orphan `campaign_id` with no `campaigns` row at all) is excluded
by the same predicate, with no separate query or code path. No change to
`claim-jobs.sql` was made or is warranted by this evidence.

## Fixture/run commands used

```
cd db
pnpm exec vitest run tests/claim-plan.test.ts --bail=1
```

(The verbatim capture above was produced by a throwaway script that called
the exact same `seedManyCampaignsForCardinality` +
`seedPlanRepresentativeFixture(..., { withRunningCampaign: true })` +
`explainClaim` helpers `claim-plan.test.ts`'s own new case uses, deleted
after this evidence file was written — the automated test is the reusable,
re-runnable proof; this document is its evidence artefact.)

`db/seeds/queue-explain-fixture.sql` was also re-run (twice, to prove
re-runnability) against the same dev database while preparing this evidence,
adding four deterministic `campaigns` rows for client_1
(`c0000000-0000-4000-a000-000000000001..004`, statuses `running`/`paused`/
`cancelled`/`failed`) plus a stamped share of client_1's first four
instances' jobs (1 in 20 pointing at a real campaign, 1 in 200 pointing at
an orphan `campaign_id` with no `campaigns` row) — verified idempotent
(`DELETE`-then-`INSERT`, same counts both runs) and unrelated to this
evidence's own self-seeded capture above.
