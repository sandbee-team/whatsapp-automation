# P04 — auth-signup-and-onboarding

**Goal (one line):** a real person signs up (name, phone, email, company), gets a workspace with a provisioned wallet in **one** transaction, logs in with argon2id + lockout + rotating refresh + TOTP, and walks an entitlement-gated onboarding wizard that stops at Connect.
**Status:** P04a done (2026-08-27) · P04b done (2026-08-27) · **Size:** L — split executed at the declared line · **Session:** P04a = 1 session (done); P04b = 1 session (done)
**Depends on:** P02 (must be `done`); P00, P01 transitively
**Blocks:** P05, P08

**Size warning (L).** Declared split line, use it the moment the session clock bites:
**P04a = steps 1-6** (migration → contracts → signup transaction → login/lockout → sessions/`token_epoch` → TOTP);
**P04b = steps 7-10** (entitlement gate → onboarding step machine → minimum frontend → Playwright e2e).
If you split, add a `P04a` row to `plan/README.md` at C7 and write the P04b next-session prompt instead of P05's.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 + mailpit up via `infra/compose/docker-compose.dev.yml`; `ROLE=migrate` runner works.
- P02's tenancy schema is applied and green: `users`, `clients`, `memberships` (+ `memberships_one_workspace_per_user_uq`), `auth_sessions`, `invites`, `api_keys`, `audit_logs`, `plans`/`plan_limits`, and the ADR 0019 §1 wallet/pricing tables `wallet_accounts`, `wallet_ledger` (+ its non-partitioned `external_ref` side table), `client_pricing`, `price_lists`, `price_list_items`.
- A **seeded default price list** exists with per-kind paise items (`text`, `media`, `group_text`, `group_media`). Values are placeholders until the founder sets them (ADR 0019 §11, founder open item 1) — read them from the seed, never hard-code.
- `@wp/server-kit` envelope crypto + the `user-secrets` KEK purpose exist (P01) and are mounted **api only**.
- RLS `FORCE` is on, the four Postgres roles exist, isolation suite A runs and is green.
- ADRs 0017, 0019, 0020 accepted; `.claude/rules/core-invariants.md` and the safety-compliance skill are binding.
- Carried from P02: a 23505 on `memberships_one_workspace_per_user_uq` (and on `clients_slug_key`/`users_email_key`) is a cross-tenant existence oracle — map to a generic "this account is already part of a workspace" style message; never name the other workspace (reviewer N17).
- Carried from P02: the signup transaction MUST set `wallet_accounts.max_rate_minor` explicitly from the seeded default price list (the column has CHECK > 0 and deliberately NO default) and INSERT `client_pricing` — see ADR 0019 §1 and migration 0004.
- Carried from P02: `scripts/check-role-boot.ts` activates for real here — every new `app/backend/src/roles/**` entrypoint (except migrate.ts) must call `assertDbPreconditionsOrExit` before serving.

## What you are building (3-6 bullets)
- The **one-transaction signup**: `users` → `clients` → `memberships(owner)` → `wallet_accounts` (with `max_rate_minor` from the seeded default price list) → `client_pricing` → `wallet_ledger(signup_credit, external_ref='signup:<client_id>')` → `audit_logs`. All or nothing.
- Login and session security: argon2id (19 MiB / t=2 / p=1), constant-time dummy verify, account + IP limits, lockout 5 → 15 min → exponential, 15-minute access token, rotating refresh cookie with reuse detection, `token_epoch` revocation, TOTP mandatory for `owner`.
- The **server-side entitlement gate**: an unverified / incomplete-onboarding client cannot reach Connect or send. Not a hidden button.
- The `clients.onboarding_step` machine (`verify_email → choose_timezone → accept_pacing_profile → attest_consent → connect_whatsapp → send_test → done`) with its routes and its audited consent attestation.
- The **minimum** `app/frontend` bootstrap needed to run signup/verify/login/wizard end-to-end in Playwright. No design system, no SSE, no i18n — P05 owns those and will replace the placeholder styling.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | `Security, tenant isolation & encryption → Auth` (incl. revocation honesty [R-35]) |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | `Data model → Tenancy` + `Onboarding [R-56]` |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | `Surfaces` (what `app/frontend` is allowed to be) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | `Schema delta → Tenancy` (the signup transaction, verbatim) |
| ADR | `.memory/decisions/0017-v1-scope-expansion-and-single-workspace-tenancy.md` | §5 (one user = one workspace) |
| ADR | `.memory/decisions/0019-wallet-and-per-message-metering.md` | §1 (`max_rate_minor` set in the signup transaction, NO DEFAULT, CHECK > 0) |
| Design | `.memory/research/2026-08-25-v1-design-data-and-security.md` | `users` / `memberships` / `auth_sessions` column tables; §"Auth" bullets (argon2id params, lockout ladder, rotation) |
| Design | `.memory/research/2026-08-25-v1-design-repo-structure.md` | §1.2 `app/backend` tree, §1.3 `app/frontend` tree, §2.2 dependency rules |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/api.md`, `.claude/rules/database.md` | all |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | honest claims (onboarding copy) |

## Dispatch plan (written 2026-08-27 at session open, per SESSION-PROTOCOL E1)

**Split invoked at open: this session = P04a (steps 1-6).** P04b (steps 7-10) is its own session —
`app/frontend` is an empty stub (no Vite config, no router dep, no Playwright anywhere in the repo), so
the wizard/frontend/e2e half cannot fit in the same sitting.

Ground-truth corrections found at open (live DB + tree inspected; the phase file predates P03):
- Migrations end at **0012** (disk and `schema_migrations` agree). Step 1's file is
  `db/migrations/0013_auth_and_onboarding.sql`, not 0004 (0004 is P02's wallet/pricing).
  `EXPECTED_SCHEMA_VERSION` (`db/src/schema-version.ts`) bumps 12 → 13 in the same unit.
- Prerequisite line 15 is WRONG about P02: `auth_sessions`, `invites`, `api_keys`, `audit_logs` do NOT
  exist (verified live). 0013 creates `auth_sessions` + `audit_logs` (P04 needs both); `invites`/`api_keys`
  stay with their owning phases (feature-phase migration rule, scope delta).
- The isolation allow-list is `ISOLATION_NON_TENANT_TABLES` in `db/src/isolation/tenant-tables.ts` —
  `db/isolation/non-tenant-tables.ts` does not exist.
- app/backend integration tests are colocated `src/**/*.integration.test.ts` (P03 convention;
  `app/backend/tests/**` does not exist). Test case names from "Tests that prove it" are kept verbatim.
- `app/backend/src/platform/config.ts` does not exist yet — it is created (not "changed") in UA3.
- HTTP stack per canon/ADR 0002: Fastify + `@orpc/server@^1.15.0` against `@wp/contracts`' oRPC router.
- Deps installed at session open: fastify, @orpc/server, @fastify/cookie, jose, otplib, @node-rs/argon2
  (prebuilt — repo bans install scripts), ioredis, nodemailer (app-backend); libphonenumber-js (contracts).

Units (one unit = one dispatch; UA1 contains the migration and runs ALONE):
- **UA1** `db-engineer` — step 1: migration 0013, allow-list rows with reasons, schema-version bump 12→13,
  structural tests, applied to dev DB.
- **UA2** `implementer` — step 2: `packages/contracts` auth + onboarding (oRPC contracts, zod, error codes).
- **UA3** `implementer` — step 3: one-transaction signup (service + identity/provisioning repos +
  `platform/config.ts`) + the 4 signup tests + 2 memberships tests. Runs ∥ UA2 (disjoint trees).
- **UA4** `implementer` — step 4 minus HTTP: `password.ts` (argon2id 19456/2/1), `login.service.ts`
  (dummy verify, lockout ladder), `platform/redis.ts`, `platform/http/rate-limit.ts` (token bucket core).
- **UA5** `implementer` — steps 5+6 services: `session.service.ts` (rotation, reuse-detection),
  `token-epoch.ts` (PG authority, Redis cache, miss = ask PG), `totp.service.ts` (sealed secret, recovery
  codes, replay rejection).
- **UA6** `implementer` — the HTTP surface of steps 4-5: `main.ts`, `roles/api.ts`
  (assertDbPreconditionsOrExit — check-role-boot activates here), `platform/http/{auth-plugin,route-policy}`,
  error mapper, `identity.routes.ts`; boot-fails-without-policy test; real-429-with-headers test.
- P04b (next session): UB1 entitlement gate + onboarding machine (steps 7-8), UB2 frontend bootstrap +
  copy file + check-copy (step 9), UB3 Playwright e2e (step 10).

## P04b dispatch plan (written 2026-08-27 at session open, per SESSION-PROTOCOL E1)

Ground-truth corrections found at open (live DB + tree inspected):
- O2 quick gate green at open; migrations end at 0015, EXPECTED_SCHEMA_VERSION 15 (verified live). No new
  migration planned for P04b.
- minio container crash-loops on invalid MINIO_ROOT_USER/PASSWORD env — unrelated (P04b has no media
  surface); left for an infra fix outside this phase. postgres/redis/mailpit healthy.
- NOTHING ever sets clients.status 'pending_verification' → 'active' (verified: no such UPDATE in
  app/backend/src). The entitlement gate requires status='active', so verify-email gains a conditional
  activation (pending_verification only; suspended/closed never resurrected). Filed as a deviation/decision
  note for C6.
- auth_sessions has NO mfa column and P04b adds no migration, so the carried mfa:true claim hook persists
  MFA-across-refresh via a Redis marker keyed by sessionId (miss/error = mfa false, fail closed — user
  re-does TOTP after a Redis flush). Durable column deferred to P08 if its surface needs it.
- The Connect stub needs a 501 code: NOT_IMPLEMENTED added to contracts errors.ts (401/403 deny vs
  "entitled but P08 not built" must be distinguishable, honestly).
- UB1 as prompted exceeds the ~400-line unit bound and touches session/auth invariants → split at dispatch:
  **UB1a** (implementer) carried identity items: mfa:true claim hook (createSession/refresh + Redis marker),
  recovery-code login route + contract, totpLockoutDurationMs dedup, getMeForUser BEGIN READ ONLY,
  verify-email client activation, wp_app proof extension.
  **UB1b** (implementer, after UB1a): entitlement.service + platform/http/guards.ts + stub POST
  /v1/instances (policy session_mfa) + NOT_IMPLEMENTED code, onboarding.service/.routes/repo fns,
  onboardingContract wired into appContract, tenancy wp_app-role proof test, phase-named tests.
- UB2 (ui-implementer, ∥ UB1a/UB1b — disjoint trees): Vite/React19 + TanStack Router/Query scaffold,
  same-origin /v1 proxy (SameSite=Strict cookie), routes signup/verify-email/login/totp/onboarding,
  features/{auth,onboarding}, packages/domain/src/copy/onboarding.ts (SAFE_MODE_DISCLAIMER literal
  co-present, ban-risk disclosure per open item 23, generic 23505 copy), copy test, red→green check-copy
  proof (COPY_GLOBS already scans packages/** — no check-copy edit expected).
- UB3 (implementer, after UB1b+UB2): Playwright config + webServers (api :3000 via node --env-file
  .secrets/dev.env, vite :5173), mailpit API 127.0.0.1:8025 for the verify link, otplib-generated TOTP
  codes from the displayed enrol secret, the two named e2e cases; root vitest must not pick up e2e specs.
- UB1c (db-engineer, added mid-session from UB1a deviation 4; MIGRATION UNIT — runs ALONE after UB1b+UB2):
  migration 0016 granting wp_app DELETE on mfa_recovery_codes (enrolConfirm deletes unused codes; 0014
  granted only SELECT/INSERT/UPDATE, so TOTP enrolment fails in production under wp_app+FORCE RLS),
  schema-version 15→16, grants snapshot regenerated via documented --update, wp_app proof extended to
  enrolConfirm.

### P04b actuals (running list — this is the reviewer's diff)
- `plan/README.md` — changed (main session): P04b row → in-progress

UB1a (green; app-backend test:int 29 files/119 tests (was 27/114), contracts 3 files/35 tests, typecheck + format + lint + depcruise + tenant-scope + guards:meta green; one mid-run API rate-limit kill, resumed cleanly after disk-state verification):
- `app/backend/src/modules/identity/session-mfa-marker.ts` — created (Redis mfa marker write/read/delete, fail-closed: miss/error = mfa false)
- `app/backend/src/modules/identity/session-internal.ts`, `session-logout.ts` — created (max-lines cohesion splits; logout() pure move)
- `app/backend/src/modules/identity/totp-recovery.routes.ts` — created (POST /v1/auth/totp/recovery: mfaToken + jti single-use + IP/account rate limit + lockout-ladder feed + generic errors; createSession mfa:true)
- `session.service.ts` — changed (CreateSessionInput.mfa; marker write in createSession, carry-forward + best-effort DEL in refresh); `session-reuse.ts` — changed (signAccessToken optional mfa claim); `totp.routes.ts` — changed (/totp/verify passes mfa:true)
- `login.service.ts` — changed (lockoutDurationMs exported, canonical); `routes-shared.ts` — changed (totpLockoutDurationMs = re-export alias; InvalidRecoveryCodeError → VALIDATION_ERROR)
- `tenancy-scoped.repo.ts` — changed (getMeForUser BEGIN READ ONLY; new activateClientIfPending); `identity.repo.ts` — changed (re-export); `verify-email.service.ts` — changed (conditional client activation pending_verification→active in the SAME tx; never resurrects suspended/closed)
- `identity.routes.ts` — changed (wires recovery routes)
- `packages/contracts/src/auth.ts`, `src/index.ts`, `tests/auth.test.ts` — changed (totpRecoveryContract + schemas + tests)
- `packages/contracts/package.json` — changed (stale types field ./dist/index.d.ts → ./dist/src/index.d.ts; pre-existing repo bug)
- tests: `__tests__/totp-recovery.integration.test.ts`, `__tests__/session-mfa-claim.integration.test.ts` — created; `session.integration.test.ts` trimmed (pure move); `identity-under-wp-app-role.integration.test.ts` — extended (activation + recovery login under wp_app) + REAL BUG FIXED: wrapAsRole only matched literal BEGIN, so BEGIN READ ONLY would silently run as superuser; helper extracted to `__tests__/wp-app-role-test-support.ts`
- Deviations filed: (1) verify-email activation = decision candidate for C6; (2) wrapAsRole regex bug fixed; (3) contracts package.json types fix (domain twin left to UB2 scope); (4) OPEN → migration unit: migration 0014 grants wp_app only SELECT/INSERT/UPDATE on mfa_recovery_codes but enrolConfirm issues DELETE — TOTP enrolment would fail in production under wp_app+FORCE RLS; needs migration 0016 (runs alone, after UB1b/UB2); (5) recovery HTTP route test written alongside impl (storage/session layers were red-first)
- Incidental: two stray zero-byte root files error.log/out.log deleted (blocked check-tree; not ours)

UB2 (green; domain 7 files/25 tests, check-copy 328 files/0 violations with red→green proof, typecheck/lint/format/depcruise/tenant-scope/guards:meta green, vite build green; one mid-run API rate-limit kill, resumed cleanly):
- `packages/domain/src/copy/onboarding.ts` — created (ONBOARDING_COPY frozen: all wizard/auth strings; SAFE_MODE_DISCLAIMER literal co-present; ban-risk disclosure per open item 23; consent attestation statement; generic 23505 duplicate-account copy)
- `packages/domain/tests/copy/onboarding-copy.test.ts` — created RED-first (`onboarding_copy_contains_no_banned_claims_and_carries_the_disclaimer`)
- `packages/domain/src/index.ts` — changed (export ONBOARDING_COPY)
- `app/frontend/` — created: vite.config.ts (same-origin /v1 proxy → :3000), index.html, src/main.tsx, src/app.tsx, src/styles/base.css, src/lib/api-client.ts (in-memory access token, one-shot refresh retry), src/providers/query-client.ts, src/routes/{__root,index,signup,login,verify-email,totp,onboarding}.tsx, src/features/auth/{api,index,components×5}, src/features/onboarding/{api,index,wizard,components×6}, src/routeTree.gen.ts (generated; lint/prettier-ignored)
- `app/frontend/package.json` — changed (react 19, TanStack router/query, react-hook-form, resolvers, zod, vite + plugins; dev/build/preview scripts); `app/frontend/tsconfig.json` — changed; `src/index.ts` repurposed placeholder
- `.prettierignore`, `packages/config/eslint.config.js` — changed (ignore routeTree.gen.ts)
- `packages/domain/tsconfig.json`, `packages/contracts/tsconfig.json` — changed (rootDir src, tests out of include) + `packages/contracts/package.json` types → ./dist/index.d.ts — ROOT-CAUSE FIX of the P04a open item "contracts tsconfig rootDir/dist-shape mismatch" (dist now flattens; supersedes UB1a's interim types-path fix; both verified consistent)
- Deviation: none (file-based routing worked; no check-copy.ts change needed — packages/** already scanned)
- Open for later units/phases: recovery-code login UI (contract exists, no UI requested), P05 replaces placeholder CSS

UB1b (green; app-backend test:int 32 files/125 tests (was 29/119), contracts 3/35, typecheck/format/lint/depcruise/tenant-scope/guards:meta green):
- `app/backend/src/modules/tenancy/entitlement.service.ts` — created (assertCanConnect/assertCanSend; fail-closed: email_verified_at → EMAIL_NOT_VERIFIED, status → FORBIDDEN client_not_active, step < connect_whatsapp → FORBIDDEN onboarding_incomplete:<current step>)
- `app/backend/src/modules/tenancy/onboarding.repo.ts`, `onboarding.service.ts`, `onboarding.routes.ts` — created (monotonic conditional UPDATEs advancing step + writing columns in one statement; 0 rows → CONFLICT with currentStep; consent writes audit_logs in the SAME tx via the existing allow-listed helper; GET + 3 POSTs policy session)
- `app/backend/src/platform/http/guards.ts` — created (thin requireCanConnect/requireCanSend)
- `app/backend/src/modules/instances/{instances.routes.ts,index.ts}` — created (stub POST /v1/instances, policy session_mfa scope instances:create, entitlement-gated, honest 501 NOT_IMPLEMENTED; NOT in the browser contract — P08 adds the real one)
- `packages/contracts/src/errors.ts` — changed (+NOT_IMPLEMENTED 501); `src/router.ts` — changed (onboardingContract wired into appContract)
- `modules/tenancy/index.ts`, `platform/http/server.ts` (BuildAppDeps + registration), `roles/api.ts` — changed
- tests: tenancy `__tests__/{entitlement,onboarding,onboarding-under-wp-app-role}.integration.test.ts` + `tenancy-routes-test-support.ts` + module-local `wp-app-role-test-support.ts` — created; all 6 named cases pass incl. `the_full_onboarding_and_entitlement_chain_works_as_wp_app` (with two-tenant interference sanity)
- wp_app grant gaps for this surface: NONE (clients UPDATE/audit INSERT/users read covered by 0005/0013)
- Deviations filed: (1) roles/api.ts hasTotpEnrolled is a local inline query mirroring identity/mfa.repo (authDepsFrom not on identity public surface; identity/** untouchable this unit); (2) wp_app proof seeds activation via 2 superuser UPDATEs (activation itself proven under wp_app in identity proof); (3) per-module wrapAsRole duplicate to respect no-deep-module-import

UB1c (green; db 20 files/92 tests, app-backend test:int 32 files/125, typecheck/format/lint/depcruise/tenant-scope/guards:meta green) — closes UB1a deviation 4:
- `db/migrations/0016_mfa_recovery_codes_delete_grant.sql` — created (GRANT DELETE ON mfa_recovery_codes TO wp_app; enrolConfirm delete-then-insert failed in prod under wp_app+FORCE RLS; grants verified live before/after: SELECT,INSERT,UPDATE → +DELETE; schema_migrations 15 → 16)
- `db/src/schema-version.ts` — changed: EXPECTED_SCHEMA_VERSION 15 → 16
- `db/schema/grants.snapshot.json` — regenerated via documented --update (diff = exactly the new row)
- `db/tests/mfa-recovery-codes-schema.test.ts` — extended (`wp_app_holds_exactly_select_insert_update_delete_on_mfa_recovery_codes`; asserted post-apply — getMigratedPool always migrates to HEAD, so no pre-state exists in-suite; the red proof was the task-1 live psql check)
- `identity-under-wp-app-role.integration.test.ts` + `wp-app-role-test-support.ts` — extended (runEnrolConfirmAsWpApp wraps both ctx.db and ctx.pool; stale gap-flag comment removed; file compacted to 297 lines for max-lines)
- NOTE: migrations now end at 0016 / EXPECTED_SCHEMA_VERSION 16 (supersedes the P04a carried line)

UB3 (STOPPED THE LINE per E2 — real app bug found, debugger dispatched; e2e scaffolding complete and left in place):
- `app/frontend/playwright.config.ts` — created (chromium; two-server webServer: api ROLE=api w/ env parsed from .secrets/dev.env + vite :5173; baseURL http://localhost:5173)
- `app/frontend/tests/e2e/support.ts` — created (mailpit polling, signup/login helpers, otplib TOTP helpers)
- `app/frontend/tests/e2e/signup-onboarding.spec.ts` — created (both named cases; written to the VERIFIED MFA flow: TOTP enrol/confirm does NOT upgrade the current session to mfa:true — a second login + /totp/verify is required, matching the backend's own mintMfaAccessTokenViaHttp helper)
- `app/frontend/package.json` — changed (+@playwright/test, +otplib devDeps; test:e2e script); `pnpm-lock.yaml` updated; chromium installed
- Root vitest needs NO exclude (spec.ts does not match the *.test.ts include globs — verified); no data-testid additions needed; ci-steps.ts untouched
- BUG FOUND (real, user-facing; deterministic repro ×2): verify-email-panel.tsx fires the single-use POST /v1/auth/verify-email TWICE under React 19 StrictMode dev (effect double-invoke; cleanup flag only guards setState, not the request); replay 400 can win the render → genuine first visit to the emailed link can show the invalid-link state. Backend confirmed correct (verify1 200, verify2 400). → debugger dispatched (shared-promise-per-token fix; backend and StrictMode untouched)
- UX NOTE carried to C1/C6: enrolConfirm verifies a code inline but does not mint an mfa session — the wizard flow needs a re-login + /totp/verify before Connect; consider minting fresh tokens at enrol-confirm (P05 candidate)

DEBUG-1 (green; fix verified at the network level — exactly ONE POST /v1/auth/verify-email → 200 in the Playwright trace; unit test 4/4; typecheck/format/lint/depcruise/tenant-scope/guards:meta green):
- `app/frontend/src/features/auth/components/once-per-token.ts` — created (onceForKey: module-level Map sharing one in-flight/settled promise per resource key; module state survives StrictMode remount, refs do not)
- `app/frontend/src/features/auth/components/verify-email-panel.tsx` — changed (verify call wrapped in onceForKey(token, ...); cancelled flag now only guards setState, correctly)
- `app/frontend/src/features/auth/components/once-per-token.test.ts` — created (4 deterministic cases)
- `.memory/lessons/2026-08-27-strictmode-double-effect-consumes-single-use-token.md` — created + MEMORY.md indexed
- SECOND BUG of the same class found (out of DEBUG-1 scope, filed): totp-enrol-panel.tsx fires POST /v1/auth/totp/enrol twice (no guard) racing the just-set Bearer token (both 401 → failed refresh → bounced to /login); double-enrol also risks showing secret A while the DB pending secret is B → confirm would fail. → DEBUG-2 dispatched

DEBUG-2 (green; positive e2e case PASSES end-to-end 1/1 in 4.0s incl. the 501 Connect assertion; unit tests 8/8; typecheck/format/lint/depcruise/tenant-scope/guards:meta green):
- ROOT CAUSE of the 401s: page.goto('/totp') is a hard navigation that reloads the SPA and wipes the in-memory access token — the first enrol 401s legitimately and retry-once-after-refresh recovers; the REAL defects were (a) apiFetch's 401→refresh path had no shared in-flight promise, so two concurrent 401s fired parallel refreshes and the loser tripped the backend's (correct) rotation reuse detection, revoking the whole chain; (b) the enrol effect had no promise-sharing guard under StrictMode
- `app/frontend/src/lib/api-client.ts` — changed (one shared refreshInFlight promise across concurrent 401s)
- `once-per-token.ts` — changed (+evictOnRejection option, default false so verify-email single-use semantics unchanged); `totp-enrol-panel.tsx` — changed (onceForKey guard, evictOnRejection true = retryable)
- `app/frontend/src/lib/api-client.test.ts` — created (shared-refresh proof); `once-per-token.test.ts` — extended (7 total)
- Trace proof: ONE logical enrol attempt (401 → one refresh 200 → retried enrol 200), no bounce to /login
- Lesson file appended (second section: parallel 401 retries must share one refresh promise or rotation reuse-detection kills the chain); MEMORY.md line updated

UB3 resume (green — UNIT COMPLETE): full e2e suite 2/2 passed (8.3s): `signup_to_onboarding_complete_reaches_connect` 4.0s, `an_unverified_account_cannot_reach_connect` 2.1s (route-guard half: no connect button while wizard-verify-email shows; API half: direct POST /v1/instances with a captured mfa:true Bearer → 403 EMAIL_NOT_VERIFIED). E3 evidence via its gate: `pnpm run test:unit` 48 files/324 tests passed (6.69s), e2e specs confirmed NOT picked up by vitest; typecheck/format clean; lint + depcruise (291 modules, 0 violations) + tenant-scope (137 files, 0) + guards:meta (16 guards) green. Deviation carried: TOTP enrol/confirm does not upgrade the session — e2e implements the real two-login flow matching the backend's mintMfaAccessTokenViaHttp helper.

## Ordered minimum steps
- [x] 1. **Additive migration** for what auth needs and P02 did not create → `db/migrations/0004_auth_and_onboarding.sql`: `email_verification_tokens (id, user_id, token_hash bytea UNIQUE, expires_at, consumed_at, created_at)`, `password_reset_tokens` (same shape), `users.token_epoch int NOT NULL DEFAULT 0` (**Postgres is the authority; Redis is the cache**), `clients.consent_attested_at`, `clients.consent_attested_by_user_id`, `clients.pacing_profile_key text`, `clients.pacing_profile_accepted_at`. Add both new tables to the isolation suite A **non-tenant allow-list with written reasons** (they key on `user_id`, like `users`/`auth_sessions`) → `db/isolation/non-tenant-tables.ts`.
- [x] 2. **Contracts before handlers**: Zod schemas + error codes for signup, verify-email, login, TOTP challenge, refresh, logout, `me`, and the onboarding step calls → `packages/contracts/src/auth.ts`, `packages/contracts/src/onboarding.ts`, exported from `packages/contracts/src/index.ts`. `full_name`, `phone_e164` (libphonenumber, validate-and-replace), `email` (citext-safe lowercase), `company_name`.
- [x] 3. **The signup transaction** (dispatch `db-engineer` for the SQL, `implementer` for the service) → `app/backend/src/modules/identity/signup.service.ts`, `app/backend/src/modules/identity/identity.repo.ts`, `app/backend/src/modules/tenancy/provisioning.repo.ts`. Seven writes, one transaction, `max_rate_minor = max(price_list_items.unit_minor)` of the seeded default list — if that read returns nothing, the transaction **throws**; it never inserts 0 or NULL. Signup credit amount and low-balance threshold come from `platform/config.ts`.
- [x] 4. **Password + login + lockout + rate limits** → `app/backend/src/modules/identity/password.ts` (argon2id 19456 KiB / t=2 / p=1, rehash-on-login), `login.service.ts`, `identity.routes.ts`, `app/backend/src/platform/http/rate-limit.ts` (Redis token bucket at IP and account scope, strictest wins, real 429 + headers). Unknown email performs a dummy verify.
- [x] 5. **Sessions, rotation and revocation** → `app/backend/src/modules/identity/session.service.ts` (15-min access JWT carrying `token_epoch`; refresh token hashed in `auth_sessions` with `parent_session_id`; reuse of a rotated token revokes the whole chain + audit + email), `token-epoch.ts` (Redis cache, **Postgres fallback on miss — never treat a miss as valid**), `app/backend/src/platform/http/auth-plugin.ts`, `app/backend/src/platform/http/route-policy.ts` (a route registered without an explicit auth policy **and** scope fails at boot).
- [x] 6. **TOTP, mandatory for `owner`** → `app/backend/src/modules/identity/totp.service.ts`. Secret sealed with the `user-secrets` KEK via `@wp/server-kit`'s envelope service into `users.mfa_totp_secret_enc`; enrolment, verify, one-time recovery codes (hash only), used-code replay rejection inside the window.
- [x] 7. **Entitlement gate, server-side** → `app/backend/src/modules/tenancy/entitlement.service.ts` exposing `assertCanConnect(ctx)` / `assertCanSend(ctx)` (client `status='active'` **and** email verified **and** `onboarding_step` at or past `connect_whatsapp`), wired into `app/backend/src/platform/http/guards.ts` and applied to a stub `POST /v1/instances` route that P08 will fill in. Fail-closed: unknown state denies.
- [x] 8. **Onboarding step machine + routes** → `app/backend/src/modules/tenancy/onboarding.service.ts`, `onboarding.routes.ts`. Monotonic, ordered advancement only; `choose_timezone` writes `clients.timezone` (IANA validated); `accept_pacing_profile` writes `clients.pacing_profile_key` + `pacing_profile_accepted_at` (**`pacing_profiles` does not exist until P13 — record the key, do not FK it**); `attest_consent` writes the two `clients` columns **and** an `audit_logs` row naming the attesting user.
- [x] 9. **Minimum frontend to run the flow** → `app/frontend/src/main.tsx`, `app/frontend/src/routes/{signup,verify-email,login,totp,onboarding}.tsx`, `app/frontend/src/features/auth/api.ts`, `app/frontend/src/features/onboarding/api.ts` + `wizard.tsx`. All user-facing strings live in `packages/domain/src/copy/onboarding.ts` and must include the ban-risk disclosure and `SAFE_MODE_DISCLAIMER`; `scripts/check-copy.ts` must match this file with a non-zero count.
- [x] 10. **Playwright acceptance** → `app/frontend/tests/e2e/signup-onboarding.spec.ts` driving real signup → mailpit verification link → login → TOTP → wizard → Connect enabled, plus the negative path. Run `scripts/ci.ps1` and paste the verbatim tail.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/tests/integration/identity/signup.test.ts` | `signup_creates_user_client_membership_wallet_pricing_and_credit_in_one_transaction` | exactly one row in each of the 6 tables + 1 `audit_logs` row, all with the same `client_id` |
| `app/backend/tests/integration/identity/signup.test.ts` | `signup_rolls_back_completely_when_the_wallet_insert_fails` | injected failure → zero `users`, zero `clients`, zero `wallet_ledger` rows |
| `app/backend/tests/integration/identity/signup.test.ts` | `no_wallet_accounts_row_has_max_rate_minor_zero` | `SELECT count(*) FROM wallet_accounts WHERE max_rate_minor <= 0` = 0 after 50 signups |
| `app/backend/tests/integration/identity/signup.test.ts` | `signup_fails_loudly_when_the_default_price_list_is_missing` | throws a typed error; no partial rows |
| `app/backend/tests/integration/tenancy/memberships.test.ts` | `a_second_membership_for_a_user_is_rejected_at_the_database` | raw INSERT violates `memberships_one_workspace_per_user_uq` (23505), not an app check |
| `app/backend/tests/integration/tenancy/memberships.test.ts` | `signup_with_an_existing_email_creates_no_second_workspace` | zero new `clients` rows, typed 409, no membership written |
| `app/backend/tests/integration/identity/login.test.ts` | `unknown_email_login_does_a_dummy_verify_and_returns_the_same_error` | identical error code/shape; timing within the agreed band |
| `app/backend/tests/integration/identity/login.test.ts` | `five_failures_lock_the_account_for_fifteen_minutes_and_audit_it` | `locked_until` set, 6th attempt denied while locked, one audit row |
| `app/backend/tests/integration/identity/rate-limit.test.ts` | `login_route_returns_a_real_429_with_headers` | status 429 + `retry-after` + limit headers (not a configured-but-inert limiter) |
| `app/backend/tests/integration/identity/session.test.ts` | `reused_refresh_token_revokes_the_whole_chain` | every session in the chain has `revoked_at` + reason; next refresh 401 |
| `app/backend/tests/integration/identity/session.test.ts` | `logout_bumps_token_epoch_and_the_old_access_token_is_rejected` | 401 before the 15-min TTL expires |
| `app/backend/tests/integration/identity/session.test.ts` | `a_token_epoch_cache_miss_reads_postgres_instead_of_accepting_the_token` | Redis flushed mid-test → still rejected after logout |
| `app/backend/tests/integration/identity/totp.test.ts` | `owner_without_totp_cannot_reach_a_protected_route` | 403 with the enrol-required error code |
| `app/backend/tests/integration/identity/totp.test.ts` | `totp_secret_is_never_stored_in_plaintext` | `mfa_totp_secret_enc` bytes contain no base32 secret substring; round-trip decrypts |
| `app/backend/tests/integration/identity/totp.test.ts` | `a_used_totp_code_cannot_be_replayed_within_its_window` | second submit of the same code fails |
| `app/backend/tests/contract/route-policy.test.ts` | `a_route_registered_without_an_auth_policy_fails_to_register_at_boot` | boot throws naming the offending route |
| `app/backend/tests/integration/tenancy/entitlement.test.ts` | `unverified_client_cannot_reach_the_connect_endpoint` | 403 from the server even with a valid session and the UI bypassed |
| `app/backend/tests/integration/tenancy/onboarding.test.ts` | `onboarding_steps_advance_only_in_order_and_never_backwards` | out-of-order advance is rejected; step is monotonic |
| `app/backend/tests/integration/tenancy/onboarding.test.ts` | `connect_whatsapp_is_unreachable_until_timezone_profile_and_attestation_are_recorded` | each missing prerequisite denies, with the reason in the error |
| `app/backend/tests/integration/tenancy/onboarding.test.ts` | `consent_attestation_writes_an_audit_row_naming_the_user` | one `audit_logs` row with `actor_user_id` and the attested timestamp |
| `packages/domain/tests/copy/onboarding-copy.test.ts` | `onboarding_copy_contains_no_banned_claims_and_carries_the_disclaimer` | `BANNED_CLAIMS` scan (en + hi) clean; `SAFE_MODE_DISCLAIMER` co-present with any pacing claim |
| `app/frontend/tests/e2e/signup-onboarding.spec.ts` | `signup_to_onboarding_complete_reaches_connect` | mailpit link → login → TOTP → wizard → Connect enabled |
| `app/frontend/tests/e2e/signup-onboarding.spec.ts` | `an_unverified_account_cannot_reach_connect` | route guard **and** a direct API call both deny |
| `db/tests/isolation/suite-a.test.ts` | `new_auth_tables_are_on_the_non_tenant_allow_list_with_reasons` | suite A stays green and the two new tables carry non-empty reasons |

Mandatory-suite tests this phase makes green: **none** of the numbered send-path/engine suite (1-23) — that suite starts at P03/P06. This phase contributes to the blueprint's *"Isolation, security and copy suites"*: the real-429 rate-limit test for the auth route class, the `copy_contains_no_banned_claims` extension (en + hi), and the isolation suite A allow-list rows. It also makes the scope delta's tenancy test `a_second_membership_for_a_user_is_rejected_at_the_database` green.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).
- P04a (steps 1-6): every DoD item satisfied for its scope — C5 ci green (verbatim tail in .memory/sessions/2026-08-27-P04a-auth-and-sessions.md), reviewer final verdict APPROVED-with-notes, C3 invariant check clean, files list complete in "P04a actuals". P04b (steps 7-10): every DoD item satisfied — C5 gate green 2026-08-27 18:22 ("CI GREEN — all 12 steps passed"; integration step: db 20 files/92 tests, app-backend 38 files/149 tests; verbatim tail in .memory/sessions/2026-08-27-P04b-wizard-frontend-e2e.md), reviewer verdict APPROVED-with-notes (all 3 MAJORs + 4 MINORs fixed in-session via FIXF, both C2 bugs fixed against unmodified red tests), C3 clean (written above), e2e 2/2 green, files list complete in "P04b actuals".

## Files created or changed this session
<!-- expected list; correct it as you go — the reviewer reviews exactly this list -->

### P04a actuals (running list — this is the reviewer's diff)
UA1 (green; db suite 18/18 files, 86/86 tests; tenant-scope + guards:meta green):
- `db/migrations/0013_auth_and_onboarding.sql` — created (users auth cols + token_epoch; clients consent/pacing cols; auth_sessions; email_verification_tokens; password_reset_tokens; audit_logs partitioned m08-m10, append-only grants, RLS FORCE)
- `db/tests/auth-onboarding-schema.test.ts` — created (incl. `new_auth_tables_are_on_the_non_tenant_allow_list_with_reasons`)
- `db/schema/auth.ts`, `db/schema/audit-logs.ts` — created (drizzle mirrors)
- `db/schema/tenancy.ts`, `db/schema/index.ts`, `db/schema/custom-types.ts` — changed (column mirrors, table registry, inet type)
- `db/src/schema-version.ts` — changed: EXPECTED_SCHEMA_VERSION 12 → 13
- `db/src/isolation/tenant-tables.ts` — changed: 4 allow-list rows with reasons (audit_logs: client_id nullable for platform actions; RLS still scopes tenant reads)
- `db/schema/grants.snapshot.json` — regenerated via the snapshot test's documented `--update` process
- `db/src/partitions.ts` — changed (main session, trivial tier): `audit_logs` added to MONTHLY_PARTITIONED_TABLES (closes UA1's carried item); `tests/partitions.test.ts` 7/7 green

UA2 (green; contracts 3 files/28 tests, typecheck clean, guards green):
- `packages/contracts/src/auth.ts` — created (field schemas + 9 oRPC contracts as `authContract`)
- `packages/contracts/src/onboarding.ts` — created (7-label step enum, IANA timezone schema, 4 contracts as `onboardingContract`)
- `packages/contracts/src/errors.ts` — changed: +ACCOUNT_LOCKED 403, MFA_REQUIRED 401, MFA_ENROLL_REQUIRED 403, EMAIL_NOT_VERIFIED 403
- `packages/contracts/src/index.ts` — changed: flat re-exports
- `packages/contracts/tests/auth.test.ts`, `tests/onboarding.test.ts` — created
- OPEN → UA6: wire `authContract`/`onboardingContract` into `appContract` (`router.ts`) when the routes land

UA3 (green; identity 4/4 + tenancy 2/2, full test:int 10 files/55 tests, typecheck + guards green):
- `app/backend/src/platform/config.ts` — created (zod, frozen, only process.env reader; SIGNUP_CREDIT_MINOR placeholder 10000 pending founder pricing)
- `app/backend/src/platform/mailer.ts` — created (nodemailer port; mailpit dev; send strictly after COMMIT)
- `app/backend/src/modules/identity/identity.repo.ts` — created (SQL-only: insertUser, insertEmailVerificationToken)
- `app/backend/src/modules/identity/signup.service.ts` — created (one tx via @wp/db withTenant; SignupConflictError generic 23505 mapping incl. slug retry-once; DefaultPriceListMissingError; ledger kind `signup_credit`)
- `app/backend/src/modules/tenancy/provisioning.repo.ts` — created (SQL-only, 8 inserts/reads; `-- client_id = $n` guard comments documented in header)
- `app/backend/src/modules/identity/__tests__/signup.integration.test.ts` — created (4 named cases)
- `app/backend/src/modules/tenancy/__tests__/memberships.integration.test.ts` — created (2 named cases)
- NOTE for session log: ids use `randomUUID()` (v4) per P03 precedent — canon comment in 0002 says uuidv7; divergence carried, needs a one-line decision at close

UA4 (green; app-backend 13 files/66 tests, password unit 4/4, typecheck + guards green):
- `app/backend/src/modules/identity/password.ts` — created (argon2id via @node-rs/argon2, injectable params; ONE production-cost test)
- `app/backend/src/modules/identity/login.service.ts` — created (dummy verify, lockout ladder 5→15m doubling capped 24h, rehash-on-login, post-commit lockout email)
- `app/backend/src/platform/redis.ts` — created (ioredis named import; fail-fast opts; test-only resolveRedisUrl)
- `app/backend/src/platform/http/rate-limit.ts` — created (atomic Lua token bucket, strictest-wins, consume-all-or-none, fail-closed scopes)
- `app/backend/src/modules/identity/identity.repo.ts` — extended (7 login/lockout SQL fns)
- `app/backend/src/platform/config.ts` — extended (ARGON2_*, AUTH_LOCKOUT_*, RATE_LIMIT_AUTH_*)
- tests: `__tests__/password.test.ts`, `__tests__/login.integration.test.ts`, `platform/http/__tests__/rate-limit.integration.test.ts` — created
- Unit-split note (E1): UA5 re-sized at dispatch into UA5a (sessions/token-epoch/verify-email) + UA5b (migration 0014 mfa_recovery_codes + TOTP) — recovery codes need a table 0013 did not create

UA5a (green; backend test:int 15 files/72 tests, typecheck + guards green):
- `app/backend/src/modules/identity/session.service.ts` — created (createSession, refresh w/ rotation + whole-chain reuse revocation + post-commit alert email, logout w/ epoch bump)
- `app/backend/src/modules/identity/token-epoch.ts` — created (Redis cache, PG authority; miss/error → PG, never valid-on-miss; validateAccessToken jose HS256 + epoch)
- `app/backend/src/modules/identity/verify-email.service.ts` — created (conditional-UPDATE consume; email_verified_at; onboarding_step verify_email→choose_timezone monotonic-safe)
- `app/backend/src/modules/identity/identity.repo.ts` — extended (14 SQL fns incl. recursive chain walk)
- `app/backend/src/platform/config.ts` — extended (ACCESS_TOKEN_TTL_MIN 15, REFRESH_TOKEN_TTL_DAYS 30, AUTH_JWT_SECRET prod-throw guard, EPOCH_CACHE_TTL_SEC)
- tests: `__tests__/session.integration.test.ts` (4), `__tests__/verify-email.integration.test.ts` (2) — created; all three phase-named session cases green

UA5b (green after one API-drop resume; db 19 files/89 tests, totp 4/4, typecheck + guards green):
- `db/migrations/0014_mfa_recovery_codes.sql` — created (user-keyed, mirrors 0013 conventions; code_hash UNIQUE; used_at one-time claim)
- `db/src/schema-version.ts` — changed: 13 → 14
- `db/src/isolation/tenant-tables.ts`, `db/schema/auth.ts`, `db/schema/index.ts` — changed (allow-list row, drizzle mirror, registry)
- `db/schema/grants.snapshot.json` — regenerated via documented --update
- `db/tests/mfa-recovery-codes-schema.test.ts` — created
- `app/backend/src/modules/identity/totp.service.ts` — created (seal/open user-secrets purpose; otplib v13 functional API; Redis SETNX replay rejection fail-closed; recovery codes hash-only, storage-layer one-time)
- `app/backend/src/modules/identity/identity.repo.ts` — extended (5 TOTP SQL fns)
- `app/backend/src/platform/config.ts` — extended (TOTP_WINDOW, TOTP_USED_CODE_TTL_SEC, KEY_RING_PATH prod-throw guard)
- `app/backend/src/modules/identity/__tests__/totp.integration.test.ts` — created (4 named cases)
- REVIEW NOTES (C1): otplib v13 rewrite (no authenticator singleton; window→epochTolerance×30s); local SealedBlob↔bytea base64-JSON codec (no repo-canonical codec existed); AAD clientId constant 'users' for non-tenant records (real binding = recordId); enrolConfirm verifies inline, verify() gates on mfa_enabled_at

UA6 (green; backend test:int 18 files/81 tests, route-policy unit 1/1, typecheck + guards green, role-boot 2 files/0 violations):
- `app/backend/src/main.ts`, `src/roles/api.ts` — created (ROLE boot; assertDbPreconditionsOrExit before listen; graceful shutdown)
- `app/backend/src/platform/http/{route-policy,auth-plugin,error-mapper,server}.ts` — created (fail-closed registration w/ policy+scope, MFA semantics, envelope + rate-limit headers)
- `app/backend/src/modules/identity/identity.routes.ts`, `index.ts` — created (9 routes, contract-validated Fastify — oRPC node adapter NOT used, deviation filed; refresh cookie httpOnly/Secure/SameSite=Strict path=/v1/auth)
- `app/backend/src/platform/config.ts` — extended (MFA_TOKEN_TTL_MIN 5)
- `packages/contracts/src/router.ts` — changed (authContract wired into appContract; onboarding deliberately un-wired until P04b)
- tests: `platform/http/__tests__/route-policy.test.ts`, `modules/identity/__tests__/identity-routes.integration.test.ts` — created (429-with-headers, owner-without-TOTP 403 via stub session_mfa route, e2e-over-HTTP, contract-parity structural)
- REVIEW NOTES (C1): 2 inline read-only SQL queries in identity.routes.ts pending promotion to identity.repo.ts; createSession lacks an mfa:true claim hook (needed by P04b session_mfa routes); packages/contracts dist rebuilt + flattened (pre-existing tsconfig rootDir/output-shape mismatch — open item); roles/api.ts uses a local nodemailer transport for lockout/reuse alerts instead of extending the Mailer port

E3 (test-runner): unit suite 299/300 — one 5s-timeout flake in scripts/guards/eslint-guards.test.ts under parallel-agent load; isolated rerun 6/6 green in 1.7s; file untouched by this diff (lesson candidate: tight per-test timeout under load).

C2 (test-engineer; all green, no seed mutation): +7 edge tests — concurrent same-email signup (one winner, zero partial rows), rollback injected at the LAST write, ext-refs 23505 proof, concurrent verify-email consume (one wins), limiter atomicity 10-parallel-vs-capacity-3, lockout expiry boundary (locked_until==now → expired), 2 MiB body → 413 with zero DB rows, 100k-char email schema bound. Plus a DETERMINISTIC repro of the refresh-rotation race (`two_concurrent_refreshes_of_the_same_valid_token_produce_at_most_one_new_session`, `it.fails` pending FIXA). test:int 18 files / 88 passed + 1 expected-fail; guards all green, every guard non-zero matches.

FIXA (green; db 20 files/91 tests, backend test:int 20 files/98 tests, typecheck + guards green) — closes C1 CRITICALs 1-2 + majors 7-10, 12, 13:
- `db/migrations/0015_identity_definer_helpers.sql` — created (`wp_client_id_for_user` SECURITY DEFINER per 0006 conventions; EXECUTE wp_app only); `db/src/schema-version.ts` 14→15; `db/schema/grants.snapshot.json` regenerated via --update; `db/tests/identity-definer-helpers-schema.test.ts` — created
- `app/backend/src/modules/identity/__tests__/identity-under-wp-app-role.integration.test.ts` — created (THE RLS PROOF: full identity flow green under SET LOCAL ROLE wp_app + FORCE RLS)
- identity.repo.ts / login.service.ts / session.service.ts / verify-email.service.ts / token-epoch.ts / signup.service.ts / provisioning.repo.ts — changed: GUC set via setAppClientId (definer-resolved clientId) inside the existing single transactions; refresh() revoke-first claim gate (C2's race repro now a passing plain `it`); reuse sweep bumps token_epoch + writes (not DELs) epoch cache, fill is SET NX; SAVEPOINT slug retry; login denies non-active status post-verify (no oracle); ladder doubling/cap/no-increment-while-locked tests added; ALLOWED_AUDIT_METADATA_KEYS filter implemented (honesty claim now true)
- `app/backend/src/modules/tenancy/__tests__/provisioning.repo.test.ts` — created
- Deviation filed: withTenant not nested — same GUC primitive applied on the already-open transaction to preserve single-tx atomicity across non-tenant+tenant writes; tenant-db.ts untouched
- Carried to FIXB: wire SessionCtx.epochCacheTtlSec from config in routes
- Lesson candidate: check-tenant-scope's literal-text heuristic mis-pairs quotes/apostrophes in doc comments across function boundaries (2nd occurrence this session)

FIXB (green; backend test:int 21 files/111 tests, contracts 32/32, typecheck + guards green) — closes C1 CRITICALs 3-4 + majors 5, 6, 11 + minors 14-20:
- config.ts: +TRUST_PROXY (default false), PORT, ROLE, DEFAULT_PRICE_LIST_KEY; server.ts trustProxy config-driven + onRoute mechanical policy check; route-policy.ts sets config{policy,scope} + exports assertRoutePolicyConfig; error-mapper.ts request-id regex + redacted unknown-error logging; mailer.ts port +sendLockoutEmail/sendReuseDetectedEmail (roles/api.ts second transport deleted); main.ts/roles/api.ts env via config
- totp.service.ts: MfaAlreadyEnrolledError on re-enrol (both routes); enrolConfirm atomic (delete-unused → set-enabled → insert-10)
- identity.routes.ts: /totp/verify rate-limited (IP+account, failClosed) + jti single-use (SET NX, fail-closed) + wrong codes feed the lockout ladder (locked denies correct code); account RL keys sha256-hashed (no raw email in Redis — scan-tested); epochCacheTtlSec wired; fetchBasicUser/fetchMeRow promoted to identity.repo.ts
- contracts auth.ts: login password plain length bound (no pre-dummy-verify oracle)
- new/extended tests: route-policy (bare app.get fails boot), error-mapper unit, totp enrol atomicity, XFF-ignored-at-default, totp-verify 429+headers, jti replay, key-scan
- Deviations filed: totpLockoutDurationMs formula duplicated in routes (login.service helper private, out of scope); deleteUnusedMfaRecoveryCodes added beyond pure promotion (needed for atomicity)
- Remaining REVIEW minors filed, not fixed: verifyRecoveryCode route needs a contract addition (→ P04b); structured logger (→ P05); contracts tsconfig rootDir/dist-shape mismatch (open item)

C1 re-review (scoped to fixes; live DB probe + targeted test runs): 12/13 findings CLOSED with file:line evidence. **1 residual CRITICAL**: FIXB's M20a promotion left `fetchMeRow` (memberships+clients join) on the bare pool with no GUC → `/v1/auth/me` 401s for every user under wp_app+FORCE RLS; invisible to tests because route tests boot on the superuser pool. +4 warnings (writeEpochCache non-monotonic SET can pin a lower epoch; /totp/verify continuation skips users.status re-check; race test asserts ≤1 not ==1; locked-denies-correct-code test submits a wrong code) +3 suggestions (ladder-formula parity test; mail-failure logs carry PII via err.message; SAVEPOINT never released). Verdict: REJECTED pending finding 1 → FIXC dispatched (all 8 items).

FIXC (green; backend test:int 23 files/114 tests, typecheck + guards green) — closes the residual CRITICAL + all re-review warnings/suggestions:
- identity.repo.ts +getMeForUser (self-scoping tx: findClientIdForUser → setAppClientId → fetchMeRow); /me route calls only it; wp_app proof test extended — verified red-then-green by temporarily neutralizing the fix
- Bare-pool sweep: /me was the ONLY remaining bare-pool caller of RLS tables; all other paths already GUC-scoped
- token-epoch.ts writeEpochCache now monotonic Lua CAS (+token-epoch.integration.test.ts: 5-then-3 → 5); /totp/verify re-checks users.status pre-code; race test exact-1/1; locked-denies test uses a real generated code; +lockout-ladder.integration.test.ts parity test; mail-failure logs {name, code} only (3 files); RELEASE SAVEPOINT on both success paths

### Carried into P04b (binding)
- Wire onboardingContract into appContract when its routes land
- Add the mfa:true claim hook to session.service createSession (session_mfa routes need it)
- getMeForUser → BEGIN READ ONLY
- Add a recovery-code login route + contract (verifyRecoveryCode currently unreachable)
- Export/share totpLockoutDurationMs instead of the duplicated formula
- Frontend is an empty stub (no Vite/router/Playwright anywhere; mailpit UI/API 127.0.0.1:8025; SameSite=Strict cookie needs http://localhost origin)
- NEW unit-end guard command is `pnpm run lint && pnpm run guards:depcruise && pnpm run check:tenant-scope && pnpm run guards:meta`
- Migrations now end at 0015 / EXPECTED_SCHEMA_VERSION 15

C1 final verdict (third pass, scoped to FIXC): **APPROVED-with-notes** — all 8 items verified closed with file:line evidence + live test runs; GUC confirmed transaction-local (no pool leak). Notes filed: (W) 4th mail-catch in signup.service.ts logged err.message → FIXED in-session by main session (trivial tier, {name, code} only, signup+token-epoch tests 10/10 green); (S) stale writeEpochCache comment → FIXED same pass; (S) `BEGIN READ ONLY` for getMeForUser → carried to P04b.
- `app/backend/src/modules/identity/signup.service.ts`, `token-epoch.ts` — changed (main session): the two note fixes above; repo-wide `pnpm run format` pass run before the C5 gate

C5 attempt 1: FAILED at step 2/12 (lint) — 36 errors in this session's files that the per-unit guard command never saw: `guards:meta` only asserts matched-file COUNTS, it does not execute eslint. BINDING LESSON (carry to P04b speed rules): every unit ends with `pnpm run lint && pnpm run check:tenant-scope && pnpm run guards:meta` (~6s cached). Error classes: raw `wp:` Redis key literals outside platform/redis (tenantKey()/sysKey() builders didn't exist — first Redis usage in repo), max-lines >300 (identity.repo 801, identity.routes 677, session.service 411, totp.service 388, 4 test files), 3× no-plain-set in identity.repo, 1 dead assignment. → FIXD dispatched: behavior-preserving remediation (create sysKey/tenantKey in platform/redis, cohesion splits preserving public surfaces + transaction boundaries, pure-move test splits, zero new eslint-disables).

FIXD (green; lint 0 errors/0 warnings, test:int 27 files/114 tests — exact count parity, typecheck + tenant-scope + guards green) — behavior-preserving lint remediation:
- `app/backend/src/platform/redis/keys.ts` — created (sysKey/tenantKey; the guard's exemption glob is directory-shaped `**/platform/redis/**` — flat redis.ts re-exports, caller imports unchanged)
- identity.repo.ts 801→291 via barrel + pure moves to new `auth-sessions.repo.ts`, `tenancy-scoped.repo.ts`, `mfa.repo.ts`; identity.routes.ts 677→46 via `routes-shared.ts` + `auth.routes.ts` + `totp.routes.ts`; session.service.ts 411→297 via `session-reuse.ts`; totp.service.ts 388→296 via `totp-secret.ts`
- test splits (pure moves, zero cases dropped): identity-routes-{auth,hardening,totp}.integration.test.ts + identity-routes-test-support.ts (replaces 691-line file, deleted); login/login-lockout; signup/signup-rollback
- raw `wp:` literals → sysKey() in token-epoch.ts, totp.service.ts, routes, 5 test files — key strings byte-identical (exact-string assertions green)
- no-plain-set root cause: UPDATE…SET line-format false positive — SQL reformatted, rule untouched; auth-plugin dead assignment removed; zero new eslint-disables

C5 attempt 2: FAILED at step 3/12 (depcruise) — 2 pre-existing no-deep-module-import violations attempt 1 never reached (signup.service → tenancy/provisioning.repo cross-module deep import; tenancy test → identity/signup.service). Fixed by main session (small tier): created `app/backend/src/modules/tenancy/index.ts` (public surface, `export * as provisioningRepo`), signup.service imports tenancy via index, identity/index.ts additionally exports signup + types, memberships test imports via identity/index. Depcruise standalone: 0 violations (227 modules); typecheck clean; affected tests 7/7 green.
- `app/backend/src/modules/tenancy/index.ts` — created; `signup.service.ts`, `identity/index.ts`, `tenancy/__tests__/memberships.integration.test.ts` — changed (imports only)

C1 verdict (initial): **REJECTED** — 4 CRITICAL (1: identity path unproven/broken under wp_app RLS — membership/clients/audit access needs clientId resolution + withTenant + a wp_app-role proof test; 2: refresh-rotation lost-update race mints two live sessions, revoke-first claim gate required; 3: trustProxy:true makes IP rate limits spoofable via XFF incl. unlimited public argon2 hashes; 4: /totp/verify brute-forceable — no rate limit/attempt counter, replayable mfaToken), 9 major (TOTP re-enrol w/o re-auth; enrolConfirm not transactional + code accumulation; reuse doesn't bump epoch; epoch cache-fill race pins logout ≤1h; slug retry dead code (25P02); login ignores users.status; email PII in RL keys; ladder doubling/cap untested; audit metadata allow-list claim unimplemented), 9 minor (PORT/ROLE env reads; x-request-id echo; stack logging; price-list key hard-code; login password schema oracle; onRoute mechanical enforcement; verifyRecoveryCode unreachable; console logging; layering debts). Fix loop: FIXA (svc/repo: C1+C2 criticals + majors 7-10,12,13 → incl. migration 0015 definer helper), then FIXB (HTTP/TOTP: criticals 3-4 + majors 5,6,11 + ride-along minors), then scoped re-review of fixes only.
- `db/migrations/0004_auth_and_onboarding.sql` — created
- `db/isolation/non-tenant-tables.ts` — changed: two allow-list rows with reasons
- `packages/contracts/src/auth.ts`, `packages/contracts/src/onboarding.ts` — created
- `packages/contracts/src/index.ts` — changed: export the two namespaces
- `packages/domain/src/copy/onboarding.ts` — created
- `app/backend/src/modules/identity/{signup,login,session,totp}.service.ts`, `password.ts`, `token-epoch.ts`, `identity.repo.ts`, `identity.routes.ts`, `index.ts` — created
- `app/backend/src/modules/tenancy/{provisioning.repo,entitlement.service,onboarding.service}.ts`, `onboarding.routes.ts`, `index.ts` — created
- `app/backend/src/platform/http/{auth-plugin,route-policy,rate-limit,guards}.ts` — created
- `app/backend/src/platform/config.ts` — changed: signup credit, low-balance threshold, token TTLs, argon2 cost profile
- `app/backend/src/roles/api.ts` — changed: register identity + onboarding routes and the plugins
- `app/frontend/src/main.tsx`, `src/routes/*.tsx`, `src/features/{auth,onboarding}/*` — created
- `app/backend/tests/integration/identity/*.test.ts`, `tests/integration/tenancy/*.test.ts`, `tests/contract/route-policy.test.ts` — created
- `app/frontend/tests/e2e/signup-onboarding.spec.ts` — created
- `packages/domain/tests/copy/onboarding-copy.test.ts` — created
- `scripts/check-copy.ts` — changed: include `packages/domain/src/copy/**` (must report a non-zero match count)

C2 (test-engineer; +6 test files/+24 tests over the new invariant surface — app-backend test:int now 38 files/149 tests: 147 green, 2 correctly RED on real bugs handed to FIXF):
- created: tenancy `__tests__/{onboarding-edge-cases,onboarding-boundary-cases,entitlement-edge-cases}.integration.test.ts`, identity `__tests__/{session-mfa-refresh-race,totp-recovery-edge-cases,verify-email-edge-cases}.integration.test.ts`
- GREEN edges: concurrent double-advance (timezone + consent, exactly one wins/one audit row), replay conflicts with state unchanged, two-tenant under concurrent load, consent crash-mid-tx rolls back atomically, oversized/empty boundary inputs, all entitlement permutations (suspended/closed even when fully onboarded; every pre-connect step names its reason; nonexistent ids deny without throwing), redis-down refresh drops mfa but refresh succeeds, concurrent same-recovery-code = one session, cross-user recovery code = generic failure, concurrent-suspend before activation stays suspended
- BUG 1 (= C1 M1 root cause): profileKey control chars pass zod → PG 22021 → raw 500 instead of clean 400; red test `a_profile_key_with_control_characters_is_rejected_at_validation_before_any_db_touch`
- BUG 2 (new): session-reuse.ts revokeChainAsReuseDetected never deletes mfa markers of revoked session ids (marker lives until TTL); red test `two_concurrent_refreshes_of_an_mfa_session_the_winner_still_carries_mfa_true_and_no_revoked_session_id_is_left_marked`
- skipped with reasons: clock edges (no date math on this surface); fake enum label injection (impossible without unsafe cast, would not exercise real behavior)

FIXF (green — closes C1 MAJORs 1-3 + MINORs 1-4 + C2 bugs 1-2; app-backend test:int 38 files/149 tests ALL green, e2e 2/2 (11.6s), contracts 9/9, copy test green, typecheck/format/lint/depcruise/tenant-scope/guards:meta green):
- `packages/contracts/src/onboarding.ts` — changed (profileKey → ^[a-z0-9_-]{1,64}$ machine-identifier regex; 'safe_default' passes); `tests/onboarding.test.ts` — extended (+5 cases)
- `session-reuse.ts` — changed (revokeChainAsReuseDetected returns revokedSessionIds); `session.service.ts` — changed (post-commit finally best-effort deleteMfaMarker for every revoked chain id — same AFTER-commit block as email/epoch side effects; never throws)
- `packages/domain/src/copy/onboarding.ts` — changed (+stepUnavailableError, +notEntitledBody)
- frontend: `accept-pacing-profile-step.tsx`, `attest-consent-step.tsx` — copy-only error branching (no backend string reaches the UI); `features/onboarding/api.ts` — connectInstance maps ONLY success/NOT_IMPLEMENTED to not_available, rethrows the rest; `connect-whatsapp-step.tsx` — honest error state via COPY.notEntitledBody, setNotAvailable out of finally; `once-per-token.ts` — unbounded-map doc note; `lib/api-client.ts` — refresh transport-throw → false (ApiError-only contract preserved); `api-client.test.ts` — +transport case
- backend tests: `wp-app-role-test-support.ts` — rollback/release on throw; `onboarding-under-wp-app-role.integration.test.ts` — step-2 comment reworded
- NUL byte: verified already clean in the final split files (byte-scan 0 hits; rg text-matches confirm scannable)
- Both formerly-RED C2 bug tests now green without test modification

### P04b C1 verdict
**APPROVED-with-notes** (opus reviewer, full P04b diff). Zero CRITICAL. All 10 verify-dont-trust claims CONFIRMED with file:line evidence (step machine = true single conditional UPDATEs, no TOCTOU — the 0-rows re-read shares the same tx snapshot; entitlement fail-closed on every path incl. unknown enum; consent audit atomic + ids-only; mfa marker post-commit + never valid-on-miss, TTL matches session; recovery route no-oracle + storage one-time; activation conditional; stub gated both halves; copy byte-identical disclaimer + honest ban-risk disclosure; 0016 = exactly one grant). 3 MAJOR (fixed in-session, FIXF below): M1 raw NUL byte 0x00 in onboarding-edge-cases test (file invisible to rg-based guards) + pass-either-way control-char test + file missing from actuals → tighten profileKey contract to ^[a-z0-9_-]+$ and assert hard 400; M2 accept-pacing-profile-step.tsx + attest-consent-step.tsx render raw ApiError.message (bypasses copy pipeline/check-copy) → copy-only branching + COPY.stepUnavailableError; M3 connectInstance bare catch maps EVERY error to not_available (entitlement denial misreported as unbuilt product) → branch on NOT_IMPLEMENTED, surface others + COPY.notEntitledBody. 4 MINOR (ride-along in FIXF): once-per-token unbounded-map doc note; api-client refresh transport-throw → return false (preserve ApiError-only contract); runEnrolConfirmAsWpApp connection leak on throw; overstated comment in tenancy wp_app proof step 2. Notes (no action): 5 pre-filed findings assessed, none CRITICAL; localhost Secure-cookie caveat documented so nobody drops `secure`; wrapAsRole regex fix was a genuine RLS-proof hole, now closed.

### P04b C3 invariant check (main session, written while C1/C2 ran)
1. durable-first: PASS — no send path touched; POST /v1/instances is an entitlement-gated 501 stub, sends nothing.
2. fail-safe: PASS — entitlement denies on missing rows/unknown enum/query error; mfa marker miss or Redis error → mfa=false (re-do TOTP, never falls open); recovery + totp-verify rate limits and jti claims fail closed; verify-email never resurrects suspended/closed clients.
3. idempotency at storage: PASS — every onboarding advance is one conditional UPDATE WHERE onboarding_step = expected; recovery codes one-time via used_at storage claim; mfa jti SET NX; the one-workspace unique stays a DB fact.
4. tenant isolation: PASS — no new tables (0016 is a grant); onboarding/entitlement paths GUC-scoped and proven under wp_app + FORCE RLS (tenancy proof + identity proof extended to enrolConfirm); two-tenant interference asserted.
5. pause preserves work: PASS (n/a) — no queue/claim surface touched; nothing new can strand a job.
6. no evasion: PASS — no rotation/proxy/fingerprint/auto-resume anywhere; copy has zero banned claims (check-copy red→green proof, 328 files), SAFE_MODE_DISCLAIMER co-present, ban-risk disclosure per open item 23, no capacity/speed numbers, generic 23505 copy (no workspace oracle).
7. tests are evidence: PASS — verbatim outputs in this actuals section (unit 48/324, int 32/125, db 20/92, e2e 2/2); C5 full-gate tail to follow in the session log.

### P04b C4 structure check (main session)
- All 16 guards green with non-zero matched counts at every unit end; final proof = the single C5 gate run.
- No file outside the ADR 0014 tree; depcruise 0 violations (291 modules) so no deep module imports; no raw db.select outside platform/db; no OFFSET pagination introduced; no float money (no money surface this phase).
- No new tenant tables (isolation suite A unchanged); every new route registered via registerRoute with policy+scope (mechanical onRoute check + boot-throw test); no new metrics; every new copy string inside the check-copy scan (proven red→green).
- Nothing half-finished undocumented — carried items written below (recovery-code UI, enrol-confirm does not mint an mfa session (P05 UX), structured logger → P05, mfa marker is Redis-volatile → durable column only if P08 needs it, minio env fix is infra housekeeping outside the phase).

## Risks / gotchas specific to this phase
- **`max_rate_minor` is the trap.** ADR 0019 §1 gives it NO DEFAULT and `CHECK (> 0)`. If the seeded price list is missing or empty, the natural code path inserts NULL/0 and the whole client silently cannot claim later (P19's `balance_minor >= max_rate_minor` predicate). Read the seed inside the transaction and throw on empty — there is a named test for exactly this.
- **The signup transaction is seven writes; a partial signup is unrecoverable by hand.** One `BEGIN`, one `COMMIT`, no `catch` that swallows a mid-way failure, no "create the user first and the wallet later".
- **One workspace per user is a database fact, not a service rule.** Do not add an application pre-check that returns a nice error and lets the index rot untested; catch `23505` and map it. `dropping_memberships_one_workspace_per_user_uq_breaks_no_test_except_that_one` (scope delta §Tenancy) stays true.
- **argon2id at 19 MiB × parallel tests** will make the suite slow or OOM a CI container. Put the cost profile in `platform/config.ts`, run the production parameters in **one** dedicated test, and use a reduced profile elsewhere. Never weaken the production default to make tests fast.
- **`SameSite=Strict; Secure` refresh cookie in Playwright**: serve the e2e over `http://localhost` (a secure context) or the cookie is silently dropped and the failure looks like a broken login, not a cookie policy.
- **`token_epoch` on a Redis miss must fail closed.** A miss means "go ask Postgres", never "assume valid" — otherwise the blueprint's revocation honesty claim [R-35] becomes false and P05's "SSE drops within 5 s" is a lie.
- **`pacing_profiles` does not exist until P13.** Store `clients.pacing_profile_key` as text with no FK, and write the carry-forward line into P13's file at C4 so the link-up is not left in someone's head.
- **Entitlement is server-side.** Greying out the Connect button is UI courtesy; the 403 is the control. Both are tested.
- **Safety boundary in onboarding copy:** the wizard is the first place a customer reads a claim about pacing. Never "ban-proof", "safe", "guaranteed delivery", or "prevents restrictions". The accepted wording is Safe Mode *reduces the risk of triggering spam or rate-limit signals from sending too fast or too cold; it cannot prevent or guarantee against WhatsApp restrictions*, plus the blueprint's open item 23 disclosure that the restriction risk lands on the tenant's own number with no appeal path. No capacity or speed number appears anywhere in this phase's copy — nothing is measured until P26.
- **Do not build what P05 owns**: no design tokens, no `@wp/ui` primitives, no SSE, no i18n plumbing. If a step starts pulling those in, stop — it is P05 leaking backwards.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P05 — panel-shell-and-sse. Read plan/v1/P05-panel-shell-and-sse.md and follow it exactly:
one phase, one session. Deps P04a AND P04b are done (verify both rows in plan/README.md; set P05 to
in-progress as your claim marker). Do not start P06.

Open with SESSION-PROTOCOL O1-O3 (quick gate: pnpm run typecheck && pnpm run guards:meta). Execute as
work units per the phase file's dispatch plan, TDD red-first, agent roster per CLAUDE.md; the main
session pastes canon content verbatim into dispatch texts — subagents never open .memory/research/**.

BINDING from P04b's close (full detail in the phase file's P04b actuals; lessons in
.memory/lessons/2026-08-27-strictmode-double-effect-consumes-single-use-token.md):
1. EVERY unit dispatch ends with: pnpm run lint && pnpm run guards:depcruise &&
   pnpm run check:tenant-scope && pnpm run guards:meta (guards:meta alone runs no eslint).
2. Any new route/service touching FORCE-RLS tables gets wp_app-role proof coverage
   (identity/tenancy *-under-wp-app-role tests are the pattern; wrapAsRole helpers exist).
3. Migrations end at 0016, EXPECTED_SCHEMA_VERSION 16 — verify live before any schema work.
4. app/frontend now exists: Vite + React 19 + TanStack file-based router (routeTree.gen.ts is
   generated and lint/prettier-ignored), TanStack Query, react-hook-form + contract zodResolvers,
   same-origin /v1 proxy (SameSite=Strict cookie — never call :3000 absolutely), in-memory access
   token with ONE shared refresh promise, once-per-token effect guards (StrictMode double-fire
   lesson), placeholder CSS that P05 REPLACES with @wp/ui + design tokens. Playwright e2e (2 cases)
   exists and must stay green.
5. Carried UX/debt for P05: enrol-confirm does not mint an mfa session (user must re-login before
   session_mfa routes — fix or design around it); recovery-code login has a contract+route but no UI;
   structured logger (carried since P04a); dedupe roles/api.ts inline hasTotpEnrolled with
   identity/mfa.repo; mfa marker is Redis-volatile by design (flush = re-do TOTP, fail-closed).
6. All user-facing strings from packages/domain copy modules (check-copy proves it); zero banned
   claims; SAFE_MODE_DISCLAIMER co-presence rule.

Stop at the FIRST red test and dispatch debugger; a unit past ~20 minutes gets split. Close with
SESSION-PROTOCOL C1-C7: C1 and C2 in parallel, ONE full gate at C5 (pnpm run ci); at C7 write P06's
next-session prompt.
```
