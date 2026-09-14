# V1 release gate - checklist walk and gate confirmations (2026-09-11)

INTERNAL - release-gate evidence; no figure here is quotable (ADR 0016, ADR 0018 §8).

This file is written by the main session of the v1 release-gate session (started 2026-09-09, resumed
2026-09-11 after an account rate-limit pause). Every block marked "verbatim" is pasted from the run that
produced it (core invariant 7). Sections marked PENDING are appended before the session closes.

## 1. Checklist walk - one row at a time

Rule applied: a DONE row must name at least one artefact that exists on disk, in `docs/evidence/` (or
`docs/capacity/` for Gates A and B); otherwise it is NOT DONE with the blocking fact and the owner.
Generated from `docs/LAUNCH-CHECKLIST.md` after this session's edits (rows 1, 2 flipped to NOT DONE;
rows 10, 11, 12, 15, 16, 22 now name this file; row 14 names the LCP artefact):

| #   | Status   | Artefacts named | Exist on disk | In docs/evidence or docs/capacity |
| --- | -------- | --------------- | ------------- | --------------------------------- |
| 1   | NOT DONE | —               | n/a           | n/a                               |
| 2   | NOT DONE | —               | n/a           | n/a                               |
| 3   | NOT DONE | —               | n/a           | n/a                               |
| 4   | DONE     | 2               | yes (2/2)     | yes                               |
| 5   | DONE     | 2               | yes (2/2)     | yes                               |
| 6   | DONE     | 4               | yes (4/4)     | yes                               |
| 7   | DONE     | 5               | yes (5/5)     | yes                               |
| 8   | DONE     | 4               | yes (4/4)     | yes                               |
| 9   | DONE     | 7               | yes (7/7)     | yes                               |
| 10  | DONE     | 2               | yes (2/2)     | yes                               |
| 11  | DONE     | 3               | yes (3/3)     | yes                               |
| 12  | DONE     | 3               | yes (3/3)     | yes                               |
| 13  | DONE     | 1               | yes (1/1)     | yes                               |
| 14  | DONE     | 2               | yes (2/2)     | yes                               |
| 15  | DONE     | 2               | yes (2/2)     | yes                               |
| 16  | DONE     | 5               | yes (5/5)     | yes                               |
| 17  | NOT DONE | —               | n/a           | n/a                               |
| 18  | NOT DONE | —               | n/a           | n/a                               |
| 19  | NOT DONE | —               | n/a           | n/a                               |
| 20  | NOT DONE | —               | n/a           | n/a                               |
| 21  | NOT DONE | —               | n/a           | n/a                               |
| 22  | DONE     | 4               | yes (4/4)     | yes                               |
| 23  | NOT DONE | —               | n/a           | n/a                               |
| 24  | NOT DONE | —               | n/a           | n/a                               |
| 25  | NOT DONE | —               | n/a           | n/a                               |
| 26  | NOT DONE | —               | n/a           | n/a                               |
| 27  | NOT DONE | —               | n/a           | n/a                               |
| 28  | NOT DONE | —               | n/a           | n/a                               |
| 29  | DONE     | 1               | yes (1/1)     | yes                               |
| 30  | NOT DONE | —               | n/a           | n/a                               |
| 31  | NOT DONE | —               | n/a           | n/a                               |

### NOT DONE rows, verbatim (gate | status | evidence | notes)

- [1] Gate A - session cost measured | NOT DONE | — | Gate A OPEN (walk 2026-09-11, `docs/evidence/V1-RELEASE-GATE-2026-09-11.md` §Gate A). Component A measured at P10 (socket-resident slope, `docs/capacity/session-cost.md`, banner `Gate A OPEN (closes at P10a)`); component B (real Signal/group state) unmeasured - needs ≥3 real linked test numbers (founder open item 6; ADR 0045 proposed) → P10a. Not a go-live gate (founder 2026-09-07); blocks every capacity figure. Owner: founder (numbers), then the P10a session
- [2] Gate B - fleet capacity measured | NOT DONE | — | Gate B OPEN (walk 2026-09-11, `docs/evidence/V1-RELEASE-GATE-2026-09-11.md` §Gate B). Measured to N=1,000 synthetic instances on 2026-09-07 (`docs/capacity/fleet-capacity.md`, banner `DRIFT VERDICT PENDING — P26a`); the 7-day drift run died at 32 h (container `wp-p26-drift` exited 2026-09-08 on a Docker restart) → `drift-run-cli --verdict` = insufficient-data, span 1.33 days; the 60-minute pacing artifact verifies FAIL (`reserve()` p99 35 ms ≥ 25 ms SLO; harness double-count). Not a go-live gate (founder 2026-09-07); blocks every capacity figure. Owner: P26a re-run on isolated infra, P27 re-measure
- [3] Gate C - ten-thousand-connected measurement | NOT DONE | — | structural target only; no public claim permitted until `docs/evidence/` Gate C artefact exists
- [17] Retention enforcement for the published retention table and the privacy notice's lead retention | NOT DONE | — | only partial jobs exist (`modules/contacts/retention-purge.ts` for import artefacts, `modules/events/cleanup.ts`, `modules/pacing/health/retention.ts`); no partition DETACH/DROP job for message jobs, send attempts, delivery events or webhook deliveries, and no lead purge - ship them or soften the published sentences before the first paying tenant
- [18] Backups running with a verified schedule (pgBackRest full weekly + incremental daily + WAL archive) | NOT DONE | — | production host not provisioned; config at `infra/backup/pgbackrest.conf.example`, schedule at `infra/backup/backup-cron.md`
- [19] Alerting reachable (Alertmanager route to a human) | NOT DONE | — | production observability host not provisioned; rules under `infra/observability/`
- [20] pgBackRest PITR restore rehearsed on the production host | NOT DONE | — | row 4 measured the dev-box basebackup path; re-time before the first paying tenant
- [21] Production edge serves `website/out` compressed and terminates TLS | NOT DONE | — | verify with a compressed-transfer check at cut-over; curl command in `infra/nginx/README.md`
- [23] Key ring provisioned in exactly three places on the production host (host secret store, founder's offline encrypted copy, sealed second offline copy) | NOT DONE | — | procedure proven by row 5; founder to provision before launch
- [24] Production pool role check (wp_app grants, migrations 0072/0073 class) | NOT DONE | — | dev/test connect as owner and mask grant defects; verify `wp_app` on production before launch
- [25] Admin API deployment env: `ADMIN_IP_ALLOWED_CIDRS` non-empty, `INTERNAL_API_ENABLED=true`, `INTERNAL_API_ALLOWED_CIDRS` set, `ADMIN_TRUST_PROXY=true` behind a proxy that overwrites `X-Forwarded-For` | NOT DONE | — | `X-Forwarded-For` rule critical for lead per-IP limiter (see `infra/nginx/README.md`)
- [26] At least one staff account created | NOT DONE | — | founder action; signup blocked until row 26 is done
- [27] Leads endpoint production env: `LEADS_IP_HASH_SECRET`, `LEADS_ALLOWED_ORIGINS` set on admin-api; `NEXT_PUBLIC_LEADS_ENDPOINT` set at website build time | NOT DONE | — | enable inbound lead capture and webhook feed before first broadcast
- [28] Lead-flow alerting metric (`wp_admin_leads_outcomes_total{outcome}`) | NOT DONE | — | optional; founder decision on observability depth
- [30] Founder decisions still open: real per-message prices / signup credit / low-balance threshold (ADR 0044 proposed), test-numbers budget (ADR 0045 proposed); the six fleet-scale suites are NO LONGER a founder decision (ADR 0047: PgBouncer routing bug + drain in-flight stub, both fixed 2026-09-11) | NOT DONE | — | answer forms written 2026-09-11 (`.memory/research/2026-09-11-founder-open-items-status-and-recommendations.md`); Q1, Q6 and Q10 (retention reconciliation) must be answered before the first paying tenant; owner: founder
- [31] Production graceful drain tracks in-flight sends: `roles/session-worker.ts` still wires `buildEmptyInFlightPort()` and a no-op `markNeedsReconcile` (found 2026-09-11 while fixing the fleet-scale harness, ADR 0047 (d)) | NOT DONE | — | on every rolling deploy a claim caught mid-drain is abandoned as `processing` for ~120 s (claim expiry + reaper grace) before the reaper marks it `needs_reconcile`; no job is lost (invariant 5) but the deploy is not graceful for in-flight sends; fix = wire the DB-derived in-flight port the harness now uses (`engine/measure/scale-fleet-inflight.ts`) into the production role + a drain test; owner: next engine-touching session, before the first rolling deploy with tenant traffic

## 2. Gate confirmations, in writing

### Gate A (session cost) - OPEN, not closed

`docs/capacity/session-cost.md` exists; its banner (verbatim):

```
SOCKET-RESIDENT-PRE-HANDSHAKE (component A, ADR 0032) · SOCKET-ONLY (component B deferred to P10a — no real Signal/group state measured) · EXTRAPOLATED (injected rows, P10a) · Gate A OPEN (closes at P10a) · Gate B (P26) still open — no number here may be quoted to a customer (ADR 0016, ADR 0018 §8)
```

Component A (socket-resident RSS slope) is MEASURED (P10, 2026-09-01). Component B (real Signal/group
state) is NOT measured: it needs ≥ 3 real linked test numbers (founder open item 6) and closes at P10a.
The capacity-gate guard on the tree as found (verbatim):

```
> tsx scripts/check-capacity-gate.ts
check-capacity-gate: 378 file(s) scanned, 0 violations
CAP_EXIT:0
```

### Gate B (fleet capacity) - OPEN, not closed

`docs/capacity/fleet-capacity.md` exists; its banner (verbatim):

```
DRIFT VERDICT PENDING — P26a
```

Measured N = 1,000 synthetic instances (2026-09-07). The 7-day drift run did not survive: the container
`wp-p26-drift` is `Exited (255)` since 2026-09-08 (Docker daemon restart); the artifact holds 33 hourly
samples (hours 0-32, `resident=1000/1000`, `degraded=false` throughout). Verdict computed by the tool,
never typed (verbatim; exit code 3 = insufficient-data):

```
verdict: insufficient-data
  span: 1.333 days
  sample count: 33
  reason: span 1.33 days is below the required minimum of 6 days
  excluded degraded rows: 0
  marks (if any) are informational annotations only - never excluded rows
```

(The CLI's Windows main-guard bug that made it print nothing was fixed this session -
`scripts/measure/drift-run-cli.ts`, same idiom as `pacing-run-verify.ts`.)

The 60-minute pacing artifact re-verified with the real tool (verbatim; FAIL stands as measured):

```
pacing-run [FAIL] captured 2026-09-07T13:59:25.194Z
  run: 1000 instances / 10 workers / 3 tenants, planned 3600s, measured 3666.695s (drive window; fleet stand-up 258.442s)
  connection: THROUGH-PGBOUNCER (poolMode=transaction)
  reserve() latency: samples=7234 p50=6ms p95=9ms p99=35ms max=166ms (SLO 25ms)
  cap violations: 0
  jobs: enqueued=106540 sent=6417 queued=100123 failed=0 blocked=0 cancelled=0 duplicateAckedAttempts=undefined
  burst: 100000 recipients at 1800000ms (run-relative) - other-tenant claim p99 before=12ms (3586 samples) during=6ms (3721 samples) fairness=OK (ratio 0.5000)
  orphan reservations: NOT MEASURABLE - wp_pacing_orphan_reservations_total does not exist in v1 (P25, RUNBOOK.md#deferred-alerts)
  notes:
    - eff_daily_cap set to 25 by UPDATE on the fleet's own assigned instances (derived from the heaviest tenant class's 600 sends/day over this run's 60-minute duration) - sized so the run genuinely approaches the cap, never a vacuous "nothing to check" result.
    - reaper/reconciler sweeps ran on production cadence during the drive window: reaperRepairs=0, reconcilerResolved=0, reconcilerBlocked=0.
  problems:
    - reserveLatency.p99Ms (35) >= SLO 25ms
    - job conservation broken: driverEnqueued (206540) != sent+stillQueued+terminalFailed+blockedNeedsReview+cancelled (106540)
--verify docs/measurements/2026-09-07-pacing-60m.json: FAIL
  FAIL: reserveLatency.p99Ms (35) >= SLO 25ms
  FAIL: job conservation broken: driverEnqueued (206540) != sent+stillQueued+terminalFailed+blockedNeedsReview+cancelled (106540)
PV_EXIT:1
```

Consequence: no capacity figure may be quoted anywhere; P26a needs a fresh drift run on isolated
infrastructure (≥ 6 days) and P27 owns the `reserve()` p99 re-measure. Founder decision 2026-09-07:
neither is a go-live gate.

### Gate C (ten-thousand-connected) - NOT CLOSED

No `docs/evidence/*gate-c*` artefact exists (found: none).
No ten-thousand claim may be published; `docs/__tests__/launch-checklist.test.ts` enforces this on every
unit run and `check-copy` clause (e) enforces it on every public surface.

### Timed Postgres restore drill - DONE

`docs/evidence/P29-restore-drill.md` + `docs/measurements/2026-09-08-restore-drill.json` exist (drill of
2026-09-09: basebackup scratch-container mode, RTO 94,371 ms, RPO 0 s, 102 tables parity, ledger chain
0 breaks, verdict PASS). Not re-timed this session (rule: re-time at every 3x growth in connected numbers).

### Timed key-ring restore drill - DONE

`docs/evidence/P29-keyring-restore-drill.md` + `docs/runbooks/key-ring-restore.md` exist (drill of
2026-09-08: destroy-then-restore from the offline copy, byte-identical plaintext, 39 ms, PASS; next due
2026-12-08).

### Three security scans clean - DONE (re-confirmed by the gate run in §4)

`docs/evidence/P29-security-scans.md` exists. The P29a gate (2026-09-09) reported, verbatim:
`semgrep: clean, 0 findings.` / `trivy: clean, 0 findings.` / `secret-scan: clean, 0 findings.`
The re-run of this session is in §4.

### Copy suite green including Hindi - DONE

`scripts/check-copy.ts` scans `packages/i18n/src/catalogues/` (line 65) and names `hi.ts` explicitly
(line 117); `hi.ts` composes `hiOnboarding` (line 281). Guard on the tree as found (verbatim):

```
> tsx scripts/check-copy.ts
check-copy: 2706 files scanned, 0 violations
```

### Full mandatory suite green - see §4 (the verbatim gate tail)

## 3. Row-level evidence produced this session

Unit suites named by rows 11, 12, 16 and the checklist's own tests, one vitest run (verbatim):

```
pnpm vitest run scripts/guards/check-copy.test.ts scripts/guards/check-forbidden-mechanisms.test.ts website/tests/legal.test.ts packages/domain/tests/copy/onboarding-copy.test.ts docs/__tests__/launch-checklist.test.ts docs/__tests__/launch-checklist-parser-edge.test.ts
 Test Files  6 passed (6)
      Tests  45 passed (45)
   Start at  22:57:04
   Duration  2.79s (transform 1.97s, setup 103ms, import 4.79s, tests 1.26s, environment 1ms)
```

Row 11 - `no_forbidden_mechanism_exists` guard on the tree as found (verbatim):

```
> tsx scripts/check-forbidden-mechanisms.ts
check-forbidden-mechanisms: 2571 files scanned, 0 violations
```

Row 15 - pricing page mode: `website/src/content/copy/pricing.ts` header comment reads "contact-us is the
only pricing mode this release ships: no price table, no capacity number, no currency figure anywhere";
`intro: 'Prices are shared on request.'`, CTA `Contact us` → `/contact/`. `check-copy` above: 0 violations.

Row 22 - runbooks present (verbatim `wc -l`; `docs/RUNBOOK.md` has 48 `##` sections):

```
 1009 docs/RUNBOOK.md
   69 docs/runbooks/key-ring-restore.md
  105 docs/runbooks/restore-from-backup.md
 1183 total
```

Row 10 - the log-grep PII integration test runs inside the gate's `integration` step (§4).

## 4. The six fleet-scale suites and the full gate

Standalone run of 2026-09-09 (`DATABASE_URL` → `wp_test2`; the `pnpm run test:int -- <files>` form
ignored the file filter and ran the whole app-backend integration project), verbatim tail:

```
 Test Files  6 failed | 597 passed (603)
      Tests  10 failed | 2172 passed (2182)
   Duration  1017.35s (transform 13.72s, setup 2.09s, import 292.18s, tests 638.92s, environment 48ms)
```

The ten failures are exactly the P26 fleet-scale suites (scale-fleet, redis-flush, rolling-deploy,
rolling-deploy-wave, worker-kill, pacing-run). The standing attribution to the live drift fleet is
DISPROVEN by this run (the drift container had exited the day before). Root cause and fix (two debugger dispatches, 2026-09-11; ADR 0047): (1) `resolvePgBouncerDatabaseUrl()`
substituted only PgBouncer's port, and PgBouncer maps `wp` only, so every harness child process got
`no such database: wp_test2` and never acquired a lease - fixed with a database-name check + `db-url.test.ts`;
(2) the fleet child's graceful drain used an always-empty in-flight port and a no-op `markNeedsReconcile`,
abandoning claims caught mid-drain as `processing` for ~120 s - fixed with `scale-fleet-inflight.ts`. The six
files then passed together twice (`Test Files 6 passed (6)`, `Tests 16 passed (16)`, 358 s / 356 s). The
production session-worker role carries the same drain stubs - launch-checklist row 31, NOT DONE.

Full gate (`powershell -File scripts/gate.ps1`, `DATABASE_URL` → `wp_test2`, 2026-09-11) - the ONE gate run of this
session. Verbatim tail as printed by the wrapper:

```
steps run (36): format -> lint -> depcruise -> domain-browser-build -> guard-meta-assertion -> tenant-scope -> single-reserve -> single-debit -> send-origin -> copy -> no-raw-hex -> ui-client-directive -> serialisation-boundary -> shutdown-purity -> placement-neutrality -> box-memory -> capacity-gate -> no-direct-publish -> no-insecure-tls -> health-writers -> scheduler-queries -> forbidden-mechanisms -> no-bulk-lookup -> metric-inventory -> metric-manifest -> dashboards -> alert-rules -> semgrep -> trivy -> secret-scan -> typecheck -> unit -> integration -> build -> website-build -> website-lcp

key summary lines, verbatim and in order:
registry: 38 guards registered
--- CI step: tenant-scope (pnpm run check:tenant-scope) ---
tenant-scope: 1201 files scanned, 0 violations
sql-lint: 191 files scanned, 0 violations
role-boot: 13 files scanned, 0 violations
single-claim: 2426 files scanned, 0 violations
check-no-auto-requeue: 1431 files scanned, 0 violations
single-reserve: 2426 files scanned, 0 violations
single-debit: 2267 files scanned, 0 violations
--- CI step: copy (pnpm run check:copy) ---
check-copy: 2709 files scanned, 0 violations
check-no-raw-hex: 1672 files scanned, 0 violations
check-ui-client-directive: 57 files scanned, 0 violations
serialisation-boundary: 905 files scanned, 0 violations
shutdown-purity: 1169 files scanned, 0 violations
placement-neutrality: 1169 files scanned, 0 violations
--- CI step: capacity-gate (pnpm run check:capacity-gate) ---
check-no-direct-publish: 1390 files scanned, 0 violations
check-no-insecure-tls: 2368 files scanned, 0 violations
check-health-writers: 2426 files scanned, 0 violations
--- CI step: forbidden-mechanisms (pnpm run check:forbidden-mechanisms) ---
check-forbidden-mechanisms: 2573 files scanned, 0 violations
check-no-bulk-lookup: 1934 files scanned, 0 violations
--- CI step: semgrep (pnpm run check:semgrep) ---
semgrep: clean, 0 findings.
--- CI step: trivy (pnpm run check:trivy) ---
trivy: clean, 0 findings.
--- CI step: secret-scan (pnpm run check:secret-scan) ---
secret-scan: clean, 0 findings.
--- CI step: typecheck (pnpm run typecheck) ---
--- CI step: unit (pnpm run test:unit) ---
 Test Files  550 passed (550)
      Tests  3472 passed (3472)
   Duration  120.92s (transform 39.37s, setup 5.98s, import 471.74s, tests 254.48s, environment 341.33s)
--- CI step: integration (pnpm run test:int) ---
 Test Files  57 passed (57)
      Tests  249 passed (249)
   Duration  44.04s (transform 1.20s, setup 236ms, import 7.37s, tests 28.82s, environment 4ms)
 Test Files  604 passed (604)
      Tests  2186 passed (2186)
   Duration  1073.30s (transform 9.59s, setup 2.23s, import 295.22s, tests 686.69s, environment 55ms)
 Test Files  15 passed (15)
      Tests  73 passed (73)
   Duration  12.98s (transform 970ms, setup 88ms, import 6.69s, tests 4.03s, environment 1ms)
--- CI step: build (pnpm run build) ---
--- CI step: website-build (pnpm -F website run build) ---
--- CI step: website-lcp (pnpm -F website run test:perf) ---
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  37.98s (transform 82ms, setup 28ms, import 102ms, tests 37.70s, environment 0ms)
CI GREEN — all 36 steps passed

last 60 lines of the log:
> website@0.0.0 build D:\kd\wp\website
> next build --webpack

▲ Next.js 16.3.4 (webpack)
✓ Running next.config.mjs took 26ms

  Creating an optimized production build ...
✓ Compiled successfully in 3.8s
  Running TypeScript ...
  Finished TypeScript in 6.7s ...
  Collecting page data using 11 workers ...
  Generating static pages using 11 workers (0/19) ...
  Generating static pages using 11 workers (4/19)
  Generating static pages using 11 workers (9/19)
  Generating static pages using 11 workers (14/19)
✓ Generating static pages using 11 workers (19/19) in 812ms
  Finalizing page optimization ...
  Collecting build traces ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ○ /blog
├   /blog/[slug]
│ └ ● /blog/why-we-do-not-promise-deliverability
├ ○ /contact
├ ○ /docs
├   /docs/[...slug]
│ ├ ● /docs/how-sending-is-paced
│ ├ ● /docs/hi/safe-mode
│ ├ ● /docs/what-safe-mode-does-and-does-not-do
│ └ ● [+4 more paths]
├ ○ /features
├ ○ /legal/dpa
├ ○ /legal/privacy
├ ○ /legal/terms
└ ○ /pricing


○  (Static)  prerendered as static content
●  (SSG)     prerendered as static HTML (uses generateStaticParams)


--- CI step: website-lcp (pnpm -F website run test:perf) ---

> website@0.0.0 test:perf D:\kd\wp\website
> vitest run --config vitest.perf.config.ts


 RUN  v4.1.11 D:/kd/wp/website


 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  12:30:44
   Duration  37.98s (transform 82ms, setup 28ms, import 102ms, tests 37.70s, environment 0ms)


CI GREEN — all 36 steps passed

gate: running full CI gate -> C:\Users\KARTIK~1.DES\AppData\Local\Temp\claude\d--kd-wp\9b8e1f77-5004-4fe0-9d2f-4a983c3f0507\scratchpad\gate-2026-09-11.log
EXITCODE:0
```
