# P08 — session-qr-linking

**Goal (one line):** a tenant clicks Connect, scans a QR (or enters a pairing code) in the panel, and the number reaches `link_state=linked · health_state=connected` on a pinned, config-asserted Baileys socket whose every disconnect code is mapped as data.
**Status:** done (live-scan demo pending founder) · **Size:** M · **Session:** 1 of 1
**Depends on:** P07, P05 (must be `done`)
**Blocks:** P09, P10, P11

**Size warning:** this phase sits exactly on the 10-step ceiling. If step 7 is not green with time left in the sitting, **stop and split**: steps 8-10 (link routes, park/online routes, Connect screen) become `plan/v1/P08a-link-surfaces.md`, and P08 closes with the runner proven by integration tests instead of a live scan. Do not compress steps to fit.

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; all migrations applied; `scripts/ci.ps1` green on the tree as found (SESSION-PROTOCOL O2).
- `whatsapp_instances` already carries `link_state`, `health_state`, `desired_state`, `session_epoch`, `qr_attempts`, `pairing_started_at`, `needs_user_action`, `user_action_reason`, `pause_reason`, `disconnection_reason_code/label/at`, `last_connected_at` (P02), and the enums exist in PG **and** `@wp/domain` with the parity test green.
- `instance_lease_state` + Postgres-minted fence, heartbeat, watchdog and self-fencing exist (P06); `EncryptedAuthStore` + the bounded Signal key store exist (P07).
- The authenticated SSE endpoint, its client and per-tenant channel authorisation exist (P05); publishing to `wp:{env}:rt:c:{client}:i:{instance}` is a one-line call.
- ADRs 0013 and 0018 are accepted. `plan_limits.max_connected_instances` exists (P02) and is readable per client.
- **One real spare WhatsApp number on a physical phone** is available for the demo. It is linked only; **nothing is sent from it in this phase**. The v1 ban risk lands on that real number (ADR 0013 §10) — use a number you can afford to lose.
- `pnpm install` and `scripts/ci.ps1` are run by the human at the terminal; agents do not run installs or builds.

## What you are building (3-6 bullets)
- One reviewed **socket factory** on a pinned Baileys version, typed against the pinned `UserFacingSocketConfig` at compile time **and** asserted at runtime against `DEFAULT_CONNECTION_CONFIG`, with a single constant browser identity (never randomised).
- `disconnect-map.ts` as a **data table** re-derived from the pinned `DisconnectReason` enum, with the test that fails the build on an unmapped member.
- The three-field instance FSM in `@wp/domain` — `link_state` / `health_state` / `desired_state`, never collapsed — plus the pure reconnect-backoff policy.
- A per-instance `SessionRunner`: lease + fence → auth state → socket → `connection.update` handling (qr / open / close), fence-guarded state writes, audit row on every transition out of `connected`.
- Bounded pairing (QR **and** 8-char code, 5 attempts / 5-minute window, terminal `pairing_expired` with a **button**, never an auto-loop), streamed to the panel over the tenant-scoped SSE channel.
- The link surfaces: `beginLink` / `refreshChallenge` / `linkStatus` routes, `online` ↔ `offline` ("parked") with the hard connected-slot check, and the Connect screen showing masked `Connected as +91·····21`.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | §Baileys engine → *Session lifecycle*; *Reconnection and the disconnect map* |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | §System architecture → *Flow 2 — link a WhatsApp number*, *Flow 3 — restriction signal* |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | §Real-time & notifications (the `instance.qr` row: the QR is a bearer credential) |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | §Repository (canonical paths table) + §Testing strategy (mandatory test 10) |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | *Normative `desired_state` semantics*; *Techniques…* → **"Two corrections to the socket factory as drafted"** |
| ADR | `.memory/decisions/0013-v1-whatsapp-engine-baileys-qr.md` | constraints 5, 6, 9, 10 |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §1 (connected unit, `desired_state`, parked copy) |
| Design | `.memory/research/2026-08-25-v1-design-engine-and-scale.md` | §1.2-1.3 (FSM + pairing table), §5.1-5.3 (backoff, map, 515), §10 (`ChannelLink`) |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/api.md`, `.claude/rules/queue-workers.md` | all |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | forbidden mechanisms + honest claims |

## Dispatch plan (SESSION-PROTOCOL E1; written at session open 2026-08-31, overnight continuation authorised by founder)
- **U1 (implementer):** steps 1+2+3 — `pinned.ts` (version + re-derived DisconnectReason snapshot), `socket-factory.ts` (typed vs pinned `UserFacingSocketConfig`, runtime assertion vs `DEFAULT_CONNECTION_CONFIG`, ≤4-entry `REQUIRED_RUNTIME_KEYS`), `disconnect-map.ts` data table, + socket-config/disconnect-map/logout-call-sites tests + ADR 0013 append. PARALLEL with U2 (disjoint scopes).
- **U2 (implementer):** step 4 + step 10's copy constants — `@wp/domain` `instance/session-fsm.ts`, `instance/reconnect-policy.ts`, `copy/instance-copy.ts` + all their tests (browser-pure, injected clock/RNG). PARALLEL with U1.
- **U3 (db-engineer, solo — migration, never parallel):** migration 0022 dropping the leftover `whatsapp_instances.owner_worker_id` (P06 carried item) + Drizzle mirror + schema-version bump + grant-snapshot refresh + schema-test update.
- **U4 (implementer):** step 5 — `modules/instances/{repo,service}.ts` fence-guarded transitions, audit row per transition out of connected, one-tx `logged_out` purge via the P07 store, real `InstanceOwnershipPort.isOwnedBy` (replaces P05's fail-closed stub), + `instance-transitions` integration tests (extends mandatory 4). Includes a role-scoped wp_app proof test (P07 lesson).
- **U5 (implementer):** steps 6+7 — SPLIT mid-flight per E1 (mis-sized; the first dispatch consumed its budget on the pre-steps): **U5-pre** (DONE: pool timeouts closing P06's gate + `toFsmRow` seam + `instance.qr` payload contract ripple) → **U5a** (runner/registry/pairing/connect-gate + fake-socket tests) → **U5b** (real-infra proofs: tenant-channel isolation, QR-never-in-logs/metrics/audit, heartbeat renewal across the pairing window).
- **U6 (implementer):** steps 8+9 — SPLIT per E1 before code was written (the dispatched agent correctly refused the bundle as several units): **U6a** (provider/baileys/adapter.ts ChannelLink half + the one legal `sock.logout()` site) ∥ **U6c** (routes + contracts + scopes + named route tests, incl. POST /v1/instances create replacing the P04b stub) — disjoint scopes, parallel; then **U6b** (roles/session-worker.ts + main.ts ROLE dispatch + config ENC_VERSION + the Redis realtime bridge + roles/api.ts subscriber leg + park-ends-socket worker-side test), which needs U6a's adapter.
- **U7 (ui-implementer):** step 10 minus copy constants — `app/frontend/src/features/instances/connect/*` (ConnectDialog, QrPanel, PairingCodePanel, useLinkStream) consuming the P05 SSE client.
Order: (U1 ∥ U2) → U3 → U4 → U5 → U6 → U7; stop at first red (debugger). Every unit ends with format+lint+typecheck+guards:meta (P07 C5 lesson) and respects max-lines 300.

## Ordered minimum steps
- [x] 1. Pin Baileys to an **exact** version (no `^`) in `app/backend/package.json`; export it from `app/backend/src/provider/baileys/pinned.ts` (`BAILEYS_PINNED_VERSION`, plus the re-derived numeric `DisconnectReason` snapshot as a `const` object); append the pinned version + the re-derivation date as an **implementation note** to `.memory/decisions/0013-v1-whatsapp-engine-baileys-qr.md` (append only, never rewrite the ADR body).
- [x] 2. Write `app/backend/test/unit/provider/baileys/socket-config.test.ts` **first**, then `app/backend/src/provider/baileys/socket-factory.ts`: config typed as the pinned `UserFacingSocketConfig`, a runtime assertion that every key we set is in `DEFAULT_CONNECTION_CONFIG` (any exception lives in a hand-reviewed `REQUIRED_RUNTIME_KEYS` array of ≤4 entries, each with a one-line comment), one constant `browser` tuple, `syncFullHistory:false`, `markOnlineOnConnect:false`, `shouldSyncHistoryMessage:()=>false`, `generateHighQualityLinkPreview:false`, bounded `userDevicesCache`/retry caches, `getMessage` reading Postgres, the shared `level:'warn'` pino logger, and the P07 auth state + bounded key store injected.
- [x] 3. Build `app/backend/src/provider/baileys/disconnect-map.ts` as data (code → `{healthState, linkState, autoReconnect, budget, action, surfaceAsError}`) exactly per the blueprint table, with `app/backend/test/unit/provider/baileys/disconnect-map.test.ts` written first → mandatory test **10**.
- [x] 4. Add the FSM and reconnect policy to `@wp/domain` (browser-pure, injected clock/RNG): `packages/domain/src/instance/session-fsm.ts` (legal `link_state`/`health_state`/`desired_state` transitions, `applyDisconnect(code, ctx)`, the separate 515 budget of 2) and `packages/domain/src/instance/reconnect-policy.ts` (full jitter, `ceiling=min(300_000, 2_000·2^(n-1))`, `MAX_ATTEMPTS=8`, per-instance stagger, reset only after >60 s open), with their `.test.ts` files.
- [x] 5. Build the fence-guarded transition repo + audit/SSE side effects → `app/backend/src/modules/instances/repo.ts`, `app/backend/src/modules/instances/service.ts`: every state write carries the fence predicate, a zero-row update is a hard error (`state_write_lost_fence`), every transition out of `connected` writes an `audit_logs` row, and `logged_out` purges auth material + bumps `session_epoch` in **one** transaction.
- [x] 6. Build `app/backend/src/engine/session/runner.ts` (+ `registry.ts`, a process-local map of leased runners, explicitly not an ownership arbiter): acquire lease → mint fence → `TAKEOVER_GRACE` → load auth → `makeWASocket` → handle `connection.update` (`qr` → publish, `open` → persist creds + `linked`/`connected` + clear `needs_user_action`, `close` → `applyDisconnect`) and `creds.update` → `saveCreds`; reconnects go through a `ConnectGate` interface whose P08 implementation is the per-worker bucket (2/s, burst 5) — P09 swaps the fleet-wide bucket in behind the same interface.
- [x] 7. Implement bounded pairing → `app/backend/src/engine/session/pairing.ts`: `qr_attempts` increment, 5 attempts / 5-minute window on the injected clock, `requestPairingCode(phone)` for the code path, publish `instance.qr` (payload + `expiresAt` + `attemptsLeft`) **only** on `wp:{env}:rt:c:{client}:i:{instance}`, and on exhaustion `sock.end()` + `link_state=unlinked` + `needs_user_action=PAIRING_EXPIRED` + release lease — no auto-loop, no retry timer.
- [x] 8. Boot the runners → `app/backend/src/workers/session-worker.ts`: a deliberately **narrow** bootstrap scan (`desired_state='online' AND link_state='pairing' AND deleted_at IS NULL`, `LIMIT 10`, every 5 s ± 2 s) that P09 replaces with the full discovery loop under admission control; plus the Baileys adapter's `ChannelLink` half in `app/backend/src/provider/baileys/adapter.ts` (`beginLink`, `refreshChallenge`, `linkStatus`, `unlink` — `sock.logout()` exists **only** here).
- [x] 9. Add the routes to `app/backend/src/modules/instances/routes.ts` + contracts in `packages/contracts/src/instances.ts`: `POST /v1/instances/:id/link` (`method: 'qr'|'code'`), `POST /v1/instances/:id/link/refresh`, `GET /v1/instances/:id/link-status`, `POST /v1/instances/:id/online`, `POST /v1/instances/:id/park` — `online` enforces `plan_limits.max_connected_instances` and on refusal returns the numbers currently holding slots plus a "park this one instead" action; `park` is `sock.end()` only; both write an audit row with the acting user.
- [x] 10. Build the Connect screen → `app/frontend/src/features/instances/connect/{ConnectDialog.tsx,QrPanel.tsx,PairingCodePanel.tsx,useLinkStream.ts}` and the copy constants in `packages/domain/src/copy/instance-copy.ts`: 45 s ring, attempts left, "Generate a new code" **button** on expiry, masked `Connected as +91·····21`, and the verbatim parked-number copy from ADR 0018 §1 including the undocumented-buffer caveat.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/test/unit/provider/baileys/socket-config.test.ts` | `pinned_baileys_version_matches_installed_version` | `BAILEYS_PINNED_VERSION` equals the installed package version; a floating range fails |
| `app/backend/test/unit/provider/baileys/socket-config.test.ts` | `every_socket_config_key_exists_in_default_connection_config` | every key we set is in `DEFAULT_CONNECTION_CONFIG` or the ≤4-entry `REQUIRED_RUNTIME_KEYS` allow-list; a typo'd key fails the build |
| `app/backend/test/unit/provider/baileys/socket-config.test.ts` | `browser_identity_is_one_constant_and_is_never_randomised` | two factory calls yield an identical `browser` tuple; the module contains no `Math.random`/`Date.now`-derived identity |
| `app/backend/test/unit/provider/baileys/socket-config.test.ts` | `history_presence_and_preview_flags_are_off` | `syncFullHistory=false`, `markOnlineOnConnect=false`, `shouldSyncHistoryMessage()===false`, `generateHighQualityLinkPreview=false`, caches bounded |
| `app/backend/test/unit/provider/baileys/disconnect-map.test.ts` | `disconnect_map_covers_every_enum_member` | **mandatory 10** — fails if the pinned `DisconnectReason` enum gains an unmapped member |
| `app/backend/test/unit/provider/baileys/disconnect-map.test.ts` | `never_auto_reconnect_codes_are_401_402_403_406_411_440_500` | `autoReconnect=false` for each; 403/402/406 → `paused` + `restriction_signal`; 401/411/500 → `logged_out` + purge |
| `app/backend/test/unit/provider/baileys/disconnect-map.test.ts` | `unknown_code_degrades_then_pauses_after_two_attempts` | unknown gets the shorter leash and logs `disconnect.unmapped` with the raw code |
| `app/backend/test/unit/provider/baileys/logout-call-sites.test.ts` | `sock_logout_appears_only_in_the_unlink_path` | static scan over `app/backend/src/**`: `logout(` occurs only in `provider/baileys/adapter.ts#unlink`; the park path cannot reach it |
| `packages/domain/src/instance/session-fsm.test.ts` | `link_health_and_desired_state_are_never_collapsed` | no transition writes two of the three fields from one input except the explicit `logged_out` pair |
| `packages/domain/src/instance/session-fsm.test.ts` | `restart_required_stays_connected_on_its_own_budget_of_two` | 515 → `connected`, `linked`, `surfaceAsError=false`, backoff budget untouched |
| `packages/domain/src/instance/session-fsm.test.ts` | `a_disconnect_code_can_never_set_desired_state_offline` | safety: parking is never an automated response to any signal, restriction included |
| `packages/domain/src/instance/reconnect-policy.test.ts` | `backoff_is_full_jitter_within_the_ceiling_and_capped_at_300s` | seeded RNG; every draw in `[0, ceiling)`; ceiling never exceeds 300 s |
| `packages/domain/src/instance/reconnect-policy.test.ts` | `budget_exhausted_pauses_with_reconnect_failed` | attempt 9 → `paused` + `needs_user_action=RECONNECT_FAILED`, never a silent stop |
| `packages/domain/src/instance/reconnect-policy.test.ts` | `attempt_counter_resets_only_after_sixty_seconds_open` | a flapping session cannot refill its own budget |
| `app/backend/test/integration/session/pairing.test.ts` | `successful_open_persists_creds_and_sets_linked_connected` | creds row written encrypted, `link_state=linked`, `health_state=connected`, `needs_user_action` cleared, `last_connected_at` set |
| `app/backend/test/integration/session/pairing.test.ts` | `sixth_qr_attempt_terminates_with_pairing_expired_and_no_auto_loop` | socket ended, `link_state=unlinked`, `PAIRING_EXPIRED`, lease released, **zero** further QR events |
| `app/backend/test/integration/session/pairing.test.ts` | `pairing_window_expires_after_five_minutes_on_a_fake_clock` | window bound holds independently of attempt count |
| `app/backend/test/integration/session/pairing.test.ts` | `qr_is_published_only_on_the_owning_tenant_channel` | Suite C style: a second tenant's subscriber receives nothing; no QR payload in any other Redis key |
| `app/backend/test/integration/session/pairing.test.ts` | `qr_payload_never_appears_in_logs_metrics_or_audit_metadata` | log-grep + metric-label + `audit_logs.metadata` scan for the seeded QR string |
| `app/backend/test/integration/session/instance-transitions.test.ts` | `stale_fence_cannot_write_a_state_transition` | extends mandatory 4: zero rows, hard error, live session untouched |
| `app/backend/test/integration/session/instance-transitions.test.ts` | `every_transition_out_of_connected_writes_an_audit_row` | one audit row per transition, with reason and actor |
| `app/backend/test/integration/session/instance-transitions.test.ts` | `restriction_pause_leaves_every_queued_job_untouched` | 403 → `paused`; `message_jobs` counts and statuses byte-identical |
| `app/backend/test/integration/session/instance-transitions.test.ts` | `logged_out_purges_auth_material_and_bumps_session_epoch_atomically` | creds + keys gone, `session_epoch+1`, audit row, all in one transaction |
| `app/backend/test/integration/api/instance-link.routes.test.ts` | `link_and_link_status_are_scoped_to_the_owning_client` | another client's id → 404, never 403-with-existence |
| `app/backend/test/integration/api/instance-link.routes.test.ts` | `online_with_no_free_slot_names_the_holders_and_parks_nothing` | 409 listing the slot holders; **no** other instance's `desired_state` changed |
| `app/backend/test/integration/api/instance-link.routes.test.ts` | `park_ends_the_socket_and_never_logs_out` | `sock.end()` called, `logout` not called, creds retained, queued jobs still `queued` |
| `app/backend/test/integration/api/instance-link.routes.test.ts` | `refresh_after_window_exhaustion_returns_null_and_needs_a_button` | `refreshChallenge` → `null`; no server-side retry timer exists |
| `packages/domain/src/copy/instance-copy.test.ts` | `parked_copy_matches_adr_0018_verbatim` | exact string incl. the "not receiving messages while parked" and undocumented-buffer caveat |
| `packages/domain/src/copy/instance-copy.test.ts` | `connected_label_masks_the_number` | rendered label is `+91·····21` shape; the full number never leaves the API |

Mandatory-suite tests this phase makes green: **10**. It extends **4** (stale fence) to instance state transitions; **11** (`logout_is_unreachable_from_the_shutdown_path`) belongs to P09's drain and is only pre-guarded here by `sock_logout_appears_only_in_the_unlink_path`.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [ ] A real number was scanned in the panel and the panel showed masked `Connected as +91·····21`; the session log records the instance id (never the number). **← PENDING: founder's morning checklist (see session log); everything else is test-proven.**
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Deviations recorded (reality vs phase file, running log)
1. Overnight same-session continuation of P07's session, authorised explicitly by the founder (2026-08-31 night); protocol's one-phase-one-session rule overridden by instruction.
2. baileys already pinned 7.0.0-rc14 by P07 — step 1 reduced to `pinned.ts` + enum snapshot + ADR append.
3. Test placement: colocated convention (src/**/*.test.ts, *.integration.test.ts), not test/unit|integration paths from the phase file.
4. `workers/session-worker.ts` → `roles/session-worker.ts` (ADR 0014: workers are roles; check-role-boot scans roles/**).
5. REQUIRED_RUNTIME_KEYS = [qrTimeout, msgRetryCounterCache, userDevicesCache] — 'auth'/'getMessage' ARE in rc14's DEFAULT_CONNECTION_CONFIG (verified empirically); mediaCache/callOfferCache/placeholderResendCache left at Baileys defaults (bounding all would exceed the ≤4 cap; documented in-module).
6. logout-call-sites test scans the method-call form `.logout(` (a bare `logout(` false-positives on the identity module's session-logout).
7. wa_health enum includes `never_linked` (P02 reality; blueprint's four-state list is the FSM's live subset).
8. Domain FSM's `applyDisconnect` takes the policy ROW as a parameter (domain stays baileys-free); U1/U2 action-literal vocabularies diverged in parallel (map: none/purge_relink/restriction_pause/session_replaced/unmapped vs FSM: stay/reconnect/restriction/purge/session_replaced) — reconciled via a compile-time-exhaustive `toFsmRow()` adapter in the runner unit.
9. Workflow infra failure: U4's agent STOPPED correctly on the missing wp_app grants but its red report was rejected 5× by the StructuredOutput layer, killing the run — recovered from the journal/transcript; U4-U7 re-run as direct dispatches with plain-text reports.
10. U4 stop-line finding (as instructed): wp_app had no grants on the whatsapp_instances state columns → migration 0023 (column-level SELECT/UPDATE/INSERT surface) ships before U4 re-runs. POST /v1/instances (real creation, replacing P04b's 501 stub) pulled into P08 scope — the stub comment assigns it here and the demo needs it.
11. Bootstrap scan ships as SECURITY DEFINER `wp_session_bootstrap_scan` (ADR 0029 precedent), ORDER BY pairing_started_at ASC (deterministic oldest-first, not random()).
12. `markPairingExpired` leaves `health_state` untouched (stays `never_linked` for a never-linked instance) — the landed U4 SQL is authoritative over the phase prose's `paused`; the engine-design table's PAUSED applied to the generic case (reviewer to confirm).
13. `assertIdsOnly` gained a narrow OPAQUE_PAYLOAD_KEYS exemption (only `instance.qr.payload`) — the QR bearer string is allow-listed but exempt from the ids-only shape checks; flagged for C1 review.
14. Cross-process realtime leg: the hub is in-process-only (ADR 0010; outbox relay is P15) but the worker is a separate process — U6 ships a minimal validated Redis pub/sub bridge (worker publisher → API-side subscriber → hub.publish, realtimeEventSchema-validated both sides, invalid frames dropped+counted) as the smallest honest QR-delivery path; P15 replaces it.
15. U6 also implements POST /v1/instances (create; replaces P04b's 501 stub — the stub's own comment assigns it to P08) with a max_registered_instances 409 guard.
16. Production `expectedTakeoverCheck` is wired `async () => false` (no takeover-record check exists yet) — every 440 pauses with SESSION_REPLACED instead of silently resolving an expected takeover; fail-safe conservative default, the runner's injectable seam is ready; P09 (fleet/takeover) wires the real check. CARRIED to P09.
17. The bridge wire format strips `clientId` around `realtimeEventSchema` validation (routing metadata vs .strict() schema) — discovered red-first, mirrors hub.ts's own eventOnly split.
18. C1 first pass: **CHANGES-REQUIRED** — 3 CRITICAL (production runner-factory froze the fence at composition time as 0n, so real wiring could never mark linked/connected or purge — tests injected fences and missed it; slot count off-by-one 409s a re-online against itself; counterIsRestart515 inferred from counter totals → delay-0 hot loop on 428-after-515), 6 WARNING (end_socket flag suppresses the actual socket close on the 440 takeover branch → socket leak; teardown double-release of the lease; reconnect timer set after an await escapes teardown's clear; OPAQUE_PAYLOAD_KEYS keyed by bare key not event:key; REQUIRED_RUNTIME_KEYS ≤4 cap documented not enforced; attemptsLeft literal duplicated between route and pairing), 3 SUGGESTION (per-tick registry sweep issues N queries; bridge publish errors silently discarded; null pairing_started_at → NaN → fail-OPEN window). Reviewer confirmed clean: bridge tenant isolation end-to-end, QR bearer handling, FOR UPDATE slot lock, definer-fn hardening, evasion surface, 440-conservative default (P09 must close before rolling deploys). FIX batches after C2.
19. C2 all-cases: 10 probes green + ONE more REAL bug pinned red — the `update.qr` branch of onConnectionUpdate lacks the ended/generation guard; after a Redis-only fence loss a late qr event still increments qr_attempts (the PG fence row never moved) and publishes. Covered green: crash-window repair idempotency; beginPairingIntent double-submit = safe re-arm; replayed close across generations; two workers one instance (exactly one acquires, loser clean); heartbeat fence-loss teardown-without-release; 6th-QR-at-zero-elapsed; park-beats-pending-reconnect-timer; 30×428 storm (timers ≤1, one audit row, monotonic backoff); bridge duplicate frames pinned acceptable-for-P08 (idempotent panel effects).
Fixes ran as FIX-P08-A (engine: frozen-fence thunk + composition-level linked/connected proof, explicit isRestart515, end_socket real close, release-once guard, timer teardown check, QR-branch guard + pin flip, null-window fail-closed, PAIRING_MAX_ATTEMPTS domain constant, batched sweep) ∥ FIX-P08-B (surfaces: slot off-by-one + idempotent re-online, event:key-paired payload exemption, REQUIRED_RUNTIME_KEYS cap enforcement + membership pin, bridge publish-error counter).
C2 files: `app/backend/src/modules/instances/instance-transitions.c2.integration.test.ts`, `app/backend/src/engine/session/{runner.c2.test.ts,session-worker-two-workers.c2.integration.test.ts}`, `app/backend/src/engine/lease/heartbeat-fence-loss-mid-pairing.c2.integration.test.ts`, `app/backend/src/modules/realtime/redis-bridge.c2.test.ts` — created.
20. Re-review of the fix batches: all 13 verified sound (A2's escalation-aware conjunct proven exact by enumeration; three-flag teardown interaction clear; fence-liveness test genuinely goes through the production factory) — but ONE NEW CRITICAL introduced by fix A9: the batched sweep read ran on the bare pool under FORCE RLS (0 rows under wp_app → mass-teardown of every healthy session per tick; BYPASSRLS test role masked it — THIRD occurrence of the class) + 1 WARNING (idempotent re-online appends phantom 'instance.online' audit rows) + 1 nit (comment sign). FIX round 2: per-client tenant-scoped sweep read (no migration; cross-tenant registry entry removed as no-longer-true), FAIL-CLOSED sweep semantics (absent ≠ deleted; missing ids kept + logged), wp_app-role two-tenant sweep test, changed-flag gating the audit insert, comment fixed. Structural follow-up for master-plan: pin integration-test DB role as non-BYPASSRLS (or default suites to wp_app) so this class cannot recur silently.
FIX round 2 files: `engine/session/session-worker-composition.ts` — changed (per-client withTenant sweep; fail-closed miss → client-scoped point-check); `modules/instances/instance-reads.repo.ts` — changed (readSweepTeardownStatuses takes InstanceCtx); `db/queries/instance-sweep-teardown-status.sql` — changed (client_id predicate); `scripts/registries/cross-tenant-queries.ts` — changed (false entry removed); `platform/db/test-support/wp-app-role.ts` — changed (createTenantDbAsRole); `engine/session/session-worker-sweep.wp-app-role.integration.test.ts` — created (two-tenant sweep under real wp_app); `session-worker-scan.integration.test.ts` — changed; `modules/instances/instance-online-slot.repo.ts` + `instances.routes.ts` — changed (changed-flag gates the audit); `__tests__/instance-link.caps.integration.test.ts` — changed (one-audit-row pin); `engine/session/pairing.ts` — comment fix.
Final re-verify: **APPROVED-with-notes** (point-check grants traced; fail-safe error paths; production read path exercised by the wp_app test). Notes fixed inline by main session: scan test renamed to the effect it proves (vacuous spy assertion dropped), SWEEP_POINT_CHECK_MISS_CAP=25/client/tick added (systemic short-read → keep remaining), stale eslint-disable removed (lint fully clean).
C5 attempt-1 fix (main session, mechanical): three deep imports of `tenancy/provisioning.repo.ts` from the instances module swapped to the tenancy barrel (`service.ts`, `instances.routes.ts`, `instance-transitions.wp-app-role.integration.test.ts`) — depcruise clean (559 modules / 1595 deps), touched test green.
FIX-P08-A files: `engine/session/{runner.ts,runner-types.ts,runner-disconnect.ts,pairing.ts,runner-test-instances-adapter.ts,session-worker-runner-factory.ts,session-worker-composition.ts,runner-test-support.ts}` — changed; `engine/session/{runner-test-fixtures.ts,runner.c2.teardown-race.test.ts,runner.c2.retry-storm.test.ts,session-worker-composition.fence-liveness.integration.test.ts}` — created; `packages/domain/src/instance/pairing-constants.ts` — created (+index.ts); `modules/instances/{instances.routes.ts,instance-reads.repo.ts}` — changed; `db/queries/instance-sweep-teardown-status.sql` — created; `scripts/registries/cross-tenant-queries.ts` — changed (sweep entry); pins flipped in heartbeat-fence-loss/runner-disconnect.edge/runner-reconnect tests; fixture corrections (seedProbe seeds a real pairing_started_at — the null fail-open bug had been an implicit test convenience).
FIX-P08-B files: `modules/instances/instance-online-slot.repo.ts` — changed (short-circuit already-online + others-excluding count); `db/queries/instance-read-desired-state.sql`, `instance-count-online-others.sql` — created; `packages/domain/src/realtime/assert-ids-only.ts` + `.test.ts` — changed (event:key-paired exemption); `modules/realtime/hub.ts` — changed (one line: pass parsed.type — makes the pairing effective in production); `provider/baileys/socket-factory.ts` + `socket-config.test.ts` — changed (cap assertion + membership pin); `modules/realtime/redis-bridge.ts` + `redis-bridge.edge.test.ts` — changed (publish-error catch + counter); `__tests__/instance-link.caps.integration.test.ts` — changed (idempotent re-online tests).

## Files created or changed this session
<!-- running list; the reviewer reviews exactly this list -->
U1 (provider/baileys foundations):
- `app/backend/src/provider/baileys/pinned.ts` + `pinned.test.ts` — created
- `app/backend/src/provider/baileys/socket-factory.ts` + `socket-config.test.ts` — created
- `app/backend/src/provider/baileys/disconnect-map.ts` + `disconnect-map.test.ts` — created (mandatory 10 green)
- `app/backend/src/provider/baileys/logout-call-sites.test.ts` — created
- `.memory/decisions/0013-v1-whatsapp-engine-baileys-qr.md` — changed (P08 re-derivation note appended)
U2 (domain):
- `packages/domain/src/instance/user-action-reasons.ts`, `session-fsm.ts` + `.test.ts`, `reconnect-policy.ts` + `.test.ts` — created
- `packages/domain/src/copy/instance-copy.ts` + `.test.ts` — created; `packages/domain/src/index.ts` — changed
Grants unblock (migration 0023, after U4's stop-line finding):
- `db/migrations/0023_wp_app_instance_state_grants.sql` — created (column-level SELECT/UPDATE + full-row INSERT on whatsapp_instances TO wp_app; no DELETE — soft-delete via UPDATE(deleted_at); nothing for wp_admin_app/wp_scheduler; RLS WITH CHECK insert binding proven live)
- `db/src/schema-version.ts` — changed (→23); `db/schema/grants.snapshot.json` — refreshed + verified
- `db/tests/grants-snapshot-p08-instances.test.ts` — created (red-first grant-surface pin; own file for max-lines)
U5-pre (P06 gate closure + seams):
- `db/src/pool.ts` — changed (CreatePoolOptions += connectionTimeoutMillis/statementTimeoutMs/idleInTransactionSessionTimeoutMs via pg `options` startup param)
- `db/tests/pool-timeouts.integration.test.ts` — created (`pg_leg_is_bounded`: pg_sleep(2) rejects with 57014 at 500ms bound)
- `packages/domain/src/timing.ts` + `timing.test.ts` — changed (pgConnectTimeoutMs 3_000, pgStatementTimeoutMs 5_000)
- `app/backend/src/engine/session/to-fsm-row.ts` + `.test.ts` — created (U1↔U2 action-literal seam, compile-time exhaustive, 16 cases)
- `packages/contracts/src/app/realtime.ts` — changed (instanceQrEventSchema += payload: z.string(), still .strict())
- `packages/domain/src/realtime/assert-ids-only.ts` — changed (narrow OPAQUE_PAYLOAD_KEYS exemption for the one bearer-credential field — reviewer attention requested)
- `packages/contracts/tests/realtime-events.test.ts`, `app/backend/src/modules/realtime/__tests__/sse-log-redaction.test.ts` — changed (shape pins updated)
U5a (runner core):
- `app/backend/src/engine/session/{connect-gate,registry,pairing,runner,runner-disconnect,runner-types,runner-test-support,runner-test-instances-adapter}.ts` — created
- `app/backend/src/engine/session/{connect-gate,registry,pairing,runner,runner-reconnect}.test.ts` — created (incl. sixth-QR no-auto-loop, window expiry, 428/403/515/give-up scheduling)
- `db/queries/instance-read-session-epoch.sql` — created; `app/backend/src/modules/instances/repo.ts` + `index.ts` — changed (readSessionEpoch → {sessionEpoch, healthState, linkState})
- main-session fix: unused import removed from `db/tests/pool-timeouts.integration.test.ts` (lint)
U5b (real-infra proofs):
- `app/backend/src/engine/session/pairing-isolation.integration.test.ts`, `pairing-redaction.integration.test.ts`, `runner-heartbeat.integration.test.ts` — created (tenant-channel isolation via real hub + full-keyspace scan; QR-never-in-logs/metrics/audit with negative control; lease renewal across the pairing window on the bounded pool)
- `app/backend/src/engine/session/runner-test-support.ts` — changed (harness bug found by real-hub schema validation: hardcoded empty instanceId)
U6a (ChannelLink adapter):
- `app/backend/src/provider/baileys/adapter.ts`, `adapter-types.ts`, `adapter.test.ts` — created (canonical ChannelLink; unlink = the ONLY legal `.logout(` site, best-effort + always purges via runLoggedOutFlow, idempotent; instanceId-only port with tenant/fence closed over at the composition root per the runner precedent)
- `app/backend/src/engine/session/registry.ts` — changed (optional getSock() accessor on RunnerHandle)
U6c (routes + contracts):
- `app/backend/src/modules/instances/instances.routes.ts` — rewritten (six routes replace the 501 stub); `instances.routes-support.ts`, `instance-reads.repo.ts` — created (reads moved out of repo.ts, resolving its max-lines overage); `index.ts` — changed
- `db/queries/instance-{link-status,count-registered,count-online,list-online-holders,plan-limits}.sql` — created (SELECT-only, client-scoped)
- `packages/contracts/src/instances.ts` — created; `router.ts`, `index.ts`, `errors.ts` (+REGISTERED_LIMIT_REACHED/NO_FREE_SLOT/INVALID_STATE→409) — changed
- `app/backend/src/modules/instances/__tests__/{instances-routes-test-support,instances-http-auth-helpers}.ts` + `instance-link.routes.integration.test.ts`, `instance-link.caps.integration.test.ts`, `instance-link.masking.integration.test.ts` — created
- `app/backend/src/modules/tenancy/__tests__/{onboarding,entitlement}.integration.test.ts` — changed (501 stub assertions → real 400 VALIDATION_ERROR)
U7 (Connect screen):
- `app/frontend/src/features/instances/` — created: `api.ts`, `index.ts`, `components/instances-screen.tsx`, `connect/{connect-stage.ts,useConnectFlow.ts,useLinkStream.ts,ConnectSheet.tsx,ConnectSheetBody.tsx,QrPanel.tsx,PairingCodePanel.tsx}` + 4 test files + helpers
- `app/frontend/src/lib/sse-event-registry.ts` + `.test.ts` — created (subscribeRealtimeEvent, additive); `lib/sse.ts`, `lib/sse-stream-consumer.ts` — changed (optional onEvent hook; P05 tests green)
- `app/frontend/src/routes/_authed/instances.tsx` — created (+ routeTree.gen.ts regenerated); `components/app-shell.tsx`, `features/dashboard/components/empty-dashboard.tsx` — changed (nav link; CTA → /instances)
- `packages/i18n/src/catalogues/{en,hi}.ts` — changed (instances.connect.* / instances.list.* / nav.instances)
- `app/frontend/package.json` — changed (qrcode 1.5.4 + @types/qrcode)
U6b (worker role + bridge):
- `app/backend/src/roles/session-worker.ts` — created (entrypoint; exports bootstrapScan; assertDbPreconditionsOrExit + assertSignalKeyspacePolicy at boot)
- `app/backend/src/engine/session/session-worker-composition.ts`, `session-worker-runner-factory.ts` — created (createSessionWorker factory outside roles/ for the guard's sake; socketFactoryLoggerFrom adapter that never forwards raw Baileys log objects)
- `app/backend/src/engine/session/session-worker-scan.integration.test.ts` — created (park_ends_the_socket_and_never_logs_out, worker half)
- `app/backend/src/modules/realtime/redis-bridge.ts` + `redis-bridge.integration.test.ts` — created (single sysKey(env,'rt','bridge') channel; schema-validated both sides; invalid frames dropped+counted; P15 replaces)
- `app/backend/src/main.ts` + `main.test.ts`, `app/backend/src/platform/config.ts` (ROLE += session-worker; ENC_VERSION) + `config.test.ts` — changed/created
FIX-E3 (implementer; all three E3 findings):
- `app/backend/src/engine/session/runner.ts`, `runner-types.ts` — changed (socket-generation single-flight close guard; onConnectionUpdateSafe fail-safe boundary: StateWriteLostFenceError → warn no-op, unexpected → teardown-without-release, never rethrown into a Baileys callback)
- `db/queries/instance-online-slot-lock-client.sql`, `app/backend/src/modules/instances/instance-online-slot.repo.ts` — created (atomic per-client FOR UPDATE slot check-and-set; wp_app UPDATE on clients verified live); `instances.routes.ts`, `index.ts` — changed
- pins flipped: `runner-disconnect.edge.integration.test.ts` (1 audit row; stray open resolves safely), `instance-link.edge.integration.test.ts` (race → exactly one 200 + one 409, final count = cap)
E3 edge pass (test-engineer, 25 cases; 2 REAL bugs + 1 race FINDING → FIX-E3):
- `packages/domain/src/instance/session-fsm.edge.test.ts`, `app/backend/src/engine/session/{connect-gate.edge.test.ts,runner-disconnect.edge.integration.test.ts,session-worker-scan.edge.integration.test.ts}`, `app/backend/src/modules/instances/{instance-transitions.stale-fence-storm.edge.integration.test.ts,instance-transitions.cross-tenant-engine.edge.integration.test.ts}`, `app/backend/src/modules/instances/__tests__/instance-link.edge.integration.test.ts`, `app/backend/src/modules/realtime/redis-bridge.edge.test.ts` — created
- Bugs: duplicate `close` events double the audit trail (no reentrancy guard); stray `open` after teardown escapes a Baileys callback as an unhandled rejection (storage layer held — fail-safe — but uncaught); RACE: two concurrent `online` calls can exceed max_connected_instances (count+set not atomic). All three fixed in FIX-E3, pins flipped.
U4 (instance transitions):
- `db/queries/instance-{create,begin-pairing,set-desired-state,reset-pairing-window,soft-delete,mark-linked-connected,increment-qr-attempts,mark-pairing-expired,mark-logged-out,apply-transition}.sql` — created (10)
- `app/backend/src/modules/instances/{repo.ts,service.ts,ownership.ts}` — created; `index.ts` — changed (barrel)
- `app/backend/src/modules/instances/__tests__/instances-test-helpers.ts` + 5 `instance-transitions.*.integration.test.ts` files — created (stale-fence, audit, pause-preserves-jobs, logged-out-purge + crash-injection, wp_app role proof)
- `app/backend/src/roles/api.ts` — changed (real createInstanceOwnership replaces fail-closed stub)
- `app/backend/src/modules/tenancy/provisioning.repo.ts` — changed (ALLOWED_AUDIT_METADATA_KEYS += 'code')
U3 (migration 0022):
- `db/migrations/0022_p08_instances_surface.sql` — created (DROP owner_worker_id + wp_session_bootstrap_scan definer fn)
- `db/schema/whatsapp-instances.ts`, `db/schema/grants.snapshot.json`, `scripts/registries/cross-tenant-queries.ts`, `db/src/schema-version.ts` (→22), `db/tests/schema-assertions.test.ts`, `db/tests/grants-snapshot.test.ts` — changed
- `app/backend/package.json` — changed: exact pinned Baileys version
- `app/backend/src/provider/baileys/pinned.ts` — created
- `app/backend/src/provider/baileys/socket-factory.ts` — created
- `app/backend/src/provider/baileys/disconnect-map.ts` — created
- `app/backend/src/provider/baileys/adapter.ts` — created (`ChannelLink` half only; `MessageTransport` lands in P11)
- `app/backend/src/engine/session/runner.ts` — created
- `app/backend/src/engine/session/registry.ts` — created
- `app/backend/src/engine/session/pairing.ts` — created
- `app/backend/src/engine/session/connect-gate.ts` — created (per-worker bucket; P09 swaps in the fleet bucket)
- `app/backend/src/modules/instances/{repo.ts,service.ts,routes.ts,index.ts}` — created/changed
- `app/backend/src/workers/session-worker.ts` — created (narrow bootstrap scan; P09 replaces)
- `packages/domain/src/instance/{session-fsm.ts,reconnect-policy.ts}` — created
- `packages/domain/src/copy/instance-copy.ts` — created
- `packages/contracts/src/instances.ts` — changed: link/park routes
- `app/frontend/src/features/instances/connect/*` — created
- `.memory/decisions/0013-v1-whatsapp-engine-baileys-qr.md` — changed: appended implementation note (pinned version, enum re-derivation date)
- all test files named in the table above — created

## Risks / gotchas specific to this phase
- **Carried from P06 (2026-08-31):** `whatsapp_instances.owner_worker_id` is a leftover duplicate — lease ownership lives in `instance_lease_state.owner_worker_id` since migration 0018, and nothing writes the `whatsapp_instances` copy. P08 owns this table's logic: drop the column in this phase's migration (or record why it stays). Also carried: P06's `SessionOwner` port (`app/backend/src/engine/lease/session-owner.port.ts`) deliberately has only `onFenceLost`/`close` — reconnect policy lands here, as a separate policy module, never by adding `reconnect()` to the port for the lease engine to call.
- **`DEFAULT_CONNECTION_CONFIG` will not contain every key we legitimately pass** (`auth`, `logger`, `getMessage`-style runtime wiring). Do **not** loosen the assertion into a warning: put the exceptions in the ≤4-entry `REQUIRED_RUNTIME_KEYS` array with a comment each, and keep the test failing for anything else. A silently-reverted option is an unbounded default in production.
- Baileys' default export is ESM/CJS-interop sensitive. If `makeWASocket is not a function` appears, fix the import shape in `socket-factory.ts` (one place) — never by loosening `tsconfig` module settings repo-wide.
- The numeric `DisconnectReason` values in the blueprint are **library knowledge, not gospel**. Re-derive them from the pinned enum in step 1; if a value differs, the map follows the enum and the difference is recorded in the session log.
- Post-pairing `515` on the happy path is the classic false alarm: it must never flash an error, never set `degraded`, and never consume backoff budget. Test it before demoing to anyone.
- The QR string is a **bearer credential**: publish it only on the tenant channel, never log it, never make it a metric label, never store it in `audit_logs.metadata`. One careless `logger.info({qr})` fails the phase.
- Safety boundary: nothing in this phase may auto-resume out of a `paused` state, and **no code path may set `desired_state='offline'` in response to a signal** — parking is an explicit human action only (ADR 0018 §1). Also: one constant browser identity; varying it per session is fingerprint manipulation and is forbidden.
- Use the injected clock for the 45 s ring and the 5-minute window. Real timers make this suite flaky and hide the bound.
- The live-scan demo touches a real WhatsApp account. Link only; send nothing. If the scan fails twice, stop and check the pinned version against Baileys' current protocol support rather than retrying the number.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P09 — session-fleet-and-drain. Read plan/v1/P09-session-fleet-and-drain.md and follow it exactly:
one phase, one session. Deps P08 are done (see plan/README.md). Do not start P10.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
