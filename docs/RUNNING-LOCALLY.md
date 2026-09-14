# Running WP locally

> **The one thing to know:** the panel UI is on **http://localhost:5173**.
> `http://localhost:3000` is the **API only** — opening it in a browser correctly returns
> `{"message":"Route GET:/ not found"}`. That is not a broken UI; there is no UI on :3000, by design.
>
> This doc exists because that confusion cost a real session on 2026-09-01. The full operator runbook
> (production, alerts, restore drills) is phase **P25** and is not built yet.

## TL;DR

```powershell
powershell -File scripts/dev.ps1
```

Then open **http://localhost:5173/signup**.

`scripts/dev.ps1` loads `.secrets/dev.env`, checks the docker dev stack, starts the backend (`ROLE=api`) and
the frontend (vite), prints the URLs, and stops both on Ctrl+C.

---

## What actually runs

| Process                   | Command                                       | Port          | What it serves                                                                                               |
| ------------------------- | --------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| **Panel (UI)**            | `npm run dev` in `app/frontend` or `pnpm dev` | **5173**      | The React SPA. **Open this.** Proxies `/v1` → :3000                                                          |
| Backend API               | `npm run dev:api` in `app/backend`            | 3000          | JSON API only. No HTML.                                                                                      |
| Session worker            | `npm run dev:worker` in `app/backend`         | —             | Holds Baileys sockets. Only needed for QR linking / sending.                                                 |
| Session cron              | `npm run dev:cron` in `app/backend`           | —             | Job scheduling. Started alongside worker for real sends.                                                     |
| Relay (Signal sync)       | `npm run dev:relay` in `app/backend`          | —             | Signal state bridge. Started alongside worker for group sends.                                               |
| All roles (one terminal)  | `npm run dev` in `app/backend`                | 3000 + 9464-7 | Starts api + worker + cron + relay as child processes; per-role metrics on 9465/9466/9467; Ctrl+C stops all. |
| Postgres                  | docker compose                                | **55432**     | non-default port (native pg owns 5432)                                                                       |
| PgBouncer (P26, optional) | docker compose (`up -d postgres pgbouncer`)   | **56432**     | transaction-pool front for Postgres — measurement instrument only                                            |
| redis-ctl                 | docker compose                                | **56379**     | leases, pacing, pub/sub                                                                                      |
| redis-sig                 | docker compose                                | **56380**     | Signal state, `noeviction`                                                                                   |
| mailpit                   | docker compose                                | 8025 (UI)     | catches verification emails — **check it after signup**                                                      |
| Metrics (api)             | same process as the API, internal-only        | 9464          | `WP_METRICS_BIND`/`WP_METRICS_PORT` — never on the public router                                             |

The SPA and API **must be same-origin** in dev: the refresh cookie is `SameSite=Strict; Secure`, so vite
proxies `/v1` to the backend and the browser only ever talks to `localhost:5173`. Do not "fix" this by
calling :3000 from the browser.

Each project in `app/` has its own `npm run dev` scripts:

- `app/backend/npm run dev` starts all roles (api + session-worker + cron + relay) in one terminal with prefixed output and per-role metrics. One Ctrl+C stops all.
- `app/backend/npm run dev:api` | `dev:worker` | `dev:cron` | `dev:relay` starts a single role in the foreground. Use these for focused development.
- `app/backend/npm run dev:migrate` runs pending migrations and exits.
- `app/frontend/npm run dev` serves the panel on http://localhost:5173.

The script `app/backend/scripts/dev-role.ts` loads `.secrets/dev.env` itself (environment variables already set take precedence; relative `WP_KEY_RING_PATH` is resolved against repo root), so a plain `cd app/backend && npm run dev` works from any shell.

There is **no root `pnpm dev`** script; each project is independent. `scripts/dev.ps1` (launches api + panel only, does NOT start worker/cron/relay) remains the quickest one-shot for basic testing.

## Manual start (if you are not using dev.ps1)

```powershell
# 1. env — everything (compose creds, DATABASE_URL, REDIS_*, WP_*) lives here
Get-Content .secrets/dev.env | Where-Object { $_ -match '^[A-Za-z_]\w*=' } |
  ForEach-Object { $k,$v = $_ -split '=',2; Set-Item "env:$k" $v }

# 2. infra (compose REQUIRES that env — POSTGRES_PASSWORD uses the `:?` required form)
docker compose -f infra/compose/docker-compose.dev.yml up -d postgres redis redis-sig

# 3. migrations
powershell -File scripts/db-migrate.ps1      # loads .secrets/dev.env itself

# 4. backend (API only, :3000)
cd app/backend; $env:ROLE='api'; pnpm exec tsx src/main.ts

# 5. panel (THE UI, :5173) — separate terminal
cd app/frontend; pnpm dev
```

## Fleet-scale harness (P26, real worker processes)

`app/backend/src/engine/measure/scale-fleet.ts` spreads N synthetic instances over REAL worker child
processes through the real lease/fence/EncryptedAuthStore path (FakeSock only — never a real Baileys
socket, never real network). It is exercised by
`app/backend/src/engine/measure/scale-fleet.integration.test.ts`:

```powershell
pnpm -F app-backend exec vitest run --config vitest.config.ts src/engine/measure/scale-fleet.integration.test.ts
```

Bring up PgBouncer alongside Postgres first if a run needs the pooled-connection comparison (recreates the
`postgres` container — the data volume persists):

```powershell
docker compose --env-file .secrets/dev.env -f infra/compose/docker-compose.dev.yml up -d postgres pgbouncer
```

`resolvePgBouncerDatabaseUrl()` (`platform/db/db-url.ts`) returns `null` when PgBouncer is not configured —
callers label that run `DIRECT-CONNECTION`, never a faked pooled result.

## First run: what you can and cannot do

**Phases P00–P25 are complete** (see `plan/README.md`). The panel routes are live and testable locally.
No dev seed account exists — the first signup becomes the workspace owner. Verification emails land in
**mailpit** (http://localhost:8025); TOTP enrolment is mandatory on first login. The live QR scan against
a real phone is the open founder item. The conservative pacing defaults are **ON by default** (ADR 0015).

**Routes that work:**

- **Public:** `/signup` (Full name, Work email, Phone number, Company name, Password ≥12 characters);
  `/login` (Email, Password); `/verify-email` (mailpit link); `/totp` (enrol TOTP on first login).
- **Authed:** `/` (dashboard: wallet banner, queue status); `/instances` (connect/manage numbers via QR, needs session-worker running);
  `/messages` (composer: real sends need worker + cron); `/unresolved` (retry/discard `blocked_needs_review` sends);
  `/broadcasts` (list), `/broadcasts/new` (audience, message, variables, schedule, preflight), `/broadcasts/$id` (funnel, pause/resume/cancel);
  `/contacts` (list/search/add/import/export); `/groups` (WhatsApp group sync & send);
  `/settings/webhooks` (endpoints, secret dialog).

**Does NOT exist yet:**

- **Marketing website** (`website/` has no src — P29).
- No synthetic test users or seed data; every test starts with signup.

## Manual review checklist

### Prerequisites

1. `docker compose -f infra/compose/docker-compose.dev.yml up -d` (or the relevant services) — Postgres,
   Redis, mailpit.
2. `npm run dev` in `app/backend` — starts all four roles (api + session-worker + cron + relay) in one
   terminal. **The session-worker boot gate**: the worker refuses to start while any LIVE instance row
   lacks pacing state. On a dev DB that still carries the fixture instances from earlier queue-explain
   work, clear them first: run `db/seeds/queue-explain-fixture-remove.sql` against the dev database, and
   check for any other leftover test instance rows from a previous manual session before starting the
   worker.
3. `npm run dev` in `app/frontend` — serves the panel on http://localhost:5173.
4. **Fastest path to a demo-ready workspace:** `pnpm demo:seed` from the repo root. It walks the real API
   (signup → verify-email via mailpit → login → TOTP enrol/confirm → re-login with MFA → onboarding →
   sample contacts) and prints ONE block to the terminal: the panel URL, the generated email/password, the
   TOTP setup secret, the onboarding step reached, and the counts created. That block is printed once and
   **never written to any file** — copy the credentials from your terminal before they scroll away. Linking
   a number still needs the session-worker running.

   **A fresh signup has no billing plan assigned** (plan assignment is a P28 admin/billing feature that
   does not exist yet), so `POST /v1/contacts` and `POST /v1/instances` both fail-close with a 409
   (`CONTACT_LIMIT_REACHED` / `REGISTERED_LIMIT_REACHED`, reason `no_plan`) — this is the fail-safe
   behaviour working as intended (core invariant 2), not a bug. When `pnpm demo:seed` hits this, it prints
   the workspace's credentials, then a two-step unblock:

   1. Assign the dev-only "Demo plan" to that workspace by running the printed `psql` command against the
      dev database (never production) — `db/seeds/demo-plan-assign.sql` (see `db/seeds/README.md`).
   2. Re-run `pnpm demo:seed` in **resume mode**, with `WP_DEMO_EMAIL`, `WP_DEMO_PASSWORD` and
      `WP_DEMO_TOTP_SECRET` all set to the values just printed. Resume mode skips signup/verify/enrol
      entirely — it logs in (expects `mfa_required`), verifies TOTP from the given secret, and continues
      onboarding/contacts/broadcast for the SAME workspace instead of creating a new one.

   **Exit codes:** `0` ready, `1` refused (production env) or an unexpected failure, `2` the email is
   already taken (fresh mode only — nothing was changed), `3` the workspace needs a plan assigned (see
   above; the instruction block was already printed).

5. The design gallery — every `@wp/ui` primitive with its states — is at
   **http://localhost:5173/dev/gallery** (dev-only; returns not-found in a production build).

### Screen-by-screen (nav order)

1. **http://localhost:5173/signup** — split-screen layout (product copy left, form right). Full name, work
   email, phone, company name, password (≥12 characters). Submit with valid data; check **mailpit
   http://localhost:8025** for the verification email and click its link.
2. **http://localhost:5173/verify-email** — confirms the token and offers to continue to `/login`.
3. **http://localhost:5173/login** — sign in with the account above; a first-time account redirects to
   `/totp` to enrol.
4. **http://localhost:5173/totp** — TOTP enrolment (QR code + manual setup key), a 6-digit confirm field,
   then a one-time recovery-codes screen. A second login now returns `mfa_required` and re-visits `/totp`
   for the verify continuation.
5. **Onboarding stepper** (`/onboarding`) — timezone, pacing profile (the conservative default is **ON by
   default**, ADR 0015), consent attestation, then the connect step (label + Continue). Two-factor must be
   set up and the session re-verified before a number can be connected — until then the connect step shows a
   "Secure your account first" card above the form.
6. **Dashboard** (`/`) — KPI row (connected numbers, queued, sent, spent today) and, until a number is
   linked and a first message sent, a "Getting started" checklist card. Reachable once onboarding reaches
   the connect step or later; earlier steps redirect back to `/onboarding`.
7. **http://localhost:5173/instances** — numbers list + detail; the connect sheet offers a QR or pairing-
   code method once a number is created. Needs the session-worker running to actually link a phone.
8. **http://localhost:5173/messages** — composer (from-number, recipient, message body). Real sends need
   the worker + cron roles running.
9. **http://localhost:5173/unresolved** — retry/discard queue for sends needing review; shows an honest
   "nothing to review" empty state when there is nothing pending.
10. **http://localhost:5173/broadcasts** — list, `/broadcasts/new` (audience picker, message, variables,
    schedule, pre-flight quote), `/broadcasts/$id` (funnel, pause/resume/cancel).
11. **http://localhost:5173/contacts** — list/search, add-contact form, CSV import wizard, export.
12. **http://localhost:5173/groups** — WhatsApp group sync and send from a linked number.
13. **http://localhost:5173/settings/security** — Email (address + verified/not-verified badge), Two-factor
    authentication (not-set-up with a setup button, or enabled-since-date with the honest re-enrolment-not-
    available note), Password (honest not-available-yet copy, no form), Session (Sign out).
14. **http://localhost:5173/settings/webhooks** — add-endpoint form, one-time secret dialog, endpoint list.
15. **http://localhost:5173/wallet** — balance/queue status, top-up request form, top-up history.
16. **Shell chrome** (any authed screen) — theme switch (system/light/dark) in the sidebar footer, locale
    switch (en/hi) in the top bar, `Ctrl`/`Cmd`+`K` opens the command palette, and the layout re-flows to a
    single column with a hamburger-triggered nav sheet at 390 px wide.

## Admin console (staff panel)

The staff console is a **separate deployable** from the tenant panel: its own backend
(`admin/backend`, port **3001**) and its own React SPA (`admin/frontend`, port **5174**). It talks
to app-backend only through the `/internal/v1` service-to-service surface, never through `/v1`.

| Process                    | Command                            | Port     | What it serves                                                                   |
| -------------------------- | ---------------------------------- | -------- | -------------------------------------------------------------------------------- |
| Admin panel (UI)           | `pnpm -F admin-frontend dev`       | **5174** | The staff console SPA. Proxies `/admin/v1` → :3001                               |
| Admin API                  | `pnpm -F admin-backend dev`        | 3001     | `/admin/v1/*` — staff auth, client/instance/wallet/audit reads, mutation proxies |
| App API (internal surface) | already running per the main table | 3000     | Must additionally run with `INTERNAL_API_ENABLED=true`                           |

Like the tenant panel, the admin panel and admin API **must be same-origin** in dev: the
`wp_admin_rt` refresh cookie is `SameSite=Strict; Secure`, so `admin/frontend/vite.config.ts`
proxies `/admin/v1` to `admin-backend` and the browser only ever talks to `localhost:5174`.

### Env vars admin-backend needs

- `ADMIN_PORT` (default 3001), `ADMIN_HOST` (default `127.0.0.1`), `ADMIN_DATABASE_URL` (falls back
  to `DATABASE_URL`), `ADMIN_JWT_SECRET` (≥32 chars — dev has an insecure default, production must
  set a real one), `ADMIN_ACCESS_TOKEN_TTL_SECONDS` (ceiling 120s — staff access tokens are
  short-lived and silently refreshed), `ADMIN_REFRESH_TTL_SECONDS`.
- `ADMIN_IP_ALLOWED_CIDRS` — a comma-separated IPv4 CIDR list. **Defaults to empty, meaning nobody
  can log in.** For local dev this must include `127.0.0.1/32` (or the CIDR your admin-frontend dev
  server's requests arrive from).
- `INTERNAL_API_BASE_URL` (default `http://127.0.0.1:3000` — points at app-backend),
  `INTERNAL_API_SERVICE_TOKEN_SECRET` (≥32 chars, shared secret with app-backend's own
  `INTERNAL_API_SERVICE_TOKEN_SECRET` — the two must match), `APP_PANEL_BASE_URL` (default
  `http://localhost:5173` — the TENANT panel's origin; impersonation `panelUrl`s are built against
  this, never the admin origin).

### Env vars app-backend needs (in addition to the main table)

The app API must run with the internal surface turned on and reachable only from the admin API:

```
INTERNAL_API_ENABLED=true
INTERNAL_API_SERVICE_TOKEN_SECRET=<same value as admin-backend's>
INTERNAL_API_ALLOWED_CIDRS=127.0.0.1/32
```

### Starting it

```powershell
pnpm -F admin-backend dev     # :3001
pnpm -F admin-frontend dev    # :5174
```

Then open **http://localhost:5174/login**.

### Creating a staff account

There is no self-service staff signup. See `docs/RUNBOOK.md`'s `## staff-accounts` section for the
full procedure; the short version:

```bash
DATABASE_URL=... WP_KEY_RING_PATH=... \
  pnpm exec tsx scripts/ops/create-staff-user.ts \
    --email ops@example.com --name "Ops Person" --role ops
```

TOTP is mandatory (the script prints an `otpauth://` URL once — enrol it before first login) and
the staff member's network must be in `ADMIN_IP_ALLOWED_CIDRS`. Staff access tokens are silently
refreshed every ~2 minutes while the console tab stays open (the `wp_admin_rt` cookie, `httpOnly` +
`Secure` + `SameSite=Strict`, is the only long-lived credential — it never reaches the page's JS).

### Website + lead form

```powershell
pnpm -F website dev          # :3002
pnpm -F website run build    # static export -> website/out
```

The contact page's form posts to `POST /public/v1/leads` on admin-backend (port 3001) — never to
app-backend. Relevant env vars: `LEADS_ALLOWED_ORIGINS` (exact site origins, comma-separated;
required in production, defaults to the local dev origins in development), `LEADS_IP_HASH_SECRET`
(>= 32 chars, required in production; the dev default is insecure and must not be reused),
`NEXT_PUBLIC_LEADS_ENDPOINT` (build-time, defaults to the local admin dev URL). After a build, run
`pnpm -F website run test:e2e`.

The lead endpoint's rate limiter and IP hash both key on Fastify's `req.ip`; with `ADMIN_TRUST_PROXY=false`
(the default) behind a reverse proxy, `req.ip` is the proxy's own address for every visitor, so
production must run behind a reverse proxy that overwrites `X-Forwarded-For` AND set
`ADMIN_TRUST_PROXY=true` — with `ADMIN_TRUST_PROXY=true` and no trusted proxy in front of admin-api,
`X-Forwarded-For` is caller-spoofable instead. The global submission-volume bucket is the backstop
either way (see `modules/leads/public-rate-limit.ts`'s header).

## Integration tests and the gate use a dedicated database

The backend and `db/` integration suites scan the whole database (unowned instances, outbox rows, pacing
sweeps), so they are only meaningful against a database nothing else writes to. The shared `wp` dev database
carries the queue-explain fixture, leftover probe instances and, while a measurement run is live, thousands of
synthetic instances - the suite goes red there for reasons that are not code. Point the suites at a dedicated
`wp_test` database in the same dev Postgres instead (both suites and the migrate role honour `DATABASE_URL`
over `.secrets/dev.env`):

```powershell
docker exec -i wp-dev-postgres-1 psql -U wp -d postgres -c "CREATE DATABASE wp_test OWNER wp;"
$env:DATABASE_URL = "postgres://wp:<POSTGRES_PASSWORD from .secrets/dev.env>@127.0.0.1:55432/wp_test"
cd app/backend; pnpm run dev:migrate; cd ../..
# the two EXPLAIN-plan tests in db/tests/claim-plan.test.ts need the fixture's row counts:
docker exec -i wp-dev-postgres-1 psql -U wp -d wp_test -v ON_ERROR_STOP=1 < db/seeds/queue-explain-fixture.sql
docker exec -i wp-dev-postgres-1 psql -U wp -d wp_test -c "ANALYZE;"
pnpm run test:int            # or: powershell -File scripts/gate.ps1 (inherits the env var)
```

If a suite reports `no partition of relation "delivery_events" found`, the fresh database lacks the earlier
weekly/monthly partitions that `wp` gained over time: create them exactly as migration 0009 does - `CREATE TABLE
<name> PARTITION OF <parent> FOR VALUES ...` followed by `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`
and the `tenant_isolation` policy copied from a sibling partition (`pg_policies`), or isolation suite A fails on
the new partition. Stop your own `relay` and `cron` dev roles while the suite runs; Redis is still shared with
them.

## Troubleshooting

| Symptom                                                   | Cause / fix                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `{"message":"Route GET:/ not found"}` in the browser      | You are on :3000 (the API). Go to **:5173**.                                                                                          |
| Blank page / nothing renders                              | Only one process is running. The panel needs **both** :5173 and :3000.                                                                |
| `required variable POSTGRES_PASSWORD is missing a value`  | Ran compose without loading `.secrets/dev.env`.                                                                                       |
| Backend exits immediately                                 | `WP_KEY_RING_PATH` file missing → `node scripts/gen-key-ring.mjs`. Also `ROLE` must be set.                                           |
| `ConfigError: Invalid or missing config env var(s): WP_*` | `.secrets/dev.env` is missing the `WP_*` block. (For _tests_ this is handled automatically by `packages/config/vitest-setup-env.ts`.) |
| Signup email never arrives                                | It does — in **mailpit** (http://localhost:8025), not a real inbox.                                                                   |
| `HeapBudgetMismatchError` on the worker                   | The session worker asserts `--max-old-space-size` equals `WORKER_HEAP_BUDGET_MB` (3072).                                              |
| Port already in use                                       | A previous run is still listening: `Get-NetTCPConnection -LocalPort 3000 -State Listen` then `Stop-Process`.                          |
