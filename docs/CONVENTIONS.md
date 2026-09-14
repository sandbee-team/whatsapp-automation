# Conventions

Repo-wide naming, content, and process conventions for WP. This is the canonical
copy referenced by CLAUDE.md and the wp-architecture skill. Source: adapted
from `.memory/research/2026-08-25-v1-design-repo-structure.md` §6.1-6.7 to
P00 reality (no Turborepo; local CI = `scripts/ci.ps1`/`ci.sh`).

## Naming

| Thing            | Rule                                                                                        | Example                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Folders          | kebab-case, singular for modules                                                            | `modules/instance-health/` -> no: use `modules/instances/` (plural for entity modules) |
| Files            | kebab-case + role suffix                                                                    | `send-message.service.ts`, `messages.repo.ts`, `claim-jobs.sql`                        |
| React components | PascalCase file matching export                                                             | `HealthBadge.tsx`                                                                      |
| Types            | PascalCase; DTOs end `DTO`; rows end `Row`                                                  | `MessageJobDTO`, `MessageJobRow`                                                       |
| DB tables        | snake_case, plural                                                                          | `message_jobs`, `whatsapp_instances`, `delivery_events`                                |
| DB columns       | snake_case; ids `<entity>_id`; timestamps `*_at` (timestamptz UTC); booleans `is_*`/`has_*` | `client_id`, `next_attempt_at`, `is_opted_out`                                         |
| Enums            | lower_snake values, stored as PG enum or `text` + CHECK                                     | `status: 'queued'`                                                                     |
| Indexes          | `idx_<table>__<cols>`; unique `uq_<table>__<cols>`                                          | `idx_message_jobs__instance_status_next_attempt`                                       |
| API routes       | `/v1/<plural-resource>` + verb-as-subresource for actions                                   | `POST /v1/instances/:id/pause`                                                         |
| Internal routes  | `/internal/v1/...` (S2S only, never public)                                                 | `/internal/v1/instances/:id/pause`                                                     |
| Events           | `<entity>.<verb-past>`                                                                      | `message.job.sent`, `instance.paused`, `instance.logged_out`                           |
| Env vars         | SCREAMING_SNAKE, prefixed by concern                                                        | `SESSION_CRED_KEK`, `WORKER_SHARD_TOTAL`                                               |
| Feature flags    | `<area>.<name>`                                                                             | `inbox.v2`                                                                             |
| Metrics          | `wp_<subject>_<unit>`                                                                       | `wp_queue_depth`, `wp_send_latency_ms`                                                 |
| Error codes      | SCREAMING_SNAKE, defined once in `@wp/contracts/errors.ts`                                  | `INSTANCE_PAUSED`                                                                      |

## File-content rule

One primary export per file; the file name is that export. Max 300 lines
(hard limit, ESLint). Routes never touch the DB; repos never contain business
rules; services take `ctx: TenantContext` first; only `platform/config.ts`
reads `process.env`.

## Adding a metric

1. Name it `wp_<subject>_<unit>` and register it in the OWNING module's
   metrics file via `registry.counter(...)` / `registry.gauge(...)` /
   `registry.histogram(...)` - never in a shared dumping-ground file.
2. Labels come only from `ALLOWED_LABELS` in
   `packages/server-kit/src/obs/metric-policy.ts`. `instance_id`/`client_id`
   may appear ONLY on the four `INSTANCE_LABELLED_GAUGES` - registering a
   fifth metric with either label throws at boot and fails
   `check-metric-inventory`.
3. Add the entry to the inventory
   (`packages/domain/src/obs/metric-inventory*.ts`), including whether
   `alerts: true` or `alerts: false`.
4. Regenerate the manifest: `pnpm exec tsx scripts/gen-metric-manifest.ts`,
   and commit the resulting `infra/observability/metrics.generated.json`.
5. Either add an alert or recording rule in
   `infra/observability/prometheus/rules/` with a `runbook_url` anchor that
   exists in `docs/RUNBOOK.md`, or add a dashboard panel, or set
   `alerts: false` deliberately if neither applies yet.
6. Never put a phone number, JID, message body, email, key, or
   `external_ref` in a label value or an alert annotation.
7. Per-client or per-instance detail comes from PostgreSQL rollups, not from
   metric labels.

## API response and error shape

```jsonc
// success
{ "data": { "id": "01J...", "status": "queued" },
  "meta": { "requestId": "req_01J...", "nextCursor": "eyJpZCI6..." } }

// error  (HTTP status carries the class; code carries the reason)
{ "error": { "code": "INSTANCE_PAUSED",
             "message": "Sending is paused for this WhatsApp instance.",
             "details": { "instanceId": "01J...", "healthState": "paused" },
             "requestId": "req_01J..." } }
```

Rules: codes are SCREAMING_SNAKE and defined once in
`packages/contracts/src/errors.ts` (`ERROR_CODE_TO_HTTP_STATUS` is the single
source of truth - one code, one status, no duplicates); messages are human,
never raw exception text; lists are **keyset-paginated**
(`packages/contracts/src/envelope.ts`'s `paginationInputSchema`: `cursor` +
`limit`, max 100) - `OFFSET` is a lint error; every response carries
`requestId`; 429 always carries `Retry-After`. `ProviderError` is never
rendered to this table directly - it is classified into a retry class by
`@wp/domain` first.

## Migrations

`db/migrations/NNNN_<slug>.sql`, 4-digit sequence, forward-only. An applied
migration is never edited - write a new one. Every migration is reversible in
principle and documents its rollback in a header comment. Destructive changes
(drop/rename) go in two steps across two releases (expand -> migrate ->
contract). Index creation on populated tables uses `CREATE INDEX
CONCURRENTLY` in a standalone migration. Migrations run only by `app/backend`
under an advisory lock.

## SECURITY DEFINER functions

House rule: every SECURITY DEFINER function pins `search_path` (`SET
search_path = pg_catalog, public` or similarly explicit), mid-line so
`scripts/check-sql-lint.ts`'s plain-`SET` scanner does not misclassify it -
an unpinned search_path on a SECURITY DEFINER function is a privilege-
escalation hole. The function's owner must be the BYPASSRLS role (`wp`) for
any function that needs to read across tenants (e.g.
`wp_zero_max_rate_wallet_count()`), since a SECURITY DEFINER function runs
with its owner's privileges, not the caller's.

Note on `CREATE OR REPLACE FUNCTION`: Postgres PRESERVES the existing
owner and ACL (grants) across a replace - it does NOT reset them. Migration
0006 re-issues `ALTER OWNER` / `REVOKE` / `GRANT` anyway; that is
belt-and-braces for a fresh-database run, where 0006 executes immediately
after 0005 and there is no prior owner/ACL state to preserve - not because
`CREATE OR REPLACE FUNCTION` resets anything on an already-provisioned
database.

## Tests

- Unit: `<file>.test.ts` next to the source. Pure, fake clock, no DB. Domain
  FSM/pacing/retry lives here.
- Integration: `<project>/tests/integration/<module>.int.test.ts`, real
  Postgres in Docker, truncate-per-test, tenant fixtures from `@wp/testkit`.
- Contract: `<project>/tests/contract/` - every route's input/output
  validated against `@wp/contracts`.
- E2E: `<frontend>/tests/e2e/*.spec.ts` (Playwright).
- Load: `app/backend/tests/load/*.js` (k6).
- Naming: `describe('sendMessage')` + `it('keeps the job QUEUED when the
instance is paused')` - behaviour, not implementation.
- Mandatory tests for the send path: duplicate idempotency key creates one
  row; two workers cannot claim one job; pause mid-batch loses zero jobs and
  duplicates zero sends; a HIGH flood does not starve LOW.

## Versioning without git

ADR 0003: no git, no VCS, ever, for this repo.

- `VERSION` file (repo root): `v1.<YYYYMMDD>.<n>` - bumped by
  `scripts/snapshot.ps1`.
- `scripts/snapshot.ps1` writes a stamped archive to an **external** folder
  outside the repo, excluding `node_modules`, `demo/`, `.secrets`, `dist`,
  `coverage` (at any depth), `.env*`, and `*.tsbuildinfo`, and appends a
  one-line entry to `CHANGELOG.md`.
- Docker images are tagged with the same stamp; deploy = `docker save` ->
  rsync -> `docker load` (`infra/deploy/`). Never GitHub Actions, never a git
  remote.
- "What changed" lives in `CHANGELOG.md` + `.memory/progress/*`, not in
  commit history.

## Crypto (envelope encryption + key rings)

Every secret at rest goes through `@wp/server-kit/crypto`'s `seal`/`open` -
nothing else in the workspace is allowed to touch `node:crypto` directly for
tenant or session data. AES-256-GCM, envelope style: a fresh DEK per record,
wrapped by a purpose-separated KEK (`session`, `tenant-secrets`,
`user-secrets` - never one KEK for everything). AAD is **split** and written
exactly once, in `src/crypto/aad.ts`: the DEK-wrap AAD is
`enc_version || kek_id || purpose`; the record AAD is
`enc_version || table || column || client_id || record_id`. Nothing else
re-derives either formula. `open()` reads `enc_version` and `kek_id` off the
blob itself, never off current config - the AAD (and therefore which key
opens a row) travels with the ciphertext, so bumping `WP_ENC_VERSION` or
generating a new KEK never breaks an existing row.

KEK rotation is `rewrapDek(blob, toKekId, { provider, purpose })` only: it unwraps and rewraps the
DEK and leaves `ciphertext`/`iv`/`auth_tag` byte-identical - bulk ciphertext
is never re-encrypted for a rotation. A `retired` key may still `open`; it
may never be used to `seal`.

The **only** serialisation boundary for structured secrets (e.g. Baileys
auth state) is `sealJson`/`openJson`, which take an injected `{ replacer,
reviver }` codec. Nothing else calls `JSON.parse`/`JSON.stringify` on auth
state or other sealed structures - a second, uninjected parse is exactly the
double-parse bug class that turns `Buffer` fields into
`{ type: 'Buffer', data: [...] }` and fails inside libsignal at send time.
`packages/server-kit/src/**` never imports `baileys` (enforced by the
`server-kit-src-never-imports-baileys` dependency-cruiser rule) - the codec
is always supplied by the caller.

**Key rings.** A key ring is a JSON file matching
`packages/server-kit/src/crypto/key-ring-schema.ts`: one `active` pointer per
purpose plus a `keys` map of KEK id -> `{ purpose, material, created_at,
retired? }`. For local development and tests, run
`node scripts/gen-key-ring.mjs` to generate one fresh, non-retired key per
purpose into `.secrets/key-ring.dev.json` (or `--out <path>`). The generator:
refuses to run when `WP_ENV=production` (production key-ring provisioning -
the 3-copy rule and the restore drill - is a separate, later procedure, not
this script's job), and refuses to overwrite an existing ring file (losing a
key ring means every affected tenant has to re-scan a QR code). `.secrets/`
is excluded from `scripts/snapshot.ps1`'s archive and is never committed to
any deploy artifact - a dev ring never leaves the machine it was generated
on.

**What this does and does not protect against.** No plaintext session
credential, tenant secret, or user secret is ever written to a datastore,
filesystem, or backup at rest - everything on disk is sealed. This does
**not** mean a session cannot be read on the machine that is actively running
it: to send a message, a worker process must decrypt a session into memory,
and a decrypted session sitting in a live worker's memory cannot be
protected from someone with root access to that worker host. Envelope
encryption raises the cost and narrows the blast radius of a data-at-rest or
backup compromise; it is not a claim of protection against a compromised
worker host.

## Logging (field allow-list)

The logger is allow-list, not blocklist: `packages/server-kit/src/obs/logger.ts`
serializes only the keys named in `LogFields`
(`packages/server-kit/src/obs/log-fields.ts`) - `request_id`, `client_id`,
`instance_id`, `job_public_id`, `attempt_no`, `lease_id`, `event_type`,
`error_class`, `status_code`, `duration_ms`, `actor_type`, `actor_id`,
`route`, `worker_id`, `kek_id`. Every other key is dropped, not passed
through. `recipient`, `body`, `payload`, `creds`, `token`, `authorization`,
and `qr` are hard-dropped at runtime even if a future change to `LogFields`
were to add a lookalike key - message content, recipient PII, and any
credential material must never reach a log line.

There is one shared pino instance for the whole process; its level comes
from config. There are no per-session or per-request child loggers (ADR
0018's memory budget: at the target session count, one bound logger per
session is not affordable) - callers pass the allow-listed fields as a
single object on each call instead of building a child logger.

Fields are allow-listed and hard-redacted by both key name and value type
(only `string`/`number` values are ever copied); the message string is free
text and is NEVER redacted - call sites are responsible for keeping secrets
out of it.

Crypto errors stringify to `CRYPTO_<CODE>:<kek_id>` and nothing else -
`CryptoError`'s `message`/`toString()` never include key material, plaintext,
or a stack trace fragment that could leak either.

## Local CI

No Turborepo in this repo - task orchestration is `pnpm -r --filter` plus
TypeScript project references (`tsc -b`). "Done" means
`powershell -File scripts/ci.ps1` (Windows) / `scripts/ci.sh` (POSIX) exits 0
and the output is pasted verbatim. Both entrypoints are thin preflight
wrappers that delegate to the single ordered step list in
`scripts/ci-steps.ts`, so the two gates cannot drift. The 12 steps, in order:

1. `format` - prettier check
2. `lint` - eslint (incl. boundaries + tenant-ctx rules)
3. `depcruise` - cross-project + layering rules (dependency-cruiser)
4. `domain-browser-build` - proves `@wp/domain` is runtime-agnostic
   (`esbuild --platform=browser`)
5. `guard-meta-assertion` - guard harness self-check
6. `tenant-scope` - every tenant-table query carries `client_id`
7. `send-origin` - every send starts as a durable job row (no direct sends)
8. `copy` - forbidden marketing claims + disclosure co-presence
9. `typecheck` - `tsc -b` (project references)
10. `unit` - `vitest run`, no DB
11. `integration` - vitest + Postgres (arrives with the DB phase)
12. `build` - all projects

## Code-review checklist

1. Does any send happen without a durable job row? (must be no)
2. Is every new query tenant-scoped, including background/cron paths?
3. Is the new mutation idempotent at the **storage** layer (unique key /
   conditional update), not in memory?
4. On failure: what pauses, what retries, what is preserved? Is a pause
   unable to lose or fail a job?
5. Any PII, message body, recipient number, or credential reachable from a
   log line?
6. New user-facing copy: does it survive `check-copy.ts` (no banned
   marketing claims - the list is `BANNED_CLAIMS` in `@wp/domain`)? Does any
   mention of the pacing feature or the fan-out send feature ship with its
   required disclosure/disclaimer constant from `@wp/domain`'s copy module in
   the same file?
7. Any evasion-adjacent mechanism (number rotation, proxy pool,
   fingerprinting, auto-resume after restriction)? -> hard reject.
8. Does it add a cross-project or upward package dependency? -> hard reject.
9. Are metrics/audit entries added for the new state transition?
10. Tests: verbatim green output attached, including the
    concurrency/idempotency case?
11. New metric: inventory entry + manifest regenerated + label rule
    respected?
