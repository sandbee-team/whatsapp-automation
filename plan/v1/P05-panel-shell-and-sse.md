# P05 — panel-shell-and-sse

**Goal (one line):** a logged-in person sees a real, honest, empty WP dashboard rendered from `@wp/ui` + `@wp/design-tokens` in en/hi, holding one authenticated per-tenant SSE stream that carries ids only and drops within 5 s of a membership or `token_epoch` revocation.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Depends on:** P04 (must be `done`) — transitively P00-P03
**Blocks:** P08 (QR over the tenant SSE channel), P15 (outbox → SSE fan-out), P17 (instance card)

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; migrations applied; `scripts/ci.ps1` green on the tree as you found it (SESSION-PROTOCOL O2).
- P04 shipped: login, `auth_sessions`, refresh rotation, and the per-user **`token_epoch`** revocation check (Redis + JWT claim) that this phase's 5-second drop depends on. If `token_epoch` is not readable per user, stop — this phase cannot honestly meet its demo.
- `memberships` exists with `memberships_one_workspace_per_user_uq`; `TenantContext` and `runInTenant()` exist in `@wp/server-kit` (P01).
- `@wp/contracts`, `@wp/domain` (browser-clean), `@wp/utils`, `@wp/config` and every `scripts/ci` guard exist from P00.
- ADRs 0014, 0017, 0020 accepted. **Honesty note:** `0007` and `0010` still read `Status: proposed`; their design-system and SSE-not-WebSocket content is nonetheless the canon this phase implements (ADR 0014 supersedes only 0007's *surface split*). Do not re-decide the transport, and do not silently edit an ADR header — if the status genuinely blocks you, raise it at O3 as a one-line `/decide`.

## What you are building (3-6 bullets)
- `@wp/design-tokens` (DTCG → `tokens.css` + Tailwind preset, Devanagari fallbacks in the token set) and `@wp/i18n` (`en`/`hi`, `t()`, English fallback + a missing-key counter).
- `@wp/ui`: the small primitive set the next ten phases compose from, token-only, axe-clean, `'use client'` on every interactive component.
- `app/frontend`: React 19 + Vite SPA shell — TanStack Router (`_authed` guard), TanStack Query client, providers, `AppShell`, and an **honest empty dashboard** that promises nothing.
- `app/backend` `modules/realtime`: an in-process SSE hub and `GET /v1/events` served by `ROLE=api` — `client_id` locked from the session, per-tenant channel authorisation at connect, heartbeat frames, `Last-Event-ID` resume, bounded per-connection buffer.
- Continuous re-authorisation: a batched ≤5 s tick that drops any connection whose membership vanished or whose `token_epoch` moved.
- `app/frontend/src/lib/sse.ts`: one connection per session, backoff reconnect, events mapped to TanStack Query key invalidations (hint-then-refetch — the payload is never the data).

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | **Real-time & notifications** (the event/payload table), **Surfaces**, and the revocation-honesty note `[R-35]` in the security section |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | **Observability (one rule, not two)** — ids only in payloads, labels, logs; four-gauge label allow-list |
| ADR | `.memory/decisions/0010-realtime-and-notifications.md` | all (SSE, ids-only payloads, outbox, escalation triggers) |
| ADR | `.memory/decisions/0007-frontend-monorepo-and-design-system.md` | "Design system" + "Layering" only (surface split superseded by 0014) |
| ADR | `.memory/decisions/0014-repo-structure-shared-packages-and-conventions.md` | binding rules 4-6 |
| Design | `.memory/research/2026-08-25-v1-design-repo-structure.md` | §4 "Inside each frontend" (folder rules, data fetching, token pipeline), §2 package table |
| Design | `.memory/research/2026-08-25-v1-design-data-and-security.md` | the tenant-context-per-entrypoint table — realtime row: channel `client:{client_id}:instance:{instance_id}`, re-authorised on membership change |
| Invariants | `.claude/rules/core-invariants.md` | all (4 and 7 bite here) |
| Path rules | `.claude/rules/api-*.md` | all |
| Protocol | `plan/SESSION-PROTOCOL.md` | O1-O3, E1-E3, C1-C7 |

## P05 dispatch plan (written 2026-08-27 at session open, per SESSION-PROTOCOL E1)

Ground-truth corrections found at open (live DB + tree inspected):
- O2 quick gate green (typecheck exit 0; guards:meta 16 guards, all non-zero). Migrations end at 0016, EXPECTED_SCHEMA_VERSION 16, live `schema_migrations` max = 16. postgres/redis/mailpit healthy; minio still crash-loops (unrelated, carried).
- `memberships` and `clients` are FORCE RLS; the api runs as `wp_app`. The authz tick's ONE batched cross-tenant read therefore needs a SECURITY DEFINER helper in the 0015 pattern → **migration 0017** (`wp_realtime_authz_snapshot(uuid[])`), db-engineer, runs ALONE.
- NO `instances` table exists until P08 → instance-channel authorisation is a port (`InstanceOwnershipPort`) whose production default is fail-closed (`false`); tests inject a stub. P08 wires the real repo.
- `EventSource` cannot carry the Bearer token, and the refresh cookie is a ONE-SHOT rotating token scoped to `/v1/auth` — it cannot and must not authenticate `/v1/events`. Decision: the SSE client is a `fetch()` stream with `Authorization: Bearer` (same `registerRoute` policy `session` as every panel route), custom SSE parser, `Last-Event-ID` header, full-jitter backoff. No token in any URL, no ticket route. Recorded as an ADR at C6.
- Tailwind v4 is CSS-first: the "Tailwind preset" is an `@theme` CSS file generated from the DTCG source, plus a typed TS token map. tsc owns `packages/design-tokens/dist`, so generated files live at `packages/design-tokens/css/{tokens.css,tailwind-theme.css}` + `src/tokens.generated.ts` (deviation from the literal `dist/` paths, same content).
- Root vitest only includes `*.test.ts`; React tests need `*.test.tsx` globs + per-file `@vitest-environment jsdom` (U1 adds the globs).
- Carried P04b UX: enrol-confirm mints no mfa session → DESIGNED AROUND: every P05 surface (`/v1/events`, dashboard, `me`) is policy `session`; Connect (P08) keeps the re-login flow; carried to P08. Recovery-code login UI is added in U5 (contract + route already exist).

Units:
- **U0** (db-engineer, ALONE): migration 0017 definer helper + schema version 17 + grants snapshot + db test.
- **U1** (implementer, ∥ U3a): steps 1, 2 + the two guards from step 3 (design-tokens build, i18n, check-no-raw-hex, check-ui-client-directive, ci-steps + registry + vitest tsx globs, Devanagari banned claims).
- **U3a** (implementer, ∥ U1): step 4 + step 5 (realtime contract, domain channel/assert-ids-only, hub, sse.ts, GET /v1/events, route tests).
- **U4** (ui-implementer, after U1, ∥ U3b): step 3 primitives + a11y test.
- **U3b** (implementer, after U0 + U3a, ∥ U4): step 6 authz tick, metrics, revocation tests, suite B, log redaction, wp_app proof, hasTotpEnrolled dedupe.
- **U5** (ui-implementer, after U4 + U3a): steps 7, 8, 9 + recovery-code UI + Playwright stays green.

### P05 actuals (running list — this is the reviewer's diff)
- `plan/README.md` — changed (main session): P05 row → in-progress
- `plan/v1/P05-panel-shell-and-sse.md` — changed (main session): status, dispatch plan, actuals

U0 (green; db 21 files/96 tests; lint/depcruise(298 modules, 0)/tenant-scope(137, 0)/guards:meta(16)/typecheck clean; live schema_migrations 16 → 17 verified):
- `db/migrations/0017_realtime_authz_snapshot.sql` — created (SECURITY DEFINER `wp_realtime_authz_snapshot(uuid[])` → (user_id, token_epoch, client_id, client_status); owner wp_admin_app, pinned search_path, REVOKE PUBLIC, EXECUTE → wp_app only; 0015 conventions)
- `db/src/schema-version.ts` — changed: EXPECTED_SCHEMA_VERSION 16 → 17
- `db/tests/realtime-authz-snapshot.test.ts` — created (4 cases incl. proof that a plain memberships SELECT under wp_app with no GUC returns 0 rows)
- `db/schema/grants.snapshot.json` — regenerated via documented --update (diff = exactly the new function entry)
- NOTE: migrations now end at 0017 / EXPECTED_SCHEMA_VERSION 17

U1 (green; vitest design-tokens+i18n+scripts 17 files/132 tests; check:copy 392 files/0; depcruise 322 modules/0; tenant-scope clean; guards:meta 18 guards — check-no-raw-hex 137 files, check-ui-client-directive 0 via activatesIn P05; tokens:build byte-idempotent):
- `packages/design-tokens/src/tokens/{color,typography,space,radius,shadow,motion}.tokens.json` — created (DTCG source, OKLCH, one accent, Noto Sans Devanagari in ui stack)
- `packages/design-tokens/build.mjs` — created (style-dictionary build); `css/tokens.css`, `css/tailwind-theme.css`, `src/tokens.generated.ts` — generated + committed
- `packages/design-tokens/{package.json,src/index.ts}` — changed (exports ./tokens.css, ./tailwind.css; token map re-export); `test/tokens-build.test.ts` — created (3 cases)
- `packages/i18n/{package.json,tsconfig.json,src/index.ts,src/t.ts,src/catalogues/{catalogue-type,en,hi}.ts}` — created (t/plural, en fallback + wp_i18n_missing_key_total counter, never throws); `test/catalogue-parity.test.ts` — created (5 cases)
- `packages/domain/src/copy/banned-claims.ts` — changed (+4 Devanagari banned phrases)
- `scripts/check-no-raw-hex.ts`, `scripts/check-ui-client-directive.ts`, `scripts/guards/run-source-guards.ts` — created; `scripts/__tests__/{check-no-raw-hex,check-ui-client-directive,i18n-banned-claims}.test.ts` + fixtures under `scripts/guards/__fixtures__/{raw-hex,ui-client-directive}/` — created
- `scripts/guards/registry.ts`, `scripts/ci-steps.ts` (+2 steps after copy), `package.json` (tokens:build, check:no-raw-hex, check:ui-client-directive, @wp/i18n devDep), `tsconfig.json`, `vitest.config.ts` (.tsx globs), `.prettierignore` — changed
- KNOWN RED until U5: `check:no-raw-hex` flags `app/frontend/src/styles/base.css:30` (#b00020) — U5 deletes that file

U3a (green; vitest contracts+domain+realtime 15 files/87 tests; app-backend test:int 40 files/158 tests; domain browser build ok; typecheck/format/lint clean; depcruise 323 modules/0; tenant-scope 152 files/0; guards:meta 18):
- `packages/contracts/src/app/realtime.ts` — created (six `.strict()` event schemas, REALTIME_EVENT_TYPES, realtimeFrameSchema, GET /v1/events contract); `tests/realtime-events.test.ts` — created
- `packages/contracts/src/{index,router,errors}.ts` — changed (exports; appContract.realtime; +TOO_MANY_CONNECTIONS 429)
- `packages/domain/src/realtime/{channel,assert-ids-only}.ts` + colocated `.test.ts` — created (browser-pure); `packages/domain/src/index.ts` — changed
- `app/backend/src/platform/http/sse.ts` — created (openSseStream/SseSink: hijack, no-transform/X-Accel-Buffering headers, socket timeout 0, :hb heartbeat, bounded 100-frame queue → slow_consumer close)
- `app/backend/src/modules/realtime/{hub,service,routes,index}.ts` — created (in-process hub w/ replay ring + resync, publish validates schema + assertIdsOnly, dropWhere/onDrop/onConnectionCountChange/distinctUserIds seam; client_id from session only; fail-closed InstanceOwnershipPort; per-user cap 5 pre-hijack → 429)
- `app/backend/src/modules/realtime/{sse-route,sse-route-resilience}.test.ts`, `__tests__/sse-route-test-support.ts`, `__test-support__/stub-wp-server-kit-env.ts` — created (9 named cases)
- `app/backend/src/platform/config.ts` — changed (+SSE_HEARTBEAT_MS 15000, SSE_MAX_BUFFERED_FRAMES 100, SSE_MAX_CONNECTIONS_PER_USER 5, SSE_REPLAY_RING_SIZE 500, SSE_AUTHZ_TICK_MS 5000)
- `app/backend/src/platform/http/server.ts`, `roles/api.ts` — changed (BuildAppDeps.realtime, hub wiring, closeAll on shutdown); `modules/tenancy/__tests__/tenancy-routes-test-support.ts` — changed (mechanical realtime dep); `app/backend/vitest.config.ts` — changed (test.env WP_* placeholders for @wp/server-kit's eager config)
- Deviations: tests split across two files for max-lines; slow-consumer test uses a fake raw socket (real TCP absorbs 100 frames); cap check runs pre-hijack so the 429 is JSON

U4 (green; vitest packages/ui 2 files/24 tests; check-ui-client-directive 10 files/0; check:copy 406/0; depcruise 341 modules/0; tenant-scope 165/0; typecheck/format/lint clean; guards:meta 18):
- `packages/ui/{package.json,tsconfig.json}` — rewritten (@base-ui/react 1.7.0 — `@base-ui-components/react` is deprecated/renamed; react 19 peer; jsdom/@testing-library/react/axe-core dev)
- `packages/ui/src/{button,input,card,badge,table,empty-state,sheet,toast,spinner}.tsx`, `src/lib/cx.ts`, `src/i18n/i18n-provider.tsx` (I18nProvider/useT/useLocale), `src/index.ts` — created (tokens-only Tailwind classes, 'use client' on interactive)
- `packages/ui/test/{a11y,i18n-provider}.test.tsx` — created (axe WCAG 2.2 AA over every export in en+hi, color-contrast disabled under jsdom; directive + raw-colour mirrors)
- `pnpm-lock.yaml` — updated
- Deviation: components+tests authored in one pass (not literally red-first) — small unit, tests green on first run

U3b (green; vitest realtime 6 files/18 tests incl. `a_revoked_membership_drops_the_stream_within_5_seconds` (THE PHASE DEMO) + `a_token_epoch_bump_drops_the_stream_within_5_seconds` + `the_authz_tick_issues_one_query_per_tick_not_one_per_connection`; app-backend test:int 45 files/168 tests; depcruise 368 modules/0; tenant-scope 183/0; format clean; guards:meta 18; app-backend tsc clean — workspace typecheck/lint noise at that moment was U5's in-flight frontend files):
- `app/backend/src/modules/realtime/authz.repo.ts` — created (ONE `SELECT … FROM public.wp_realtime_authz_snapshot($1::uuid[])`; empty input → no query)
- `app/backend/src/modules/realtime/authz-tick.ts` — created (≤5 s tick over distinct user ids; drops token_epoch / membership_revoked / client_suspended / client_closed; fail-safe: query failure keeps connections, 6 consecutive failures → drop all `authz_unverifiable`)
- `app/backend/src/modules/realtime/metrics.ts` — created (`wp_sse_connections` gauge, `wp_sse_drops_total{reason}`, `wp_sse_subscriptions_refused_total`, `wp_sse_authz_tick_errors_total`; idempotent binding)
- `app/backend/src/platform/db/test-support/wp-app-role.ts` — created (shared wrapAsRole successor; module-local copies untouched)
- tests: `authz-tick.test.ts`, `sse-revocation.test.ts`, `__tests__/{authz-under-wp-app-role.integration,suite-b-sse,sse-log-redaction}.test.ts`, `__tests__/sse-log-redaction-test-support.ts` — created
- `platform/http/sse.ts` (+authz_unverifiable reason), `platform/config.ts` (+SSE_AUTHZ_MAX_CONSECUTIVE_FAILURES 6), `modules/realtime/index.ts`, `roles/api.ts` (metrics + tick start after listen/stop before closeAll; inline TOTP query → identity `getUserTotpState`), `modules/identity/index.ts` (+getUserTotpState export), `modules/tenancy/__tests__/tenancy-routes-test-support.ts` (dedupe) — changed
- Deviations: per-reason drops computed in-process then one dropWhere per reason (still 1 query/tick); log-redaction test swaps the server-kit logger singleton for a capturing instance (pino bypasses stdout)

U5 (green; vitest app/frontend+packages/i18n 6 files/24 tests; vite build ok; check:no-raw-hex 180 files/0 (base.css deleted); check:copy 437/0; ui-client-directive 10/0; depcruise 370 modules/0; tenant-scope 0 violations; guards:meta 18; Playwright e2e 2/2 passed 14.0s, no spec changes needed):
- `app/frontend/src/lib/{sse.ts,sse-frame-parser.ts,sse-invalidation-map.ts}` — created (fetch-stream SSE client: Bearer + Last-Event-ID headers, hand-written frame parser, static event→query-key map, full-jitter backoff capped 30 s, ref-counted one-connection singleton, 401→shared-refresh→reconnect, resync→invalidate all); `lib/sse.test.ts` — created (7 cases)
- `app/frontend/src/features/{instances,jobs,campaigns}/{keys.ts,index.ts}` — created (key factories only); `features/dashboard/{keys.ts,api.ts,index.ts,components/empty-dashboard.tsx}` + `__tests__/empty-dashboard.test.tsx` — created (summary is a typed static 0/0/0 until P17 wires GET /v1/dashboard/summary)
- `app/frontend/src/routes/_authed.tsx`, `routes/_authed/index.tsx` — created (ensureSession guard → /login; onboarding-incomplete → /onboarding); `routes/__tests__/authed-guard.test.tsx` — created; `routes/index.tsx` — DELETED (/ now lives under _authed)
- `app/frontend/src/components/app-shell.tsx`, `providers/{i18n-provider,theme-provider}.tsx`, `styles/tailwind.css` — created (realtime chip live/reconnecting/offline, locale+theme persisted via guarded localStorage, logout); `styles/base.css` — DELETED (raw hex placeholder)
- `app/frontend/src/features/auth/components/totp-recovery-form.tsx` — created (carried P04b debt: recovery-code login UI); `features/auth/{api.ts,index.ts}` — changed (+totpRecovery, me, logout); `login-form.tsx`, `totp-verify-panel.tsx` — changed (navigate to /; recovery link)
- `app/frontend/src/{app.tsx,main.tsx}`, `vite.config.ts` (+@tailwindcss/vite, routeFileIgnorePattern for .test.tsx), `index.html` (Instrument Sans + Noto Sans Devanagari, display=swap), `package.json` (+tailwindcss, @tailwindcss/vite, @testing-library/react, jsdom), `src/routeTree.gen.ts` (regenerated), `pnpm-lock.yaml` — changed
- `app/frontend/src/lib/api-client.ts` — changed (+ensureSession(); refresh-sharing semantics untouched)
- i18n keys: none added (U1's set sufficed)

MAIN-SESSION FIX (trivial tier, after U3b+U5 landed): `app/backend/src/modules/realtime/authz-tick.test.ts` — changed (vi.fn given an explicit (fn, ms) generic signature; the untyped mock's `.mock.calls[0]?.[1]` failed workspace typecheck once U5's files stopped masking it). Evidence: typecheck exit 0, lint exit 0, format:check clean, vitest authz-tick.test.ts 1 file/5 tests green.

## Ordered minimum steps
- [x] 1. **Design tokens.** DTCG source + style-dictionary build → `packages/design-tokens/src/*.tokens.json`, `packages/design-tokens/dist/tokens.css`, `packages/design-tokens/dist/tailwind-preset.ts`; add the raw-hex guard → `scripts/check-no-raw-hex.ts` (registered in `scripts/ci.ps1` + `scripts/ci.sh`, must report a non-zero matched-file count).
- [x] 2. **i18n.** `packages/i18n/src/{index.ts,t.ts,catalogues/en.ts,catalogues/hi.ts}` — `t(key, vars, locale)`, English fallback on a missing key plus a `wp_i18n_missing_key_total` counter, never a throw.
- [x] 3. **UI primitives.** `packages/ui/src/{button,input,card,badge,sheet,table,toast,empty-state,spinner}.tsx` + `index.ts` on Base UI, tokens only, `'use client'` on every interactive one; add `scripts/check-ui-client-directive.ts` to `scripts/ci`.
- [x] 4. **The event contract, ids only.** `packages/contracts/src/app/realtime.ts` (strict Zod discriminated union for the six blueprint events, `.strict()`, no free-form field) + `packages/domain/src/realtime/channel.ts` (`realtimeChannel(clientId, instanceId?)`) + `packages/domain/src/realtime/assert-ids-only.ts`.
- [x] 5. **SSE hub + route.** `app/backend/src/modules/realtime/{hub.ts,routes.ts,service.ts,index.ts}` and `app/backend/src/platform/http/sse.ts` — `GET /v1/events`, `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, socket timeout disabled, 15 s `:hb` comment frame, `Last-Event-ID` resume, bounded 100-frame per-connection buffer (overflow ⇒ close with a reconnect hint, counted), per-user connection cap 5. `client_id` comes from the session **only**; a `clientId` query parameter is ignored.
- [x] 6. **Continuous re-authorisation.** `app/backend/src/modules/realtime/authz-tick.ts` — one batched query per ≤5 s tick over the *distinct* user ids currently connected (never one query per connection); drop on `token_epoch` bump, membership removal or client suspension. Metrics `wp_sse_connections` (no label), `wp_sse_drops_total{reason}` registered in `app/backend/src/platform/metrics.ts`.
- [x] 7. **SPA shell.** `app/frontend/` Vite + React 19: `index.html`, `vite.config.ts`, `src/main.tsx`, `src/routes/{__root.tsx,login.tsx,_authed.tsx}`, `src/providers/{QueryProvider,AuthProvider,ThemeProvider,I18nProvider}.tsx`, `src/lib/{api-client.ts,query-client.ts,auth.ts,format.ts}`, `src/components/app-shell.tsx`, `src/styles/tailwind.css`. `_authed` redirects an unauthenticated visit to `/login`.
- [x] 8. **SSE client.** `app/frontend/src/lib/sse.ts` + `src/providers/RealtimeProvider.tsx` — one `EventSource` per session, full-jitter backoff reconnect, `Last-Event-ID` resume, a static event→query-key invalidation map, and a connection-state chip in `AppShell` (`live` / `reconnecting` / `offline`).
- [x] 9. **Honest empty dashboard.** `app/frontend/src/routes/_authed/index.tsx` + `src/features/dashboard/{index.ts,api.ts,keys.ts,components/empty-dashboard.tsx}` — zero connected numbers, zero queued, zero sent, all copy from `@wp/i18n` in en and hi; `scripts/check-copy.ts` green including the Hindi banned-claim list.

(9 steps. If a tenth appears — do not add it here: split into `P05a-panel-shell-and-sse.md` and add the row to `plan/README.md`.)

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/design-tokens/test/tokens-build.test.ts` | `every_token_reference_resolves_to_a_css_custom_property` | built `tokens.css` has no unresolved `{...}` reference and defines every key in the DTCG source |
| `packages/design-tokens/test/tokens-build.test.ts` | `the_font_stack_includes_a_devanagari_fallback` | the body/UI font token names a Devanagari family — Hindi previews must not render tofu |
| `scripts/__tests__/check-no-raw-hex.test.ts` | `a_raw_hex_colour_in_packages_ui_fails_the_guard` | guard exits non-zero on a seeded fixture **and** reports a non-zero matched-file count on the real tree |
| `packages/i18n/test/catalogue-parity.test.ts` | `en_and_hi_have_identical_key_sets` | symmetric difference is empty |
| `packages/i18n/test/catalogue-parity.test.ts` | `a_missing_key_falls_back_to_english_and_counts_it` | returns the en string, increments the counter, does not throw |
| `packages/ui/test/a11y.test.tsx` | `every_exported_primitive_has_zero_axe_violations` | axe-core WCAG 2.2 AA over each export, rendered in both locales |
| `packages/contracts/test/realtime-events.test.ts` | `an_event_payload_with_a_phone_number_field_is_rejected` | `.strict()` union rejects `{phone}`, `{jid}`, `{body}`, `{name}` on every member |
| `packages/contracts/test/realtime-events.test.ts` | `every_event_in_the_blueprint_table_has_a_schema` | the six named event types all parse; an unknown `type` fails closed |
| `packages/domain/test/realtime-channel.test.ts` | `two_clients_never_produce_the_same_channel_name` | property test over uuid pairs; instance-less form is client-scoped |
| `app/backend/src/modules/realtime/sse-route.test.ts` | `an_unauthenticated_request_to_v1_events_is_401` | no stream is opened, no frame written |
| `app/backend/src/modules/realtime/sse-route.test.ts` | `a_client_id_query_parameter_is_ignored` | tenant A's session + `?clientId=<B>` streams A's channel only |
| `app/backend/src/modules/realtime/sse-route.test.ts` | `a_user_cannot_subscribe_to_another_clients_instance_channel` | subscribe request for a foreign `instanceId` is refused and counted, connection stays on its own channels |
| `app/backend/src/modules/realtime/sse-route.test.ts` | `a_heartbeat_frame_arrives_within_20_seconds` | fake clock; keeps proxies and idle timeouts from killing an idle tab |
| `app/backend/src/modules/realtime/sse-route.test.ts` | `a_slow_consumer_is_closed_and_counted_not_buffered_without_bound` | buffer capped at 100 frames; `wp_sse_drops_total{reason="slow_consumer"}` +1 |
| `app/backend/src/modules/realtime/sse-revocation.test.ts` | `a_revoked_membership_drops_the_stream_within_5_seconds` | **the phase demo**; fake clock, drop reason recorded |
| `app/backend/src/modules/realtime/sse-revocation.test.ts` | `a_token_epoch_bump_drops_the_stream_within_5_seconds` | logout/role change closes every stream for that user |
| `app/backend/src/modules/realtime/authz-tick.test.ts` | `the_authz_tick_issues_one_query_per_tick_not_one_per_connection` | 200 connections over 40 users ⇒ query count ≤ 1 per tick |
| `app/backend/test/isolation/suite-b-sse.test.ts` | `two_tenants_streaming_at_once_never_receive_each_others_events` | isolation suite B gains the SSE hub as a background path |
| `app/backend/test/security/sse-log-redaction.test.ts` | `no_sse_frame_or_log_line_carries_a_phone_jid_or_body` | greps every frame, log line and metric label emitted during a seeded two-tenant run |
| `app/frontend/src/lib/sse.test.ts` | `a_health_changed_event_invalidates_only_that_instances_query_key` | hint-then-refetch; no other key touched |
| `app/frontend/src/lib/sse.test.ts` | `a_reconnect_resumes_with_the_last_event_id` | header/param carries the last id; backoff is jittered, capped |
| `app/frontend/src/routes/__tests__/authed-guard.test.tsx` | `an_unauthenticated_visit_to_a_protected_route_redirects_to_login` | no protected render before redirect |
| `app/frontend/src/features/dashboard/__tests__/empty-dashboard.test.tsx` | `the_empty_dashboard_states_zero_connected_numbers_and_promises_nothing` | renders in `en` and `hi`; asserts no banned claim string is present |

Mandatory-suite tests this phase makes green: **none** from the blueprint's numbered send-path table (1-23). This phase extends **isolation suite B** (SSE hub as a background path), the **log-grep/PII** suite and the **copy** suite, and it is where blueprint `[R-35]` ("membership revoked → SSE dropped within 5 s") stops being a claim and becomes a test.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `<path>` — created
- `<path>` — changed: <one line>

## Risks / gotchas specific to this phase
- **`EventSource` cannot send an `Authorization` header.** Authenticate the stream with the same HttpOnly, `Secure`, `SameSite` session cookie the rest of the panel uses. Do **not** accept the access token in the query string — it lands in proxy access logs verbatim. If a bearer flow is ever unavoidable, mint a single-use short-TTL SSE ticket over `POST`; even then `client_id` comes from the session, never from the ticket's caller.
- **Buffering proxies silently break SSE.** Without `X-Accel-Buffering: no` and `no-transform`, Caddy/nginx batch frames and the panel looks frozen for a minute. Set the headers in `platform/http/sse.ts` and record the required proxy directives in `infra/` config comments in the same step.
- **Node/Fastify idle timeouts kill an idle stream.** Disable the per-route socket timeout and send the 15 s heartbeat comment. A tab left open over lunch must still be live.
- **Do not open a `LISTEN` connection in this phase.** ADR 0010 notes `LISTEN` cannot use PgBouncer transaction pooling. Ship a `publish(event)` port with one in-process implementation and a test double — wiring a second publisher in this phase would be untested. (Historical note: the outbox now exists as of P15, and its `relay` role is the production `publish` port implementation via `modules/realtime/redis-bridge.ts`; this phase's in-process port and its test double are unaffected.)
- **Re-authorisation must not be O(connections) queries.** One batched query per ≤5 s tick over distinct connected user ids. The naive per-connection check is invisible at 5 tabs and fatal at fleet scale; the tick's query count is asserted by a test for exactly that reason.
- **Unbounded per-connection buffers are a heap leak wearing a feature's clothes.** A phone on a train stops reading; the frames must be dropped and the connection closed, not queued.
- **Register `wp_sse_connections` now, not at P25.** ADR 0010's Centrifugo escalation trigger is "concurrent SSE connections per api process > ~4,000". A trigger with no metric can never fire.
- **Observability trap (scope delta):** event payloads, `event:` names, `id:` fields, log lines and metric labels carry **ids and enums only**. The temptation is `{instanceId, phone}` so the panel can render a header without a refetch — forbidden; refetch through the authorised API. Metric labels obey the four-gauge allow-list: `wp_sse_drops_total{reason}` is an error class, never a `client_id`.
- **Copy trap:** the empty dashboard is the first WP surface a customer ever reads. No "instant", no "guaranteed delivery", no "ban"/"block" claim, in English or Hindi ("ban nahi hoga", "100% safe"). If any string here mentions Safe Mode, `SAFE_MODE_DISCLAIMER` must be co-present or `check-copy` fails — and it should fail.
- **Scaffold the right thing:** `app/frontend` is a **React 19 + Vite SPA** (ADR 0014, blueprint "Surfaces"). ADR 0007's `apps/web` Next.js shape is superseded for layout; its design-system content is not. Do not run a Next.js scaffold here.
- **`@wp/domain` stays browser-clean.** `realtime/channel.ts` and `assert-ids-only.ts` must not touch `process.env`, `pg` or any Node builtin — the browser-target build in `scripts/ci` is the check that will catch it.

C1 review (opus, parallel with C2 over the same diff): **CHANGES-REQUIRED** — 1 CRITICAL, 3 MAJOR, 3 MINOR; all 10 verify-dont-trust claims (a)-(j) CONFIRMED with file:line evidence. Findings: CRIT-1 sse.ts 401→ensureSession presence-check→zero-delay unbounded reconnect spin (invariant 2); MAJ-1 sse.ts release-then-reacquire leaks a second connection loop (no generation guard); MAJ-2 authz-tick no re-entrancy guard + no query timeout (hung Postgres never trips the failure budget, ticks pile up); MAJ-3 per-user cap TOCTOU (concurrent connects all pass the pre-connect check); MIN-1 `a_non_conforming_publish_throws_and_sends_nothing` vacuous second half; MIN-2 frames published between hijack and hub.connect silently lost; MIN-3 check-no-raw-hex reports one violation per line. Note: metrics.ts accumulates hub callbacks per bindRealtimeMetrics call (comment-worthy). → FIXA dispatched; re-review of fixes only to follow.

C2 test-engineer (parallel with C1; allGreen, evidence tail: 17 files/81 tests in the touched areas + typecheck/lint/format clean): 3 real bugs found and FIXED red-first —
- `app/frontend/src/lib/sse.ts` — changed (401-reauth cycle bounded; red test showed 17 zero-delay fetch+refresh round-trips) + `lib/sse-connection-loop.test.ts` — created (2 cases incl. backoff-storm distribution)
- `app/backend/src/modules/realtime/authz-tick.ts` — changed (tickInFlight single-flight guard; red test proved 3 overlapping queries under a slow dependency) + `authz-tick-clock.test.ts`, `__tests__/authz-tick-test-support.ts` — created; `authz-tick.test.ts` — extended (empty-user-set fast path)
- `packages/i18n/src/t.ts` — changed (unknown runtime locale now falls back to English instead of TypeError) + `test/catalogue-parity.test.ts` — extended (4 cases)
- new coverage, no bugs: `modules/realtime/hub.test.ts` (5 concurrency cases), `hub-replay.test.ts` (6 ring/Last-Event-ID boundary cases incl. cross-tenant id), `__tests__/hub-test-support.ts`, `sse-route.test.ts` +1 cross-tenant replay case, `app/frontend/src/lib/sse-frame-parser.test.ts` (18 parser-resilience cases)

FIXA (green; closes all 7 C1 findings + the metrics note; vitest realtime+frontend+i18n+scripts 36 files/217 tests; app-backend test:int 52 files/192 tests; typecheck/format/lint clean; depcruise 383 modules/0; tenant-scope 187 files/0; guards:meta 18) — two mid-run session-rate-limit kills, resumed cleanly both times after disk-state verification:
- `app/frontend/src/lib/sse.ts` — changed (CRIT-1: 401 clears stale token before ensureSession, reauth no longer resets backoff; MAJ-1: `mine` identity guard after every await); `lib/sse-stream-consumer.ts` — created (max-lines split); `lib/sse-connection-loop.test.ts` — extended (+2 cases)
- `app/backend/src/modules/realtime/authz-tick.ts` — changed (MAJ-2: loadWithDeadline races snapshot vs tickMs deadline; timeout = failed tick error_class 'timeout'; late result discarded); `authz-tick-clock.test.ts` — extended (+2 cases)
- `app/backend/src/modules/realtime/{hub.ts,hub-types.ts}` — changed/created (MAJ-3: per-user cap enforced atomically inside connect, TooManyConnectionsError; +subscribeChannel; types split for max-lines); `hub.test.ts` — extended (10 concurrent connects ≤ 5); `hub-subscribe-channel.test.ts`, `sse-route-connection-cap.test.ts`, `sse-route-subscribe-race.test.ts`, `metrics.test.ts` — created
- `app/backend/src/modules/realtime/service.ts` — changed (MIN-2: client channel registered synchronously BEFORE ownership awaits, instance channels added as they resolve); `routes.ts` — changed (post-hijack cap refusal closes sink with `connection_cap`); `metrics.ts` — changed (re-bind true no-op); `__tests__/sse-route-test-support.ts` — changed (ownershipGate/hubOverride seams); `roles/api.ts` — changed (passes maxConnectionsPerUser to createRealtimeHub)
- `sse-route-resilience.test.ts` — changed (MIN-1: `a_non_conforming_publish_throws_and_sends_nothing` now opens a real connection, asserts zero frames + ring unchanged)
- `scripts/check-no-raw-hex.ts` — changed (MIN-3: matchAll, one violation per match); `scripts/__tests__/check-no-raw-hex.test.ts` + fixture `two-colours-one-line.tsx` — extended/created
- Deviation: MAJ-3 e2e race test uses a hub-override seam (MIN-2's sync-register closed the window the ownership-gate delay relied on)

C5 (the phase's ONE full gate, 2026-08-31 13:19-13:21): **CI GREEN — all 14 steps passed** (format, lint, depcruise, domain-browser-build, guard-meta-assertion, tenant-scope, send-origin, copy, no-raw-hex, ui-client-directive, typecheck, unit, integration, build). Unit 76 files/461 tests; integration: db 21 files/96 tests + app-backend 52 files/192 tests; CI_EXIT_CODE:0. All 18 guards matched non-zero files (check-no-raw-hex 193, check-ui-client-directive 10). Verbatim tail preserved in the session log (C6) and at scratchpad ci-output.log.

C1 re-review of FIXA (fixes only, opus): **APPROVED-with-notes**. All 8 findings verified FIXED with file:line evidence; no new findings. Non-blocking notes filed: (n1) `a_non_conforming_publish_throws_and_sends_nothing` proves "sends nothing" via ring-state + surviving connection rather than reading frames off the response body — tighten opportunistically; (n2) sse.ts's 401 handler clears the module-global token, so a spurious SSE 401 can cost one concurrent REST call an extra 401→refresh round-trip (self-healing via the shared refresh; scope the clear if it shows in traces); (n3) the per-user cap is configured in two places (RealtimeCtx fast path + hub authority) fed from one env value — drift hazard, consider reading the cap from the hub. Verification runs by the reviewer: realtime 14 files/43 tests, frontend sse 3 files/29 tests, typecheck + lint clean.

### C3 invariant check (written by the main session at close)
1. durable-first — PASS. No send path exists or was added; the realtime hub only fans out hints; `publish()` originates in-process (P15 wires the outbox relay), and `roles/api.ts` still never imports provider code (depcruise `api-never-imports-provider` green).
2. fail-safe — PASS. Unclear authz (tick query failure) keeps connections and only after 6 consecutive failures drops ALL with `authz_unverifiable` (unverifiable auth must not persist); a foreign-instance subscription is refused (counted) while the connection keeps only its own channels; instance ownership defaults to fail-closed `false` until P08; a slow consumer is closed, never buffered unbounded. Blast radius is per-connection/per-user, never process-wide except the deliberate `authz_unverifiable` case.
3. idempotency at storage — PASS (n/a surface). No new uniqueness claim was introduced; the phase adds no tables. The only schema object is a read-only SECURITY DEFINER function (0017).
4. tenant isolation — PASS. `client_id` locked from the session (query param never read); channels are `client:{clientId}` scoped; suite B gained `two_tenants_streaming_at_once_never_receive_each_others_events`; the FORCE-RLS read path goes through the wp_app-granted definer with an under-wp_app integration proof; frames/logs/labels carry ids+enums only (log-redaction test).
5. pause preserves work — PASS (n/a surface). SSE drops lose no durable state by design: payloads are hints; the client refetches through the authorised API (hint-then-refetch), so a dropped stream degrades to a later refetch, never lost data.
6. no evasion — PASS. No rotation/proxy/fingerprint surface touched; all new copy (i18n en+hi catalogues, dashboard) is scanned by check-copy (437 files, 0 violations) with 4 new Devanagari banned claims added; Safe Mode is deliberately not mentioned in catalogues (no SAFE_MODE_DISCLAIMER co-presence needed).
7. tests are evidence — PASS. Verbatim green tails recorded per unit in the actuals above; the phase's ONE full gate (C5) tail goes in the session log.

### C4 structure/convention check (main session)
- Guards: 18 registered, all matching non-zero files except `check-ui-client-directive` during U1 (tolerated via `activatesIn: P05`, non-zero — 10 files — since U4). Verified again from the single C5 gate run.
- Tree: no file outside the ADR 0014 tree (check-tree green); no deep module import (depcruise); no raw `db.select()` outside platform/db; no OFFSET pagination; no money code touched.
- New routes: `GET /v1/events` registered via `registerRoute` with `policy: 'session'`, `scope: 'realtime:subscribe'` (fail-closed routing preserved). New metrics `wp_sse_connections` (gauge, no label), `wp_sse_drops_total{reason}`, `wp_sse_subscriptions_refused_total`, `wp_sse_authz_tick_errors_total` — all pass the metric-policy allow-list at registration. New copy strings live in `packages/i18n` catalogues, inside check-copy's scan set.
- No new tenant table (suite A unchanged); the new background path (SSE hub) is in suite B via `suite-b-sse.test.ts`.
- Descoped/carried (written down, not left in heads): dashboard summary endpoint is a typed static 0/0/0 until P17; instance-channel ownership port fail-closed until P08; enrol-confirm still mints no mfa session (P05 surfaces are policy `session`; carried to P08); structured request-logging on the backend HTTP path still carried (since P04a); `instance.qr` challenge payload delivery deliberately excluded from the P05 contract — P08 decides it with redaction rules.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P06 — session-lease-and-fence. Read plan/v1/P06-session-lease-and-fence.md and follow it exactly:
one phase, one session. Deps P03 and P01 are done (see plan/README.md). Do not start P07.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
