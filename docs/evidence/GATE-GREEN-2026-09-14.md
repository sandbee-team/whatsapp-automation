# Full gate GREEN — 2026-09-14 21:09

The first fully green gate of the day, and the one that certifies the four critical fixes plus the
deployment work. Run via the only sanctioned entrypoint, `powershell -File scripts/gate.ps1`.

```
CI GREEN — all 37 steps passed

EXITCODE:0
```

## Suites

| Suite                     |    Files |    Tests |
| ------------------------- | -------: | -------: |
| unit                      |      573 |     3593 |
| `@wp/db` integration      |       61 |      274 |
| app-backend integration   |      625 |     2281 |
| admin-backend integration |       15 |       73 |
| website LCP               |        1 |        6 |
| **total**                 | **1275** | **6227** |

All 37 steps ran, including format, lint, dependency-cruiser, the ~20 repo guards, all three pinned
security scanners (semgrep, trivy, gitleaks), typecheck, and every test project.

## What this run certifies

Four confirmed-critical defects fixed earlier the same day, each with a test that would have caught it:

| #   | Defect                                                                 | Fix                                                                     |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A1  | Bare-pool writes rejected under the real `wp_app`/`wp_scheduler` roles | `sqlFor`/`ctxFor` deleted; `withInstanceCtx` + `buildPerQueryTenantSql` |
| A3  | A send timeout retried as `transient` — guaranteed double-send         | resolves as `unknown` → PAUSE_INSTANCE                                  |
| A6  | `delivery_events` out of partitions ~21 days after deploy              | `ROLE=migrate` calls `ensureAllPartitions` with `periodsAhead: 6`       |
| —   | Hourly funnel sweep starved by an unbounded terminal backlog           | open-status campaigns ranked first in `broadcast-funnel-pending.sql`    |

Plus the deployment work: the production image (all five roles + admin API verified booting), the two
compose/env files, the `.gitignore` pass, and the gate's own database-isolation fix.

## The isolation fix this run depended on

The gate log opens with:

```
gate: DATABASE_URL -> wp_test2 (derived from .secrets/dev.env; value not echoed)
```

Before 2026-09-14 nothing set that variable, so the suite silently ran against the DEV database `wp`
(1,195 clients / 2,105 instances / 2,136 outbox rows) and produced 19 failures that were not code defects.
`scripts/gate.ps1` now derives the test URL itself. See
`.memory/lessons/2026-09-14-the-gate-ran-against-the-dev-database.md`.

## Still open

This gate proves the code is correct and internally consistent. It does NOT close the remaining review
findings, which are operational or unfixed: A4/A5 (drain gaps), A7 (backups wired to nothing), A8 (published
retention table enforced by one job of eight), A9 (media route has no entitlement gate or rate limit), and
the HIGH list in `docs/evidence/DEEP-REVIEW-2026-09-14.md`.

There is still no health endpoint, so the production compose declares no healthcheck for the application
services.
