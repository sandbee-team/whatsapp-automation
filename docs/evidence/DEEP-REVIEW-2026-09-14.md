# Deep review - 2026-09-14

INTERNAL. Adversarial review of the whole product ahead of the first real deployment, run at the founder's
request ("a to z all thing proper accurate working manage karna hai").

**Method.** Six independent reviewers (money correctness, tenant isolation, auth/API security, the new
deployment, queue durability, operational gaps). Every finding they raised was then handed to a separate
agent instructed to **refute** it, with an explicit instruction to look for the layer that already makes it
safe (a zod contract, a route policy, a DB constraint, an upstream caller). Only findings that survived that
pass are listed here. 48 agents, 40 verification verdicts, **24 confirmed**, 16 refuted.

Nothing below is a style opinion. Each entry was checked against the code, and several were reproduced
against the live dev Postgres.

---

## A. Confirmed CRITICAL - production correctness

> **A1, A3 and A6 were fixed on 2026-09-14**, each with a test that would have caught it. Details and the
> rules they produced: `.memory/lessons/2026-09-14-three-critical-go-live-fixes.md`.
>
> | #   | Fix                                                                                                                                                                                                                                                                        | Test that now pins it                                                                                                                                |
> | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
> | A1  | `sqlFor`/`ctxFor` DELETED (not just patched) and replaced by `withInstanceCtx`; the session worker uses `buildPerQueryTenantSql`. Also caught a second defect: `POST /v1/instances` read its plan limits on the bare pool, so every create would have 403'd in production. | `instances-rls-negative-control.integration.test.ts` - executes as the real `wp_app` role with the GUC deliberately omitted, plus a positive control |
> | A3  | one word: `'transient'` → `'unknown'`, which maps to the non-overridable `PAUSE_INSTANCE`                                                                                                                                                                                  | `send-loop.test.ts` - the OLD test asserted the buggy value and was rewritten                                                                        |
> | A6  | `ROLE=migrate` now calls `ensureAllPartitions` with `periodsAhead: 6`. It cannot live in `cron`: EXECUTE on both partition functions is owner-only, verified under `SET LOCAL ROLE wp_scheduler`                                                                           | `db/tests/partition-runway.test.ts` - asserts runway in DAYS; proven loud by reverting to the old default                                            |
>
> A2 is resolved as a consequence of A1's test. A4, A5, A7, A8 and A9 remain OPEN.

### A1. Writes on a bare pool are rejected by FORCE RLS under the real production roles — **FIXED 2026-09-14**

The single most serious finding, and the **fourth recurrence** of a bug class this repo already has three
lessons about.

- `app/backend/src/modules/instances/instances.routes-support.ts:92` - `sqlFor()` returns a bare `pg.Pool`
  cast to `TenantQueryable`. Four `insertAuditLog(sqlFor(deps), ...)` call sites in `instances.routes.ts`
  (link :135, link/refresh :173, online :254, park :285) write `audit_logs`, which is ENABLE + FORCE RLS with
  `WITH CHECK (client_id = current_setting('app.client_id'))`.
- `app/backend/src/engine/session/session-worker-runner-factory.ts:147` - the same shape for the session
  worker's audit and notification writes, under `wp_scheduler`.

**Reproduced live** against the dev Postgres:

```
BEGIN; SET LOCAL ROLE wp_app; INSERT INTO audit_logs (...) VALUES (...);
  -> ERROR: new row violates row-level security policy for table "audit_logs"
-- the identical INSERT, prefixed with set_config('app.client_id', <uuid>, true):
  -> INSERT 0 1
```

`pg_roles` confirms `wp_app` has `rolbypassrls = f` while the dev/test superuser `wp` has `t`. **That is why
every existing test passes.** The verifier additionally found the blast radius is wider than reported:
`ctxFor()` uses the same bare pool, so `loadOwnedOrNotFound`, `readPlanLimits` and `readLinkStatus` return
**zero rows** under `wp_app` - park/online/link would 404 a legitimately-owned instance before ever reaching
the audit insert.

The doc comment at `instances.routes-support.ts:86-90` asserts the opposite ("no per-request GUC transaction
is needed"). That is true of a `USING` predicate (fails soft, returns nothing) and false of a `WITH CHECK`
predicate (fails hard, SQLSTATE 42501). The same rationale is copied into
`app/backend/src/modules/messages/messages.routes-support.ts:126-128` and needs the same audit.

Guards cannot see it: `audit_logs` is deliberately in `ISOLATION_NON_TENANT_TABLES`
(`db/src/isolation/tenant-tables.ts:184`) because `client_id` is nullable, so `check-tenant-scope.ts` never
scans it.

### A2. The test that exists to prove A1 is safe models an executor production never uses

`app/backend/src/modules/instances/instance-transitions.wp-app-role.integration.test.ts:53` - its
`ctxAsWpApp` harness runs `SET LOCAL ROLE wp_app` **and** `set_config('app.client_id', ...)` before every
statement (lines 62-69). Production passes a bare pool that never calls `set_config`. The test therefore
proves only that the GRANTs suffice, and structurally cannot observe A1.

A negative control - run `insertAuditLog` on a `wp_app` connection with **no** GUC and assert SQLSTATE 42501 -
turns A1 into a red test.

### A3. A send timeout is retried as `transient` - a guaranteed double-send — **FIXED 2026-09-14**

`app/backend/src/engine/queue/send-loop.ts:234` converts `outcome === 'timed_out'` into
`new TransportSendError('transient', 'send timed out')`. `RETRY_CLASS_BY_CATEGORY`
(`packages/domain/src/retry/classify.ts:59`) maps `transient` to `RETRY_BACKOFF`, so `result.ts` requeues the
job.

A timeout means the provider outcome is **unknown**: the message may well have been delivered. The domain
layer already has the correct category - `unknown -> PAUSE_INSTANCE`, documented as non-overridable "by
design (core invariant 2, fail-safe)".

`dispatch.ts:45-47` states the intended contract verbatim: _"A send timeout is `dispatched`/unknown, never a
retry decision made HERE."_ The send loop contradicts its own sibling module's documented contract, and
violates core invariant 2.

### A4. Graceful drain can permanently lose a claimed job

`app/backend/src/engine/fleet/drain.ts:67` transitions on `status='processing'` alone, with no predicate on
`send_attempts.state`. `dispatch-prepare.ts:115` inserts the attempt row in state `prepared` in a **separate**
transaction from the claim. A drain landing in that window marks the job `needs_reconcile` with no attempt row
for the reaper to resolve from.

### A5. Drain waits 20s for in-flight sends but the send timeout is 45s

`app/backend/src/engine/fleet/drain.ts:106`. A healthy in-flight send is always abandoned mid-flight, which is
the exact condition A3 then double-sends.

### A6. `delivery_events` runs out of partitions ~21 days after deploy — **FIXED 2026-09-14**

`db/src/partitions.ts:129` - `ensureAllPartitions` defaults to `periodsAhead = 2` and has **zero production
callers** (confirmed by repo-wide grep: only the export and test helpers). It requires a `wp_migrator`
connection and is deliberately off the app's grant surface, so no running role can call it. Three weeks after
deploy the send-result write starts failing.

### A7. Backups are documented but wired to nothing

`infra/backup/backup-cron.md` describes pgBackRest. It is not installed, not in either compose file, and not
in the deploy scripts. Launch-checklist row 18 cannot be closed by following any document in the repo.

### A8. The published legal retention table is enforced by nothing

`website/content/legal/privacy.mdx:24` and `terms.mdx:18` publish an 8-row retention table to real visitors.
`db/src/retention.ts:32` holds **one** policy. Six of the eight published commitments have no purge job. This
is a public, controller-facing promise the system does not keep.

### A9. `POST /v1/media` has no entitlement gate and no rate limit

`app/backend/src/modules/media/media.routes.ts:106` accepts API keys but applies neither, unlike the send
route. A valid key can upload without limit.

---

## B. Confirmed CRITICAL - in the deployment added today (my own new code)

Both were found by the review, **reproduced by me**, and are now fixed.

### B1. `docker-compose.prod.yml` could not be parsed on the target box - FIXED

`env_file:` values are handed to the _container_; they are invisible to compose's own `${...}`
interpolation, which reads only the shell environment or a `.env` file next to the compose file. With
`POSTGRES_PASSWORD` written as a hard `${...:?}` interpolation, the first `docker compose` on the EC2 box
would have failed outright. Reproduced:

```
error while interpolating services.postgres.environment.POSTGRES_PASSWORD:
required variable POSTGRES_PASSWORD is missing a value
```

Fixed by splitting the two files explicitly and adding `infra/deploy/compose.env.example` for the handful of
values compose itself interpolates, with a header on the compose file explaining the distinction.

### B2. Migrations were routed through PgBouncer, breaking their advisory lock - FIXED

`db/src/migrate.ts:122` serialises concurrent migration runs with `pg_advisory_lock`, which is
**session-scoped**. Under PgBouncer transaction pooling the lock can be acquired on one backend and unlocked
on another, so it silently stops serialising and two deploys could migrate at once.

Fixed with a separate `MIGRATE_DATABASE_URL` pointing straight at Postgres, wired only to the one-shot
`migrate` service, with the reasoning recorded at both the compose entry and the env template.

### B3. Services waited on `postgres` but connect to `pgbouncer` - FIXED

`depends_on` now waits on `pgbouncer` (which itself waits on a healthy `postgres`), so no role starts against
a pooler that is not yet accepting connections.

### B4. The admin backend was built but never run - FIXED (found by me, before the review)

`admin/backend` ships in the image but had no service in the production compose and none of its five
required production secrets (`ADMIN_JWT_SECRET`, `INTERNAL_API_SERVICE_TOKEN_SECRET`,
`LEADS_IP_HASH_SECRET`, `LEADS_ALLOWED_ORIGINS`, `WP_KEY_RING_PATH`) in the env template. The founder
explicitly asked for admin-side plan and wallet management to be live. Added, and verified booting and
serving from the image: `POST /admin/v1/auth/login` returns the correct validation envelope demanding email,
password and TOTP.

---

## C. Confirmed HIGH

| #   | Finding                                                                                                                                                                   | Where                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| C1  | No health endpoint anywhere, so compose declares no healthcheck for any app service - a wedged process is never restarted and never alerts                                | `infra/compose/docker-compose.prod.yml`                       |
| C2  | `resolvePriceKey` maps an unknown `payload_kind` to a **text** price via a fallback branch - the exact sibling of the `payloadKindFor` billing defect fixed earlier today | `packages/domain/src/pricing.ts:24`                           |
| C3  | `session_mfa` carve-out lets a TOTP-unenrolled admin mint a permanent API key with password-only auth                                                                     | `app/backend/src/platform/http/route-policy.ts:201`           |
| C4  | `POST /v1/auth/refresh` and `POST /v1/auth/verify-email` are public with no rate limit                                                                                    | `app/backend/src/modules/identity/auth.routes.ts:161`         |
| C5  | `stopClaiming` does not await in-flight iterations, so a claim can start after the drain's snapshot                                                                       | `app/backend/src/engine/queue/send-loop-fleet-wiring.ts:201`  |
| C6  | `isClaimingAllowed()` has no production consumer - a worker keeps sending while Postgres liveness is unknown                                                              | `app/backend/src/engine/lease/heartbeat.ts:127`               |
| C7  | One claim per trigger with no `next_eligible_at` nudge - a paced backlog drains at the 30s safety-poll rate, not the 15s pacing gap (matches P26 finding (a))             | `app/backend/src/engine/queue/send-loop-worker-wiring.ts:244` |
| C8  | `/metrics` is unreachable by construction in the prod compose                                                                                                             | `infra/compose/docker-compose.prod.yml`                       |
| C9  | `ship-image.sh` migrates while the OLD code still serves, with no forward-compat gate and no rollback path                                                                | `infra/deploy/ship-image.sh:56`                               |
| C10 | The AWS runbook never mentions the observability stack, so checklist row 19 (alerting to a human) cannot be closed by following it                                        | `docs/runbooks/aws-first-deployment.md`                       |
| C11 | ADR 0050 is still `proposed`, blocking P30/P30a and therefore P34/P35/P36 and checklist rows 15 and 30                                                                    | `.memory/decisions/0050-*.md`                                 |

---

## D. Confirmed MEDIUM (selected)

- **Launch-checklist row 31 is stale**: it describes the graceful-drain gap as open, but
  `roles/session-worker.ts:255` wires the real `buildSessionWorkerDrain`. The row reads DONE work as NOT DONE.
- **`docs/RUNBOOK.md:407` lists four KEK purposes**; there are five since `api-key-pepper` was added on
  2026-09-14. The KEK-rotation procedure is stale in a way that would break a rotation.
- **No secret-rotation procedure** exists for `AUTH_JWT_SECRET`, the api-key pepper, the S3 IAM keys or the
  Gmail app password.

---

## E. The 19 test failures - RESOLVED, and the cause was worse than "flaky"

The gate run of 2026-09-14 17:08 failed with 19 tests across 14 files. My first diagnosis - leftover fixture
pollution in `wp_test2` - was **wrong**, and the giveaway was that cleaning that database changed nothing.

**Root cause: the integration suite was never connecting to the test database at all.**

`resolveDatabaseUrl()` (`app/backend/src/platform/db/db-url.ts:20`) takes `process.env.DATABASE_URL` if set
and otherwise parses `.secrets/dev.env`, whose `DATABASE_URL` names the **dev** database `wp`. Nothing set
that variable - not `scripts/gate.ps1`, not `scripts/ci-steps.ts`, not any vitest config. Isolation happened
only when a human exported it by hand first, which `docs/evidence/P29a-gate-tail.md` records in passing:
_"(2026-09-09, `DATABASE_URL` -> `wp_test2`)"_.

Measured at the same moment:

|                      | `wp` (what tests actually hit) | `wp_test2` (what everyone assumed) |
| -------------------- | ------------------------------ | ---------------------------------- |
| clients              | **1,195**                      | 3                                  |
| whatsapp_instances   | **2,105**                      | 1                                  |
| instance_lease_state | **2,052**                      | 0                                  |
| outbox_events        | **2,136**                      | 0                                  |

Every failing test was a bounded or cross-tenant scan written for a near-empty database. `relay-lag-metric`
drained 263 real dev rows when its fixture created one. `fleet-recovery-storm`'s bounded 24-row scan could
never reach its own instance among 2,052 competing lease rows. **The suite also writes**, so every integration
run had been mutating the developer's real dev database - which is why `wp` holds 1,195 clients.

**Fixed** in `scripts/gate.ps1` (the one sanctioned entrypoint): it now derives the URL from the same
`.secrets/dev.env` line and swaps **only** the trailing database name, preserving user, password, host, port
and query string, never echoing the value. An explicitly exported `DATABASE_URL` still wins. If the rewrite
cannot be made, the gate refuses to run rather than silently falling back to `wp`.

**Verified**: all 14 previously-failing files re-run against `wp_test2` - **47 tests, all green**, in three
batches. Not one was a code defect.

> **This invalidates earlier gate evidence.** Any prior gate run that did not explicitly set `DATABASE_URL`
> was measured against the wrong database. In particular, the standing "flaky real-infra integration tests"
> BLOCKER-CLASS in `.memory/progress/master-plan.md`, and the environmental attributions recorded across
> P26b/P28/P29/P29a, need re-testing against a correctly-isolated gate before anything more is written about
> them. Full writeup: `.memory/lessons/2026-09-14-the-gate-ran-against-the-dev-database.md`.

### E1. The one genuine test defect the fix exposed

With isolation corrected, the gate re-run (18:03) went from **19 failures to 1**:

```
unit         573 files / 3592 tests   PASS
db suite     59 of 60 files           1 FAIL
```

The survivor is `db/tests/claim-plan.test.ts:285` -
`claim_plan_probes_campaigns_by_primary_key_and_never_scans_it`. Postgres seq-scans the **current-month**
partition while every sibling partition uses its index:

```
->  Seq Scan on message_jobs_y2026m09 j_7  (cost=0.00..136.78 rows=25) (actual rows=25 loops=1)
      Rows Removed by Filter: 1101
```

This is a real test defect, not a flake: run three times consecutively it failed 1, then 2, then 2 times,
i.e. it also degrades across runs, which points at incomplete fixture cleanup on top of the sizing problem.

The fixture seeds `15 instances x 300 jobs = 4,500` rows round-robined across 4 partitions, so ~1,125 per
partition and ~2.2% selectivity (25 of 1,126). That is **below** the ~10% flip threshold recorded for the P19
sibling, so this is not simply "seed noise as a ratio" - at ~1,126 rows the partition is only ~100 pages, and
a scan is genuinely cheap enough that an index never pays off.

**RESOLVED.** The cause was neither selectivity nor a cleanup leak: it was **index bloat**. Every run DELETEs
thousands of rows from the current-month partition (the only bucket whose `p_cap` is `now()`), and the
cleanup ran `ANALYZE` but never `VACUUM`. Across accumulated runs in the shared test database that
partition's `_priority_rank_n_idx` child reached **28,689 pages for 13 live rows**, against 668-932 pages on
sibling partitions. Postgres then correctly preferred scanning the ~309-page heap over walking a
28,689-page index - right behaviour given the physical state, not a defect in `claim-jobs.sql`.

Fixed in the fixture, not the assertion: `VACUUM` (never `VACUUM FULL`) on every table the file asserts plan
shape against, plus the two cardinality-cleanup helpers. Vacuuming only `message_jobs` was tried first and
the flake simply moved to `wallet_accounts`.

Verified: 13 consecutive standalone runs green; full `@wp/db` suite **60 files / 272 tests green**; and the
assertion proven still LOUD by forcing `enable_indexscan=off`, which turns all three tests red. A fix that
had merely silenced the check would stay green under that.

Full writeup: `.memory/lessons/2026-09-14-index-bloat-from-test-churn-flipped-a-plan-shape-assertion.md`.

**Still being re-verified under correct isolation:** the `app-backend` integration suite. Its last run was
**620 of 624 files / 2,273 of 2,277 tests green**; one of the 4 failing files passes standalone, so they look
like cross-file interference rather than standalone defects. A structured re-run is in flight to name all
four precisely. Until that lands, that suite is NOT claimed clean.

---

## F. What was checked and found clean

- The go-live paths, smoke-tested end to end **against the production image** (not a dev process): signup →
  email verification → TOTP login → onboarding → API key creation → send returning `201 queued` → revoke →
  the revoked key correctly refused `401`. The raw key never appeared in the list response.
- All five roles boot from the image: `api`, `session-worker`, `cron`, `relay`, `migrate`, plus `admin-api`.
  `ROLE=migrate` reported `applied 0 migration(s), 77 already up to date` against a real Postgres.
- Workspace-package resolution: the integration project resolves `@wp/domain` to
  `packages/domain/src/index.ts` (source), so the conditional-`exports` change does not make tests run
  against stale `dist/`.
- Unit suite: 573 files / 3592 tests green. Typecheck, dependency-cruiser, and all three security scanners
  clean.

---

## G. Honest summary

The **product paths the founder asked to go live work**, and were proved on the real deployment artefact.

The **deployment itself had four defects**, all found and fixed today, two of which would have stopped the
first `docker compose` on the box outright.

The **test suite was pointed at the wrong database** (section E). That is fixed, and it means the project has
been running its gate against real dev data for an unknown length of time - so some of what was previously
written off as flakiness deserves a fresh look.

The **application has nine confirmed critical defects that predate this session**, led by a recurring
RLS-versus-bare-pool class that the dev superuser hides from every test. None of them is visible in a green
gate, which is precisely why they survived.

**Recommendation: do not put a paying tenant on this until at least A1, A3, A4/A5 and A6 are fixed.** A1
breaks instance management outright under the production role; A3 can send a customer's message twice; A6 is a
timer that runs out three weeks after launch.
