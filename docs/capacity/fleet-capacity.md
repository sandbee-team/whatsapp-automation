# Fleet capacity — Gate B (P26)

Status: this document is the Gate B (P26) fleet-capacity publication skeleton,
produced by P26 on 2026-09-07. Every figure in this document is **internal**
and no figure may reach a tenant-facing surface (ADR 0016, ADR 0018 §8). Until
Gate C closes, the only honest capacity sentence is verbatim: "the
architecture has no known ceiling below 10,000 and has been measured to N =
1,000" (measured 2026-09-07; verdict pending — see banner).

## Banner (verbatim — must appear unmodified in this file)

```
DRIFT VERDICT PENDING — P26a
```

P26a replaces the banner above with `GATE B CLOSED — measured to N=<n>` once
the day-8 drift run's verdict lands, or raises the leak as a `/decide` if the
drift run finds an unacceptable regression instead.

## Measured N and run durations

- Measured N = 1,000 synthetic instances (target 1,000) — the drift fleet (1,000 resident sockets), the 60-minute pacing run (1,000 instances over 10 workers) and the load-model run (1,000 instances over 10 workers) all ran at N = 1,000; the fleet-scale chaos drills ran at 300 (beside the live drift fleet on the same box).
- Run duration = **01:00** (pacing run; 8 h target NOT met — the 8-hour run was not launched because the 60-minute run's own verdict is FAIL on the `reserve()` p99 SLO and must be understood first; honesty note below)
- Drift run = launched 2026-09-07T06:55:19Z at N = 1,000 resident sockets (168 h planned, hourly samples; hours 0-6 at session close: `resident=1000/1000` every hour, RSS 465.9 → 467.7 MiB, `degraded=false`), verdict pending (P26a, day 8) — `docs/measurements/raw/2026-09-07-drift-idle.jsonl`, header `docs/measurements/2026-09-07-drift-header.json`
- Real-number cohort = 0 numbers (founder open item 6) — NOT measured

## Hardware fingerprint

| Field                                                                                                      | Value                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target                                                                                                     | Docker WSL2 VM (Linux `node:24` container, repo mounted at the host path so pnpm symlinks resolve; TS loader from the `wp-linux-tsx` volume)                                                                                   |
| CPU model                                                                                                  | 12th Gen Intel(R) Core(TM) i5-12500                                                                                                                                                                                            |
| Cores (vCPU)                                                                                               | 12                                                                                                                                                                                                                             |
| RAM                                                                                                        | 16,608,604,160 B (~15.5 GiB) for the whole VM, shared by Postgres, PgBouncer, three Redis services, the drift fleet and the measured fleet                                                                                     |
| Kernel                                                                                                     | 6.6.87.2-microsoft-standard-WSL2                                                                                                                                                                                               |
| cgroup version                                                                                             | v2                                                                                                                                                                                                                             |
| Node version                                                                                               | v24.20.0 (container); the Windows host runs v22 and is never used for a measurement                                                                                                                                            |
| Baileys version (pinned)                                                                                   | 7.0.0-rc14                                                                                                                                                                                                                     |
| PgBouncer (version / pool mode / default_pool_size / max_client_conn, or NOT DEPLOYED — DIRECT-CONNECTION) | edoburu/pgbouncer v1.24.1-p1 / transaction / 60 / 4000 (reserve_pool_size 20, server_idle_timeout 60) — every `reserve()` and load-model measurement went THROUGH it (`connection.label = THROUGH-PGBOUNCER` in the artifacts) |
| Tuned sysctls (ulimit -n, ip_local_port_range, somaxconn)                                                  | container defaults, unmodified and recorded: `ulimit -n` 1,048,576 · `ip_local_port_range` 32768-60999 · `somaxconn` 4096                                                                                                      |
| Captured (UTC)                                                                                             | 2026-09-07T06:55:19Z (drift launch; every artifact carries its own `capturedAtIso`)                                                                                                                                            |

## Load model — measured vs derived (M8/M9)

The architecture has no known ceiling below 10,000 and has been measured to
N = 1,000 (this document's Measured N above; every figure internal until P26a closes).

| Quantity                              | Derived (ADR 0018 §7) | Measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 95% CI / sample size               | Artifact                                      |
| ------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| Sends/day/connected instance          | 600 sends/day         | NOT MEASURED as a rate — the run's 25.04 sends/s over 1,000 instances is the harness's poll-bound drain (one claim per 30 s safety poll; no `next_eligible_at` nudge in production wiring), not a tenant behaviour; 600 stays the derived planning figure                                                                                                                                                                                                                                                   | n/a                                | `docs/measurements/2026-09-07-loadmodel.json` |
| Statements per send                   | 12 statements/send    | **84.27 raw** (2,528,046 statements / 30,000 sends) — **NOT publishable**: the fleet's own lease heartbeats and safety polls at HARNESS timings dominate the window; the 60 s idle baseline measured 4,868 statements/s, which over the 1,198 s window exceeds the window total, so `baselineSubtracted.statements` is negative and meaningless. Attribution by `pg_stat_statements` query id (send-path fingerprints vs heartbeat/poll fingerprints) or a run at production heartbeat timing is a P27 item | 30,000 sends (exact count, no CI)  | `docs/measurements/2026-09-07-loadmodel.json` |
| Durable bytes per send                | 3.2 KB/send           | **1,342 bytes/send** (relation growth 40,263,680 bytes / 30,000 sends; same heartbeat-UPDATE caveat, though relation growth is far less sensitive to it than statement counts)                                                                                                                                                                                                                                                                                                                              | 30,000 sends (exact count, no CI)  | `docs/measurements/2026-09-07-loadmodel.json` |
| WAL MB/s                              | 10-20 MB/s at 10k     | **0.350 MB/s at N = 1,000, 25 sends/s** (439,378,000 WAL bytes / 1,198 s ≈ 14.6 KB WAL per send, heartbeat UPDATEs included — the baseline-subtracted figure is 395 MB, i.e. ~90 % of WAL was send-path)                                                                                                                                                                                                                                                                                                    | 30,000 sends over 20.0 min (exact) | `docs/measurements/2026-09-07-loadmodel.json` |
| Projected daily growth at N connected | 19.2 GB/day at 10k    | NOT PROJECTED from this run: with statements/send unpublishable and sends/day not a measured rate, `projectDailyGrowth` would multiply two caveated numbers; the artifact carries the arithmetic under `projected` with the same notes, for P27's re-measure                                                                                                                                                                                                                                                | n/a                                | `docs/measurements/2026-09-07-loadmodel.json` |

## Pacing run (M14)

| Quantity                                           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cap violations (ledger vs `instance_pacing_state`) | **0** over 1,000 `pacing_ledger` rows (`eff_daily_cap` 25 per instance, derived from the heaviest class's 600 sends/day over the 60-minute run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `reserve()` p99                                    | **35 ms — MISSES the 25 ms SLO** (through PgBouncer transaction mode: **yes**, `THROUGH-PGBOUNCER`); p50 6 ms, p95 9 ms, max 166 ms, 7,234 samples (no CI computed by the sampler — sample count stated instead). Honesty: three restore drills (18:30:48, 18:56:01, 19:05:11 IST, 5-9 s of `pg_dump`+`pg_restore` I/O each on the same server) ran inside this window and cannot be separated from the tail post hoc; the number stands as measured and a re-measure with nothing else on the box is a P27 item.                                                                                                                                                                                                        |
| Orphan reservations                                | NOT MEASURABLE in v1 — no orphan detector (docs/RUNBOOK.md#deferred-alerts); cap violations measured directly instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lost/failed/duplicated jobs                        | **0 lost** (rows conserved: 6,540 steady + 100,000 burst = 106,540 = sent 6,417 + still queued 100,123 + 0 terminal-failed + 0 blocked + 0 cancelled), **0 failed**, **0 duplicates** (the run's `duplicateWaIds` measure is schema-guaranteed by `message_wa_ids_message_id_uq` — the honest acked-attempts-per-job measure landed after this run, FIX-H). The artifact's own verdict is **FAIL**: the `reserve()` SLO miss above, plus a conservation problem that was a harness double-count (`driverEnqueued` 206,540 added the 100,000 burst twice; fixed in `run-pacing.ts` after the run; the row side was conserved). 100,123 of the burst were still queued at the end — the poll-bound drain documented below. |
| Other tenants' claim p99 before/during burst       | **12 ms before (3,586 samples) → 6 ms during the burst (3,721 samples)**, fairness ratio 0.50 (OK): the 100,000-recipient burst into one heavy tenant did not degrade the other tenants' claim latency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Artifact                                           | `docs/measurements/2026-09-07-pacing-60m.json` (60 minutes, N = 1,000 over 10 workers, 3 tenant classes, burst at t = 1800 s; sweeps at production cadence: reaper 0 / reconciler 0 / blocked 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Sessions per box and per worker

NOT MEASURED this session: the per-worker ramp (M7) and per-socket connect latency (M5) were not run (carried since P10, see "What this document does NOT prove"). The only per-box figure with evidence is the drift fleet: 1,000 resident sockets in ONE process at ~467 MiB RSS (`docs/measurements/2026-09-07-drift-header.json`, hourly rows in the raw JSONL) — a residency figure, not a sessions-per-worker capacity claim. No `sessions-per-box.json` artifact exists, so no number is published here.

## Chaos SLOs (M11/M12)

| Scenario                                                                               | Measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Artifact                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `kill -9` takeover (max/p99, ≤ 45 s target)                                            | **29,936 ms max = p99** (one victim worker, 50 of 300 instances; fleet 300 instances / 6 workers, real child processes, 426 sends observed before and during the kill; fence strictly increased on all 50; 300 still owned; 0 jobs lost) — under the 45 s target, and consistent with the real `leaseTtl 30 s` (stale-at-30 s then acquire, real takeover grace). Measured N here is 300, not 1,000: the chaos runner ran beside the live drift fleet and load run on the same box.                                                                                                                                                                     | `docs/measurements/2026-09-07-chaos-worker-kill.json`            |
| `needs_reconcile` produced/explained                                                   | fleet-scale run: **0 produced / 0 explained / 0 remaining** — a 20-40 ms fake send is rarely mid-flight at the kill instant. The property itself is proven by `worker-kill.integration.test.ts` (`every_needs_reconcile_from_the_kill_is_explained_not_merely_counted`: seeded dispatched attempts → reaper → reconciler → every row resolved or `blocked_needs_review`, none silently re-queued).                                                                                                                                                                                                                                                      | `docs/measurements/2026-09-07-chaos-worker-kill.json`; test file |
| redis-ctl flush recovery (scans to first claim)                                        | **All 300 instances re-owned 5 ms after `FLUSHALL` on redis-ctl**, 300 sends observed before/during, `instancesStillOwned 300`, `redisSigDbsizeDelta 0` (fleet 300 instances / 6 workers, host runner beside the live drift fleet). Honest reading: ownership (lease/fence) lives in Postgres, so a ctl flush un-owns nothing — the drill proves the ctl tier is rebuildable (caches, wake channel, fleet caps), not that recovery is fast. The ratchet store (redis-sig) is never a flush target (`assertFlushTargetAllowed` refuses it before any I/O).                                                                                               | `docs/measurements/2026-09-07-chaos-redis-flush.json`            |
| `wp_fence_regression_total` delta                                                      | **0** across worker-kill (50 fences strictly increased), rolling-deploy (6 waves, `cred_version` never regressed) and redis-flush (`fenceRegressionDelta 0`) — fence monotonicity held under every drill.                                                                                                                                                                                                                                                                                                                                                                                                                                               | the three chaos artifacts above                                  |
| Postgres outage (self-fences, sockets open, buffered saves)                            | `<FILL>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `<FILL>`                                                         |
| Rolling deploy (wave size formula, measured % down max, re-QR count, unresolved count) | wave size `max(1, floor(300 × 0.02 / 50))` = **1** worker per wave, 6 waves, every drain exit 0, **re-QR 0** (storage-layer evidence: `link_state` stays `linked`, `cred_version` never regresses — the harness socket emits no real qr event), **unresolved 0**, 0 jobs lost, 1,381 sends observed during the roll. **Measured max down at any instant = 50 sessions = 16.7 % of the fleet** — one worker of six. The ≤ 2 % deploy SLO is arithmetically reachable only when `sessionsPerWorker ≤ 0.02 × fleetSessions` (≥ 50 workers; at 10k with 135/worker it is 1.35 %, at 1,000 / 10 workers it would be 10 %). Stated as measured, not smoothed. | `docs/measurements/2026-09-07-chaos-rolling-deploy.json`         |

## Restore drill

RTO measured **4,377 ms `pg_restore` wall time** (`--jobs=4`; snapshot-pinned
`pg_dump --snapshot` 4,249 ms) vs ADR 0018 §7 per-tier claim (~1 h at <=2,000 ·
4-6 h at 10,000 · ~15 min via promotion); restored data size **232,166,650 bytes
logical dump** (source 950 MB on disk including bloat), 98 tables, schema 69 = 69,
every row count equal to the counts taken inside the dump's own
`pg_export_snapshot()`, one real claim executed and rolled back on the copy,
plaintext scan 0 hits. Drill #5 of five (2026-09-07 19:05 IST, inside the live
pacing run's burst window); #1-#4 each failed on a VERIFIER defect (wrong column
name, live-source row counts, a fence-vs-epoch predicate that exists nowhere in
`claim-jobs.sql`) — run log rows 28-30. The restored instance count derived the
ADR 0018 **5,000 band** (target: promotion), so this is a dump-and-restore lower
bound for dev-sized data, not a production RTO. See
`docs/capacity/restore-drill-2026-09-07.md` and
`docs/measurements/2026-09-07-restore-drill.json`.

## What this document does NOT prove

- Gate C (>= 2,000 concurrent sessions in production, within SLO, 7 days) is
  NOT closed by this document.
- No real linked WhatsApp number was measured (founder open item 6).
- The k6 script was NOT executed — no k6 binary on the measurement host; a
  Node driver replaying the same tenant mix was used instead.
- The 8-hour pacing-run target vs the measured run duration above may differ;
  the honesty note in "Measured N and run durations" records the gap.
- The drift verdict (day 8) is pending — see the banner above.
- **Synthetic sessions, two fidelities.** The drift fleet holds REAL Baileys
  sockets resident at the awaited-serverHello point (SOCKET-RESIDENT-PRE-HANDSHAKE,
  ADR 0032 — no handshake can complete against a local peer without cert
  forgery, which is forbidden). The load-model, pacing and chaos fleets run the
  REAL lease/fence/creds/claim/reserve/dispatch/result path in real worker
  processes but over an in-memory FakeSock and a fake transport that returns a
  unique provider id after 20-40 ms of real latency — no WhatsApp wire traffic
  exists. Nothing here measures WhatsApp's own behaviour.
- **Throughput is safety-poll-bound, not pacing-bound (production finding).**
  The send loop claims one job per trigger; a wake is edge-triggered (one per
  enqueue); and `send-loop-worker-wiring.ts` wires only the safety poll — the
  per-instance `next_eligible_at` nudge that `send-loop-fleet-wiring.ts`
  documents (and scope delta "what breaks first" #1 requires) does not exist. A
  paced backlog therefore drains one job per instance per safety poll (30 s
  production default), not per pacing gap (15 s floor). Carried to P27; every
  drain time in this document was measured under that behaviour.
- **Orphan pacing reservations are NOT MEASURABLE** in v1 (no detector —
  `docs/RUNBOOK.md#deferred-alerts`); cap violations are counted directly from
  `pacing_ledger` vs `instance_pacing_state` instead.
- **Per-worker ramp (M7) and per-socket connect/handshake latency (M5)** were
  not run this session (carried since P10).

## Raw artifact path convention

Each measurement in this document writes ONE JSON/JSONL artifact under
`docs/measurements/<date>-<measurement>.json` (or `.jsonl` for per-tick raw
rows), mirroring `docs/capacity/session-cost.md`'s convention. Each artifact's
header records: hardware fingerprint, Node/Baileys versions, run parameters,
the banner, and honesty notes for any shortened window. A row in this
document with no corresponding artifact path is not a published figure — it
stays `<FILL>` until the artifact exists. A `.INCOMPLETE.json` artifact (written
when a run's drain times out, `drain.complete: false` — FIX-P26-E) is never a
published figure either, however tempting its numbers look; it is evidence of
a failed run, not a load model.
