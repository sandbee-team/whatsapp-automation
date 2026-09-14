# Operator Runbook

This runbook is for whoever is on call for WP: staff triaging an alert, or an
engineer investigating a ticket. Metrics live in Prometheus/Grafana, logs live
in Loki (see "Where things are" below). Alerts carry one of two severities:
**page** (wake someone up, act now) and **ticket** (handle during business
hours). The standing rule behind every procedure in this document: a pause
never deletes, fails, or reorders a queued job - recovery is about restoring
service, never about recovering lost work.

---

## How to read this runbook

Each alert section below follows the same five-part shape:

- **Symptom** - the alert name and the expression that fired it.
- **What is true** - what the alert firing does and does not mean; what state
  the system is actually in.
- **First check** - the metric, endpoint, or table to look at before doing
  anything.
- **Action** - the procedure to run, and who is allowed to run it.
- **What NOT to do** - the mistakes that make things worse, most often an
  automated or scripted "fix" that violates a core invariant.

---

## Where things are

- **Prometheus:** `http://127.0.0.1:9090`
- **Alertmanager:** `http://127.0.0.1:9093`
- **Grafana:** `http://127.0.0.1:3001`
- **Logs:** via Grafana Explore, backed by Loki.

The observability stack lives in `infra/observability/` and is started with:

```bash
docker compose -f infra/observability/docker-compose.observability.yml up -d
```

Each backend role exposes its own `/metrics` on an internal-only listener
(`WP_METRICS_BIND`, default `127.0.0.1`; `WP_METRICS_PORT`, default `9464`).
In dev, each role publishes its listener on loopback at a distinct port so
they can all run on one host: api `:9464`, session-worker `:9465`, cron
`:9466`, relay `:9467`.

Logs are shipped as JSON lines by Alloy. The stream labels are ONLY `env`,
`role`, and `level` - `client_id` and `instance_id` are JSON fields inside the
line, not stream labels. Query them with a LogQL `json` filter, e.g.:

```
{role="session-worker"} | json | instance_id="<instance_id>"
```

**Why this split:** a label creates a new time series / log stream per
distinct value. `client_id` and `instance_id` are high-cardinality (one value
per tenant/instance) - turning either into a Prometheus label or a Loki stream
label multiplies series count by tenant count and takes down Prometheus and
Loki the same way. This is the same reasoning behind the four-gauge rule for
`INSTANCE_LABELLED_GAUGES` (see `docs/CONVENTIONS.md`): only a small, fixed
set of gauges may ever carry `instance_id`/`client_id` as a label; everything
else is a JSON log field or a Postgres rollup.

---

## Alerts

## alert-hard-signal-pause

**HardSignalPause** - page - `increase(wp_hard_signal_pauses_total[10m]) > 0`

**What is true:** a restriction or hard signal (HTTP 403/402/406, a
logged-out signal such as 401/500/411, a session-replaced signal such as 440,
or an exhausted reconnect budget) paused exactly one instance. Sending
stopped for that instance; every queued job for it is preserved untouched;
the tenant was notified (panel, webhook, and email).

**First check:** `GET /v1/instances/:id/health/why` and the instance's
`pause_reason` / `disconnection_reason_label`.

**Action:** nothing automatic happens and nothing should. The tenant (or
staff acting on the tenant's behalf) resumes only after understanding the
signal, via `POST /v1/instances/:id/resume`. If the pause reason is a
logged-out signal, resume is not enough - the instance must re-link via
`POST /v1/instances/:id/link`.

**What NOT to do:** never script or automate a resume; never retry the send
that triggered the pause; never move the number to another worker or IP to
"work around" the signal.

## alert-instances-unowned

**InstancesUnowned** - page - for 2m - `wp_instances_unowned > 0`

**What is true:** a desired-online instance has had no live lease for more
than 45 seconds - either its worker died, or the fleet has no capacity to
take it over (see `wp_fleet_capacity_headroom`). Every queued job for it is
preserved (jobs live in Postgres, not on the worker). Takeover is automatic:
any worker with headroom picks it up on its next scan (within 45 seconds plus
connect stagger).

**First check:** `up{job="wp",role="session-worker"}`, `wp_worker_sessions`
vs `wp_worker_session_cap`, and `wp_fleet_capacity_headroom`.

**Action:** restart the dead worker, or add a worker if the fleet has no
headroom. After 3 scans with no taker, an unowned instance goes `degraded`
with `INFRA_UNAVAILABLE` and recovers automatically once capacity returns.

**What NOT to do:** do not fail or delete the instance's queued jobs; do not
park the number just to free a slot.

## alert-unresolved-rate-high

**UnresolvedRateHigh** - ticket - for 15m - `wp:unresolved_rate_1d > 0.001`

**What is true:** the share of sends whose outcome is unknown (the socket
died mid-send, so the provider ack/echo was never observed) exceeded 0.1% of
sends over the trailing day. Most of these resolve automatically via echo
reconciliation; the remainder land in `blocked_needs_review`.

**Action:** see [Unresolved sends and blocked_needs_review](#unresolved-sends-and-blocked-needs-review).

## alert-band-flaps-high

**BandFlapsHigh** - ticket - for 10m - `increase(wp_pacing_band_flaps_total[1d]) > 3`

**What is true:** health bands are oscillating for one or more instances -
this is a sign our thresholds are miscalibrated for this fleet, not that a
tenant is misbehaving.

**Action:** review `wp_health_band_changes_total{from,to}` to see the
transition pattern. Do NOT loosen caps for the affected tenant as a fix -
file a threshold review instead.

## alert-fleet-headroom-low

**FleetHeadroomLow** - ticket - for 10m - `wp:fleet_headroom_ratio < 0.2`

**Action:** add a worker or box before headroom reaches zero. At zero
headroom, workers degrade in place - they stop claiming and stop grabbing new
instances but keep existing sockets open - rather than shedding and
re-grabbing, which would just churn.

## alert-fence-regression

**FenceRegression** - page - no window - `increase(wp_fence_regression_total[5m]) > 0`

**What is true:** a Redis-vs-Postgres fence disagreement was detected -
Redis's mirrored fence value is behind what Postgres minted (for example,
because Redis was flushed and restored from an old snapshot), or there is a
bug.

**Action:** see [Fence regression](#fence-regression).

## alert-wallet-drift

**WalletDrift** - page - `wp_wallet_drift_minor != 0` (either direction)

**Action:** see [Wallet drift and reconciliation findings](#wallet-drift-and-reconciliation-findings).

## alert-redis-sig-memory-high

**RedisSigMemoryHigh** - page - for 5m - redis_exporter
`redis_memory_used_bytes/redis_memory_max_bytes > 0.75` on `redis-sig`

**What is true:** `redis-sig` holds Signal session records and runs with a
`noeviction` policy - losing our end of a ratchet makes already-encrypted
inbound mail permanently unreadable, so eviction is never an acceptable
failure mode here. At maxmemory, WRITES FAIL, and the affected instance
degrades: it stops sending but keeps its socket and preserves its queued
jobs.

**Action:** raise `redis-sig` maxmemory, or add RAM. The Postgres
write-behind tier for this data is gated on measured thresholds (24 GB
working set, or 0.5% eviction-attributed decrypt failures).

**What NOT to do:** never switch `redis-sig`'s eviction policy to
`allkeys-lru`.

## alert-signal-decrypt-evicted

**SignalDecryptEvicted** - ticket - for 15m -
`wp_signal_decrypt_failure_total{cause="evicted"}` > 0.5% of
`wp_inbound_events_total` over 1h

**What is true:** this is a Gate-A input (ADR 0018 §5) - a real signal that
`redis-sig` eviction is destroying session state.

**Action:** confirm the `redis-sig` policy is still `noeviction`
(`assertSignalKeyspacePolicy` refuses to boot the process otherwise) and
check TTL and working-set size.

## alert-inbound-shed

**InboundShed** - ticket - `increase(wp_inbound_shed_total[10m]) > 0`

**What is true:** inbound admission shed messages above
`INBOUND_MAX_PER_MINUTE` or an in-flight limit for some instance. Outbound
sending for that instance is unaffected.

**Action:** check `wp_inbound_overflow_total{kind}` and the instance's
`inbound_max_per_minute` column.

## alert-broadcast-expansion-lag

**BroadcastExpansionLag** - ticket - for 10m - p99
`wp_broadcast_expansion_lag_seconds > 300`

**Action:** see [Stuck broadcast expansion](#stuck-broadcast-expansion).

## alert-stranded-epoch-jobs

**StrandedEpochJobs** - page - for 5m - `wp_stranded_epoch_jobs > 0`

**What is true:** there are `message_jobs` rows in `blocked_needs_review`
with `unresolved_reason = 'session_epoch_advanced'` - a re-link advanced the
session epoch while jobs were still queued under the old epoch. This is a
silent-loss class: nothing failed and nothing was deleted, progress on those
jobs simply stopped.

**Action:** a human confirms the exact affected count and either restamps
via `POST /v1/broadcasts/:id/restamp`, or cancels the broadcast. This is
never auto-resolved.

## alert-shed-no-taker

**ShedNoTaker** - page - `increase(wp_shed_no_taker_total[10m]) > 0`

**What is true:** a worker shed an instance and no other worker re-grabbed it
within two scan cycles - the fleet is at capacity.

**Action:** add capacity; check headroom. The shed instance's state and
queued jobs stay preserved throughout.

## alert-messages-out-without-job

**MessagesOutWithoutJob** - page - `wp_messages_out_without_job > 0`

**What is true:** core invariant 1 (durable-first) was violated - an
outbound provider message id exists with neither a matching `message_jobs`
row nor echo evidence. This is a code bug, not an operational condition.

**Action:** freeze deploys. Find the writer by looking for
`message_wa_ids` rows with `direction='out' AND message_id IS NULL AND
observed_at IS NULL`, and file a CRITICAL.

**What NOT to do:** do not delete the offending rows.

## alert-worker-eventloop-lag-high

**WorkerEventLoopLagHigh** - ticket - for 5m (label `scope=worker`) -
`wp_worker_eventloop_lag_p99 > 200` (ms)

**What is true:** admission goes to `holding` once event-loop lag exceeds 200
ms for 3 consecutive samples.

**Action:** see [Worker OOM and box RSS](#worker-oom-and-box-rss).

## alert-worker-sessions-saturated

**WorkerSessionsSaturated** - ticket - for 10m (label `scope=worker`) -
`wp_worker_sessions >= wp_worker_session_cap`

**Action:** add a worker. Never raise the cap by hand - it is DERIVED from
the worker's heap budget and the measured per-session footprint, not a knob.

## alert-session-rss-above-bracket

**SessionRssAboveBracket** - ticket - for 30m (label `scope=worker`) -
`wp_session_rss_bytes_est > 60 MiB`

**What is true:** per ADR 0018, if measured per-session RSS reaches or
exceeds 60 MB, the shape of the 10k-session path changes.

**Action:** capture a heap snapshot and file it for architecture review. Do
not change caps by hand.

## alert-scrape-target-down

**ScrapeTargetDown** - page - for 2m - `up{job="wp"} == 0`

**What is true:** this alert inhibits the three `scope=worker` alerts above
for the same `instance` label, so a dead scrape target does not also fire a
storm of worker alerts.

**Action:** is the process up? (`docker compose ps`, role logs.) Is the
metrics listener bound correctly? (`WP_METRICS_BIND` / `PORT`.) Note: a
production process refuses to start with `WP_METRICS_BIND=0.0.0.0` - that is
a configuration error, and the fix is to bind to the container hostname, not
to relax the check.

## alert-lease-takeovers-high

**LeaseTakeoversHigh** - ticket - `increase(wp_lease_takeovers_total[1h]) > 3`

**What is true:** more than 3 takeovers per hour indicates flapping, not
ordinary failover.

**Action:** check for worker restarts, Redis latency (`redis-ctl`), and
`wp_lease_lost_total{cause}`.

## alert-outbox-backlog

**OutboxBacklog** - ticket - for 5m - `wp_outbox_depth > 10000`

**Action:** see [Outbox relay: drain a backed-up outbox](#outbox-relay-drain-a-backed-up-outbox).

## alert-relay-stalled

**RelayStalled** - page - for 2m - depth > 0 and no publishes for 2m

**Action:** see [Outbox relay: drain a backed-up outbox](#outbox-relay-drain-a-backed-up-outbox).

## alert-inbound-dead-letters

**InboundDeadLetters** - ticket - `increase(wp_inbound_dead_letters_total[1h]) > 0`

**What is true:** rows exist in `inbound_dead_letters`, grouped by
`error_class`. An inbound handler throwing never affects sending.

**Action:** query `inbound_dead_letters` grouped by `error_class` and
investigate the handler that is failing.

## alert-reconcile-ambiguous

**ReconcileAmbiguous** - ticket - `increase(wp_reconcile_ambiguous_total[1h]) > 0`

**What is true:** an unresolved send matched more than one echo candidate -
we are losing information about which echo belongs to which send.

**Action:** see [Unresolved sends and blocked_needs_review](#unresolved-sends-and-blocked-needs-review).

---

## Operator procedures

## pause-and-resume

Resume is always a human action: `POST /v1/instances/:id/resume`. There is no
automatic resume path for a hard-signal pause.

Desired state (independent of pause) is controlled with
`POST /v1/instances/:id/park` and `POST /v1/instances/:id/online`. A parked
instance never receives sends. In both cases, queued jobs are always safe -
parking or pausing never deletes, fails, or reorders a queued job.

## reconnect-and-re-qr

- `POST /v1/instances/:id/link` - start a fresh link.
- `POST /v1/instances/:id/link/refresh` - refresh an in-progress link.
- `GET /v1/instances/:id/link-status` - check link status.

The reconnect budget is 8 attempts; once exhausted, the instance is paused
until a human explicitly resumes it. A logged-out signal purges the stored
auth state and requires a fresh QR scan - resume alone will not recover it.

## unresolved-sends-and-blocked-needs-review

A send whose provider outcome is unknown (socket died mid-send) is marked
`needs_reconcile`. Echo reconciliation resolves most of these automatically
by matching a later provider echo. Anything that cannot be resolved lands in
`blocked_needs_review`.

From there, the tenant or staff makes an explicit choice per message:

- `POST /v1/messages/:id/unresolved/retry`
- `POST /v1/messages/:id/unresolved/discard`

Never retry an unresolved send blindly or automatically - only after a human
decision.

## redis-loss-by-tier

WP uses three separate Redis instances with different loss behaviour by
design:

- **`redis-ctl`** - leases, rate-limit buckets, pacing advisory state, wake
  pub-sub. Loss stops the whole fleet within about 15 seconds via a watchdog
  self-fence. This is fail-safe and work-preserving: nothing sends while
  `redis-ctl` is down, no job is lost, and the fleet resumes automatically
  once it is back.
- **`redis-sig`** - Signal session records, `noeviction`, 30-day TTL. A write
  failure here degrades the affected instance - it stops sending, keeps its
  socket, and preserves its queued jobs. Losing `redis-sig` outright makes
  inbound messages already encrypted to the lost sessions permanently
  unreadable.
- **`redis-cache`** - rebuildable caches only (device lists, group metadata),
  `allkeys-lru`. Loss here is harmless; the cache is simply re-fetched.

## fence-regression

A fence is a monotonically increasing number minted by Postgres per lease
(`db/queries/lease-mint-fence.sql`) and mirrored into Redis. A regression
means Redis's mirrored fence value is behind what Postgres last minted - most
commonly because Redis was flushed and restored from an older snapshot, or a
bug reset it.

The system self-heals within one takeover cycle. Verify by watching
`wp_fence_regression_total` go flat afterward. If it keeps recurring, stop
and investigate Redis persistence configuration rather than continuing to
let it self-heal.

Never reset fences by hand.

## kek-rotation

There are four KEK purposes: `session`, `tenant-secrets`, `user-secrets`, and
`optout-pepper`. The key ring file lives at `KEY_RING_PATH`, mode `0400`,
under `/etc/wp/secrets/`.

Rotation means adding a new `active` key for a purpose while keeping old keys
readable - older ciphertext must still be able to open with its original
key - and re-sealing lazily as rows are next written, not in a bulk pass.

`optout-pepper` is NEVER rotated: it is an HMAC lookup key, and rotating it
orphans every previously stored phone hash.

The key ring exists in exactly three places: the host secret store, the
founder's offline encrypted copy, and a sealed second offline copy. Run a
quarterly restore drill - a key backup that has never been restored is not a
backup.

The `kek_id` log field (and metric label, where applicable) tells you which
key sealed a given row.

Run the drill with `pnpm run drill:keyring` - see
[`docs/runbooks/key-ring-restore.md`](runbooks/key-ring-restore.md) for the
full procedure and cadence.

## restore-drill

Restores use pgBackRest with an off-site repository and point-in-time
recovery (PITR).

RTO **targets** by tier (design targets, not measured):

- About 1 hour at up to roughly 2,000 connected numbers, restoring from
  backup.
- 4-6 hours at roughly 10,000 connected numbers restoring from backup, unless
  a warm standby exists.
- About 15 minutes via promoting a streaming replica - this is the intended
  recovery path from roughly 5,000 connected numbers upward.

RPO target: 5 minutes.

Run a timed drill before the first paying tenant, and re-time it at every 3x
growth in connected numbers.

After any restore: the `ROLE=migrate` schema assertion runs, and workers
refuse to boot on a schema mismatch.

Run the drill with `powershell -File infra/backup/restore-drill.ps1` (POSIX
twin: `infra/backup/restore-drill.sh`; moved here in P29a from
`scripts/ops/`, which now forwards). Default mode (`basebackup`) runs a real
`pg_basebackup -X stream` against the dev Postgres, restores it into a
SCRATCH docker container on a SCRATCH port with a SCRATCH named volume
(created and destroyed by the drill), verifies schema version + every
table's row count + a named four-table parity check + the `wallet_ledger`
continuity invariant + a rolled-back claim + a plaintext scan, writes
`docs/measurements/<date>-restore-drill.json` and
`docs/evidence/P29-restore-drill.md`, then tears the container/volume down
(pass `--keep` to leave it for inspection). **It never touches `wp` itself**:
only the scratch container/volume are created and destroyed; a
production-looking target is hard-refused before anything is spawned
(`infra/backup/restore-drill-lib.ts`'s `assertNotProductionTarget`). A
second mode (`--mode pgbackrest`) builds the production PITR argv shape and
is exercised only by its own unit test on this box (pgBackRest is not
installed on Windows) - see `docs/runbooks/restore-from-backup.md` for the
real operator procedure. Prints
`RESTORE-DRILL: PASS|FAIL mode=<m> rto=<ms> rpo=<s> report=<path>` and exits
with the validator's code.

Measured RTO (2026-09-07, P26 drill #5, `docs/measurements/2026-09-07-restore-drill.json`):
**pg_restore wall time 4,377 ms** (`--jobs=4`) from a **232,166,650-byte** snapshot-pinned
`pg_dump` that took 4,249 ms, for the live dev database (950 MB on disk including
bloat, 98 tables, schema version 69) with a 1,000-instance fleet mid-burst -
schema, every table's row count (counted inside the same `pg_export_snapshot()`
the dump used), a rolled-back real claim and the plaintext scan all verified on
the restored copy. Restored instance count placed it in the ADR 0018 5,000
band, whose design target is promotion (~15 min), so the number above is a
dump-and-restore lower bound for this data size, not a production RTO: real
production data is larger, pgBackRest + PITR replay adds time, and no promotion
path exists on the dev box. Re-time at the first paying tenant and at every 3x
growth (drill #1-#4 that day found four verifier defects before this run
passed - see run log rows 28-30 in `plan/v1/P26-scale-proof-1k.md`).

Measured RTO/RPO (2026-09-08, P29a Unit U3, `docs/measurements/2026-09-08-restore-drill.json`,
`basebackup-scratch-container` mode, final run 2026-09-09 after the C1 fix
round): **restore-start-to-verified wall time 94,371 ms (~94 s)**, after a
**9,433 ms** `pg_basebackup -X stream` producing **1,760,975,872 bytes** of tar
for a 925,988,531-byte live dev database (schema version 75; every one of
the 102 public tables counted on the SOURCE and on the restored copy with
zero mismatches; 935 wallet-ledger clients / 941 rows checked for continuity
with zero breaks; four-table parity all matched with `messages` correctly
reported as not existing in v1; a rolled-back real claim proven on the
restored copy) restored into a scratch `postgres:17` docker container - well
under the ~1 h launch-tier target. Earlier runs the same day measured
~118 s and ~89 s; the spread is dev-box load, not a code change.
Measured RPO **0 s** against the 5-minute target, under the
`recovery_target = 'immediate'` caveat (the recovery point is the backup's
own consistent point - see `computeRecoveryPoint` in
`infra/backup/restore-drill-lib.ts`), so this is not comparable to a real
PITR-replay RPO. Both figures are a dev-box lower bound for the same reasons
the 2026-09-07 paragraph above states (smaller dataset than production, no
off-site-repository network hop, no PITR replay). One defect was found and
fixed while proving this drill for real on this box: `docker cp` of the
~1.7 GB base-backup tar failed outright over this Docker Desktop
installation's named-pipe transport ("read/write on closed pipe"); streaming
the tar into the container over `docker exec -i ... sh -c "cat > path"`
(stdin) instead completed with a byte-for-byte match - see the mode's own
header comment in `infra/backup/restore-drill-lib.ts`.

## wallet-drift-and-reconciliation-findings

`wp_wallet_drift_minor` is a fleet-wide gauge. Per-client detail lives in the
`wallet_reconcile_findings` table, grouped by `kind`:

- `continuity_break`
- `balance_mismatch`
- `missing_debit`
- `missing_debit_repaired`
- `missing_debit_capped`
- `orphan_debit`
- `rollup_parity`
- `orphan_guard`

Automatic correction happens ONLY for the missing-debit finding (kind
`missing_debit`), via an `adjustment_*` row with `reason='reconciliation'`,
under a per-client daily cap. Every other finding kind is a staff decision,
not an automatic correction.

Money is always integer minor units - never floats - anywhere in this path.

## optout-rate-high

The "opt-out rate exceeds 10 per 1,000 sends in 24h for a client" check is
**not** a Prometheus alert - a `client_id` label on a Prometheus metric is
forbidden by the four-gauge rule (see "Where things are" above). Instead it
runs as a scheduled Postgres check in the cron role, and on trigger creates a
tenant notification of kind `optout_rate_high` (delivered via panel, email,
and webhook, deduplicated per client per day).

Staff read these via the notifications table. This is a content problem to
raise with the tenant - never a reason to change their pacing.

## stuck-broadcast-expansion

Fan-out (broadcast) recipient expansion uses two resumable cursors: snapshot, then
expansion. Check `campaigns.status`, `campaign_counters`, and
`wp_broadcast_recipients_total{status}` to see where a broadcast is stuck.

Control endpoints: `POST /v1/broadcasts/:id/pause`,
`POST /v1/broadcasts/:id/resume`, `POST /v1/broadcasts/:id/cancel`. Cancel
stops the very next claim.

If expansion left stranded epochs behind (see
[alert-stranded-epoch-jobs](#alert-stranded-epoch-jobs)), use the restamp
procedure described there.

## worker-oom-and-box-rss

Relevant gauges: `wp_box_rss_bytes`, `wp_session_rss_bytes_est`,
`wp_worker_session_cap`.

`wp_worker_session_cap` is DERIVED, never set directly:

```
cap = max(10, floor((heapBudgetMb - baselineMb) / measuredSessionMb * 0.85))
```

capped at a ceiling of 250. Each worker is configured with both a
`--max-old-space-size` and a container `mem_limit`.

Admission goes to `holding` when sessions reach the cap, or RSS exceeds 80%,
or event-loop lag exceeds 200ms for 3 samples. Shedding starts at RSS above
92% and continues until RSS is back below 85% - always via a graceful
`sock.end()`, never `logout()`.

A worker that sheds three or more times in an hour should be drained by an
operator. Never OOM-kill a worker's sessions because of a miscalibrated cap.

Note: the 18 MB / 35 MB per-session brackets referenced in architecture
documents are **derived, unmeasured until Gate B (P26)** and must not be
quoted as current fact.

## deploy-wave-size-and-drain

Images are tagged `v1.<YYYYMMDD>.<n>`. Deploy sequence:

```
docker build -> docker save -> rsync -> docker load -> ROLE=migrate -> rolling restart, one session-worker at a time
```

`stop_grace_period` is at least 45 seconds.

Drain sequence for a single worker: stop grabbing new instances -> stop
claiming new jobs -> wait up to 20 seconds for in-flight sends to finish (any
still in flight become `needs_reconcile`) -> `sock.end()` on every session
(never `logout()`) -> release leases -> close connection pools -> exit 0.

Wave size (how many workers restart concurrently) is derived from an SLO, not
picked by feel:

```
concurrency = max(1, floor(fleetSessions * 0.02 / sessionsPerWorker))
```

i.e. at most about 2% of sessions are disconnected at any instant. At a large
fleet size this makes a full rolling deploy take roughly an hour - that time
is the price of the SLO, not a bug to fix.

Rollback is simply re-deploying the previously retained image tag.

Measured 2026-09-07 at 300 instances / 6 workers: one worker per wave = 16.7 % of
sessions down per wave - see `chaos-drill-findings` for why the 2 % SLO needs

> = 50 workers.

## chaos-drill-findings

Measured 2026-09-07 (P26) on the Linux WSL2 target with a fleet of 300
instances over 6 real worker processes (50 per worker) driving the real
lease/fence/claim/dispatch/result path over a FakeSock and a fake transport
(no WhatsApp traffic). Every number below comes from Postgres rows, the real
`LeaseManager`, or a real Redis `dbsize` - never from a harness counter.
Artifacts: `docs/measurements/2026-09-07-chaos-{worker-kill,rolling-deploy,redis-flush}.json`.

- **`kill -9` of one worker (50 instances):** every instance re-owned in
  **29,936 ms max = p99** (fence strictly increased on all 50, 0 jobs lost,
  300/300 still owned). That is the real `leaseTtl` 30 s plus takeover, so a
  killed worker means about 30 s without sends for its instances - expected,
  not an incident. `LeaseTakeoversHigh` (>3/h) is about flapping, not one
  kill. 0 `needs_reconcile` rows were produced (a 20-40 ms send is rarely
  mid-flight at the kill instant); the "every unresolved send is explained,
  never silently re-queued" property is proven by
  `worker-kill.integration.test.ts`, not by this count.
- **Rolling deploy:** the wave formula above gives **1 worker per wave** at
  this size, i.e. **50 sessions = 16.7 % of the fleet down per wave**. The
  <= 2 % SLO is arithmetically reachable only when
  `sessionsPerWorker <= 0.02 x fleetSessions` (**>= 50 workers**; at 10k with
  135 per worker it is 1.35 %, at 1,000 over 10 workers it would be 10 %).
  Plan worker counts from that inequality, not from CPU headroom. 6 waves,
  every drain exit 0, re-QR 0, unresolved 0, 1,381 sends during the roll.
- **`FLUSHALL` on redis-ctl:** 300/300 instances still owned, all re-owned
  5 ms after the flush, 0 fence regressions, redis-sig `dbsize` unchanged
  (the drill refuses any target but `redis-ctl` before opening a connection).
  Ownership lives in Postgres; ctl holds only rebuildable state (caches, the
  wake channel, fleet caps). Losing it costs one safety-poll of throughput,
  nothing durable.
- **Postgres outage:** exercised at fleet scale only through the injected
  failing pool (`postgres-outage.integration.test.ts`: self-fence, sockets
  stay open, creds saves buffer), never by stopping a shared Postgres.
- **Stuck-job loop (found by the 100k load run, not by any suite):** a job
  can sit in `processing` with `attempts = 0` forever when a FOREIGN
  `send_attempts` row already occupies `(message_job_id, attempt_no)`: dispatch
  raises `DispatchAlreadyRecorded`, the claim lease expires, the reaper joins
  `send_attempts` by `lease_id` (NULL on the foreign row) and re-queues instead
  of marking `needs_reconcile`, and the next claim repeats. Symptom: repeated
  `DispatchAlreadyRecorded` for the same job id across reaper sweeps. Action:
  read `send_attempts` for that job id; if the row is not the job's own
  (`lease_id` NULL, foreign `client_id`, no `prepared_at`), set the job to
  `blocked_needs_review` with an id-scoped UPDATE and find the writer (the
  2026-09-07 case was a test fixture's fake ids). Structural fix (resolve from
  the existing row / join by `(message_job_id, attempt_no)`) is carried to P27.

## metrics-listener-and-scrape

Every role's metrics listener is internal-only. A production process refuses
to start with `WP_METRICS_BIND=0.0.0.0` - that is a configuration error to
fix, not a check to bypass.

Metrics carry a `role` label sourced from the scrape target's own labels, not
set by the exporting process itself.

The manifest `infra/observability/metrics.generated.json` is generated from
`@wp/domain`'s metric inventory. CI fails if a metric's registration and its
inventory entry disagree - see `docs/CONVENTIONS.md`'s "Adding a metric"
checklist for the full procedure.

The `wp:session_availability_ratio` SLO recording rule is computed from
`wp_instances_connected` / `wp_instances_desired_online` (5-minute rollup),
**not** from `wp_instance_link_state`.

## deferred-alerts

Two alerts described in the architecture blueprint have **no v1 mechanism**
and are recorded here rather than faked with an alert that cannot actually
fire correctly:

- Pacing orphan reservations exceeding 0.5% of sends.
- Pacing ledger repair exceeding 5 units.

There is no orphan-reservation detector and no ledger-repair path in v1.
Revisit both once the pacing reconciler exists. In the meantime, P26 measures
cap violations directly instead.

Two of the four allow-listed instance gauges, `wp_instance_queue_depth` and
`wp_instance_oldest_queued_seconds`, are **not registered** in v1 - the
fleet-level `wp_queue_depth_total` / `wp_oldest_queued_seconds_max` carry the
queue-lag SLO instead. Registering the per-instance pair is a cardinality
decision deferred to the scale-proof phases.

---

## Webhook endpoints: re-enable a disabled endpoint

An endpoint is auto-disabled after 20 consecutive terminal HTTP failures (400/401/403/404/422 or max retries reached). To restore it:

### Step 1: Verify the issue is resolved

Check your receiver endpoint. It should now:

- Respond with HTTP 2xx on valid requests
- Not return 400/401/403/404/422
- Not time out or fail the HTTPS/SSRF checks (https-only, no redirects, no private IPs)

### Step 2: Re-enable via API

**Request:**

```bash
curl -X PATCH https://api.wp.local/v1/webhooks/endpoints/{endpoint_id} \
  -H "Authorization: Bearer <session_token>" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true }'
```

**Response:** Returns the endpoint summary with `enabled: true` and `consecutiveFailures: 0` (counter resets on the next successful delivery).

### Step 3: Verify with a test send

```bash
curl -X POST https://api.wp.local/v1/webhooks/endpoints/{endpoint_id}/test \
  -H "Authorization: Bearer <session_token>"
```

Returns:

```json
{
  "success": true,
  "data": { "deliveryId": "delivery_...", "status": "pending" }
}
```

Then check your receiver's logs to confirm the webhook arrived with valid signature headers (`X-WP-Signature`, `X-WP-Event-Id`, `X-WP-Timestamp`).

### Step 4: Monitor in the panel

Navigate to **Settings → Webhooks → Disabled endpoints** to see the re-enabled endpoint and track delivery metrics. The failure counter resets to 0 immediately on re-enable (step 2), so a single subsequent failure never instantly re-disables it.

---

## Outbox relay: drain a backed-up outbox

The outbox is a work queue of unpublished events. A backlog can occur if the relay process is wedged, the relay loop is hung on a slow database scan, or if there are too many pending deliveries.

### Monitor the queue depth

Two Prometheus metrics track outbox health:

- **`wp_outbox_depth`** (gauge) — number of unpublished `outbox_events` rows. Check this every 30–60s if you suspect a backup.
- **`wp_outbox_publish_lag_seconds`** (histogram) — age of the oldest row claimed in a tick. High lag means old events are waiting.

Example query (Prometheus):

```promql
wp_outbox_depth  # current depth
rate(wp_outbox_events_published_total[1m])  # publish rate (events/sec)
```

### Diagnose the relay

**Is the relay running?**

```bash
ps aux | grep 'ROLE=relay'  # or check Docker / systemd logs
```

**Is the relay making progress?**

- Check that `wp_outbox_depth` is decreasing and `wp_outbox_publish_lag_seconds` is low (< 5s for normal operation).
- Watch `wp_outbox_events_published_total` counter increments — if flat, the relay is not claiming rows.

**Is PostgreSQL slow?**

- Check `SELECT count(*) FROM outbox_events WHERE published_at IS NULL;` execution time — should be < 100ms.
- Verify no long-running transactions are holding RLS locks.

### Manual drain (advanced)

If the relay process is hung or deadlocked:

1. **Check relay logs** for errors (network, database connection, or a crash).
2. **Restart the relay:**
   ```bash
   systemctl restart wp-relay  # or docker compose restart relay
   ```
3. **Monitor `wp_outbox_depth`** immediately after restart — it should begin decreasing within 1–2 ticks.

If depth remains high after restart:

4. **Inspect problematic rows:**

   ```sql
   SELECT id, client_id, event_type, created_at, published_at
     FROM outbox_events
    WHERE published_at IS NULL
    ORDER BY created_at
    LIMIT 10;
   ```
   - If `event_type` is one of `instance.pacing_changed` or `campaign.progress` (ephemeral topics), they will be silently dropped if depth exceeds `OUTBOX_BACKPRESSURE_DEPTH_THRESHOLD` (default 50,000).
   - If `event_type` starts with `message.` or `chat.`, or is `instance.health_changed`, or is a webhook row — these are NEVER dropped, regardless of depth.

5. **Check backpressure threshold:**
   ```bash
   grep -i OUTBOX_BACKPRESSURE_DEPTH_THRESHOLD .env  # or config/system
   ```
   Default is 50,000. If actual depth is above this and the dropped counter is incrementing:
   ```promql
   rate(wp_outbox_dropped_total[1m])  # rows/sec being dropped
   ```

### Cleanup is separate from drain

The relay's **cleanup loop** (independent 1-minute cadence) deletes published rows older than 1 hour:

```sql
DELETE FROM outbox_events
 WHERE published_at IS NOT NULL AND published_at < now() - interval '1 hour'
 LIMIT 5000;  -- per tick
```

If cleanup is slow or backlogged:

- Check for `published_at` index on `outbox_events`.
- Verify no long-running transactions are holding table locks.
- Monitor `pg_stat_user_tables.seq_scan` / `idx_scan` for `outbox_events` — high seq_scan rate suggests a missing index.

---

## Webhook dispatcher: track delivery failures

Use the `webhook_deliveries` table to audit retry activity:

```sql
SELECT
  id,
  endpoint_id,
  status,
  attempt,
  last_error,
  next_attempt_at,
  created_at
FROM webhook_deliveries
WHERE endpoint_id = '<endpoint_id>'
ORDER BY created_at DESC
LIMIT 20;
```

**Status values:**

- `pending` — not yet attempted or scheduled for retry
- `sent` — HTTP 2xx received
- `failed` — terminal status code or max retries exhausted

**Columns:**

- `attempt` — 0-indexed (0 = first attempt, 7 = final attempt before terminal)
- `last_error` — e.g. `'http_500'`, `'http_422'`, `'connection_timeout'`
- `next_attempt_at` — when the dispatcher will next try this delivery (only set if `pending` and will retry)

### Monitor auto-disable events

When an endpoint hits 20 consecutive terminal failures:

1. The dispatcher emits a `webhook.endpoint_disabled` event to the SSE stream (`fanout: ['sse']`).
2. An audit log is created: `action='webhook.endpoint_disabled'`, `targetId=<endpoint_id>`, `metadata={reason:'consecutive_failures'}`.
3. The endpoint row is set `enabled=false`, `disabled_reason='consecutive_failures'`.

Query audit logs:

```sql
SELECT actor_type, action, target_id, metadata, created_at
  FROM audit_logs
 WHERE action = 'webhook.endpoint_disabled'
 ORDER BY created_at DESC
 LIMIT 10;
```

---

## Relay secondary loops

The relay process (`ROLE=relay`) runs three independent loops:

| Loop             | Cadence        | Purpose                                              |
| ---------------- | -------------- | ---------------------------------------------------- |
| **Drain loop**   | 500 ms (fixed) | Claim unpublished `outbox_events`, coalesce, emit    |
| **Cleanup loop** | 1 minute       | Delete published rows older than 1 hour              |
| **Dispatcher**   | ~1 second      | Claim webhook `pending` deliveries, send HTTP, retry |

Each loop runs in its own `setInterval` and logs to the relay role. A wedged loop will not block the others, but will cause specific symptoms:

- **Drain stuck** → `wp_outbox_depth` increases, new events pile up
- **Cleanup stuck** → published rows accumulate, disk usage grows (but old rows are not served)
- **Dispatcher stuck** → webhook deliveries remain `pending`, retry schedule drifts

Check relay logs and restart if needed:

```bash
docker compose logs relay --tail=50
systemctl restart wp-relay
```

---

## Metrics to alert on

See [Alerts](#alerts) above for the full list of alerts, their expressions, and their procedures.

---

## staff-accounts

Staff accounts are WP's own back-office identities (`staff_users`), used to log
into the admin panel at `/admin/v1`. A staff account can READ every workspace on
the platform, so it is created and disabled by an operator with database access -
there is no self-service staff signup and no "create staff user" API endpoint.

### Creating a staff account

```bash
DATABASE_URL=... WP_KEY_RING_PATH=... \
  pnpm exec tsx scripts/ops/create-staff-user.ts \
    --email ops@example.com --name "Ops Person" --role ops
```

Roles nest strictly: `support` (read-only + impersonation grant/revoke) is a
subset of `ops` (adds day-to-day mutations) is a subset of `superadmin` (adds
pricing, wallet adjustments, pacing relax, impersonation elevation).

The script prints the temporary password and the `otpauth://` URL **exactly
once**; neither is stored in plaintext and neither can be recovered. Hand both
over securely, then have the staff member change the password on first login.

Two things must also be true before the account can be used:

1. **TOTP is mandatory.** The script sets `mfa_enabled_at` immediately, so the
   authenticator must be configured from the printed URL. An account with a NULL
   `mfa_enabled_at` is refused with `403 MFA_ENROLL_REQUIRED` - there is no
   password-only staff login anywhere in this system.
2. **The staff member's network must be allow-listed.** `ADMIN_IP_ALLOWED_CIDRS`
   is a comma-separated IPv4 CIDR list, and it **defaults to empty, which means
   nobody can log in**. An empty list is never an implicit allow-all.

### Resetting a lockout

Five consecutive failed logins lock the account; the window doubles per lockout
(15 min, 30, 60, ...) capped at 24 hours. To clear it early:

```sql
UPDATE staff_users
   SET failed_login_count = 0, locked_until = NULL, updated_at = now()
 WHERE email = 'ops@example.com';
```

Confirm the person's identity out of band first - a lockout is usually either
their own typo or somebody else attacking their account, and the two look
identical from the database.

### Disabling a staff account

Disable, do not delete: the account's `staff_audit_log` history must remain
attributable.

```sql
UPDATE staff_users
   SET status = 'disabled', token_epoch = token_epoch + 1, updated_at = now()
 WHERE email = 'ops@example.com';
```

Both statements matter. `status = 'disabled'` stops new logins; the
`token_epoch` bump is what kills every outstanding access token **immediately**
(each request re-reads the epoch, so a mismatch is a 401 on the very next call).
Without the bump, an already-issued token keeps working until it expires. The
same epoch mechanism is what the refresh-token reuse sweep uses.

### Honest limitation: `psql` is not audited

Every read the admin API performs writes an `audit_logs` row
(`action = 'platform.read'`) in the same transaction as the read itself, carrying
the staff id, the registered query key, and the stated reason. **That covers the
admin API only.**

A staff member who has direct `psql` credentials to the production database can
read anything their database role permits, and **v1 records nothing about it** -
there is no pgaudit extension and no statement logging configured. The platform's
read-audit trail is therefore a record of what was done _through the admin panel_,
not a complete record of what was seen.

Two consequences worth being explicit about:

- Direct database credentials should be held by as few people as possible, and
  should not be the normal way staff answer support questions - the admin panel
  exists so that the audited path is also the convenient one.
- If a complete access trail is ever required (a compliance commitment, an
  incident investigation), it needs pgaudit or equivalent enabled at the database
  level. Do not claim coverage the current setup does not provide.
