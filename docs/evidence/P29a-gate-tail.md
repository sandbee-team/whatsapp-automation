# P29a gate evidence (launch-hardening-and-drills)

INTERNAL - test evidence for the launch checklist rows that name it; no figure here is quotable.

This file is written by the main session during the P29a close. Every block below is a verbatim tail
pasted from the run that produced it (core invariant 7: tests are evidence). Section 1 is the
per-unit evidence collected while the phase was built; section 2 is the ONE full-gate run at C5.

## 1. Per-unit evidence (2026-09-08)

### U2 - key-ring restore drill (`infra/backup/__tests__/keyring-restore.test.ts` + `scripts/guards/meta.test.ts`)

```
 RUN  v4.1.11 D:/kd/wp

 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  23:31:23
   Duration  2.69s
```

Real drill run (`pnpm run drill:keyring`), no key material in the output:

```
provisioned a production-shaped key ring in the scratch directory
wrote the founder's offline encrypted copy and the sealed second offline copy
sealed a credential-shaped record under the active session key
destroyed the running copy and proved it can no longer be loaded
restored the ring from the offline copy and reopened the sealed record
verdict: PASS
phases: {"provisionMs":1,"sealMs":4,"destroyMs":1,"restoreMs":33,"verifyMs":0,"totalMs":39}
```

### U4a - migration 0075 (`consent_tos_version`), db suite on `wp_test2`, onboarding integration

```
Test Files  57 passed (57)
     Tests  249 passed (249)
  Duration  46.92s
```

```
Test Files  2 passed (2)
     Tests  7 passed (7)
  Duration  8.39s
```

`SELECT max(version) FROM schema_migrations` = 75 on both `wp` and `wp_test2`.

### U4b - consent step six statements + ToS §12 (`website/tests/legal.test.ts`, `packages/domain/tests/copy/onboarding-copy.test.ts`, `app/frontend/src/features/onboarding/**`)

```
 Test Files  6 passed (6)
      Tests  28 passed (28)
   Start at  23:39:25
   Duration  5.75s (transform 4.05s, setup 111ms, import 16.05s, tests 1.02s, environment 3.86s)
```

```
check-copy: 2670 files scanned, 0 violations
```

### E3 - full unit suite (`pnpm run test:unit`, 2026-09-09, after the C1 fix round)

```
 Test Files  549 passed (549)
      Tests  3468 passed (3468)
UNIT_EXIT:0
```

### Real-tree scanner runs (2026-09-09)

```
secret-scan: clean, 0 findings.
SECRET_EXIT:0 SECS:9
```

Semgrep bind-mount baseline `SEMGREP_EXIT:1 SECS:1228` (one finding, since fixed: a test-support
`Math.random` matched the security-path rule); after the tar-stream change the same 2,048-file scan
reports `semgrep: clean, 0 findings.` with `EXIT:0 SECS:5`. Trivy: 0 findings, ~7.8 s with a warm DB cache.

### Third real restore drill (2026-09-09, seeded claimable row, deleted afterwards)

```
RESTORE-DRILL: PASS mode=basebackup rto=94371 rpo=0 report=docs/measurements/2026-09-08-restore-drill.json
DELETE 1
```

## 2. Full gate (C5) - `powershell -File scripts/gate.ps1` (2026-09-09, `DATABASE_URL` -> `wp_test2`)

Attempt 5 of the day is the ONE gate run for this phase (attempts 1-4 stopped on: prettier on one new test
file; a stray empty `.tmp-review/` directory; a REAL trivy HIGH in `nodemailer` 9.0.5 that the new step
exists to catch - fixed by bumping to 9.1.1; a deliberate stop to widen semgrep coverage after review).

Ordered steps executed (every one green until `integration`):

```
format -> lint -> depcruise -> domain-browser-build -> guard-meta-assertion -> tenant-scope -> single-reserve
-> single-debit -> send-origin -> copy -> no-raw-hex -> ui-client-directive -> serialisation-boundary
-> shutdown-purity -> placement-neutrality -> box-memory -> capacity-gate -> no-direct-publish
-> no-insecure-tls -> health-writers -> scheduler-queries -> forbidden-mechanisms -> no-bulk-lookup
-> metric-inventory -> metric-manifest -> dashboards -> alert-rules -> semgrep -> trivy -> secret-scan
-> typecheck -> unit -> integration
```

Guard and scanner summary lines from the same run:

```
guard check-tenant-scope: 2059 files matched
guard check-copy: 2706 files matched
guard security:semgrep: 2385 files matched
guard security:trivy: 2 files matched
guard security:secret-scan: 2429 files matched
registry: 38 guards registered
tenant-scope: 1200 files scanned, 0 violations
check-copy: 2706 files scanned, 0 violations
semgrep: clean, 0 findings.
trivy: clean, 0 findings.
secret-scan: clean, 0 findings.
```

Unit and integration summaries from the same run (db project, then app-backend project):

```
--- CI step: unit (pnpm run test:unit) ---
 Test Files  549 passed (549)
      Tests  3468 passed (3468)
--- CI step: integration (pnpm run test:int) ---
 Test Files  57 passed (57)
      Tests  249 passed (249)
 Test Files  6 failed | 597 passed (603)
      Tests  10 failed | 2172 passed (2182)
   Start at  13:56:54
   Duration  994.05s (transform 9.96s, setup 2.22s, import 297.52s, tests 603.97s, environment 56ms)
CI FAILED at step integration
EXITCODE:1
```

The six failing integration files are exactly the P26 fleet-scale suites whose disposition is a standing
founder decision (`.memory/progress/master-plan.md`, same six as the P28 and P29-session-1 gates); nothing
this phase touched is among them:

```
 FAIL  src/engine/measure/scale-fleet.integration.test.ts
 FAIL  test/integration/chaos/redis-flush.integration.test.ts
 FAIL  test/integration/chaos/rolling-deploy.integration.test.ts
 FAIL  test/integration/chaos/rolling-deploy-wave.integration.test.ts
 FAIL  test/integration/chaos/worker-kill.integration.test.ts
 FAIL  test/integration/scale/pacing-run.integration.test.ts
```

Because the `integration` step is the chain `db && app-backend && admin-backend`, the admin-backend
integration project and the three steps after `integration` (`build`, `website-build`, `website-lcp`)
did not run inside the gate; they were run standalone immediately afterwards - section 3.

## 3. Post-integration steps run standalone (same tree, same day, `DATABASE_URL` -> `wp_test2`)

```
== admin-backend test:int ==
 Test Files  15 passed (15)
      Tests  73 passed (73)
ADMIN_INT_EXIT:0
== build ==
BUILD_EXIT:0
== website-build ==
WEBSITE_BUILD_EXIT:0
== website-lcp ==
 Test Files  1 passed (1)
      Tests  6 passed (6)
WEBSITE_LCP_EXIT:0
```

The LCP run regenerates `docs/evidence/P29-lcp-india4g.md` (verdict PASS, per-route figures there; compressed
transfer, India-4G profile). Net gate state for P29a: every step green except the `integration` step's six
P26 fleet-scale suites, which remain the named founder decision - not a silent skip.
