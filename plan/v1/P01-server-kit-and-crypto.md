# P01 — server-kit-and-crypto

**Goal (one line):** `@wp/server-kit` exists with tenant context, config, redacting logger, error mapper, metrics registry, AES-256-GCM envelope encryption and a file-based `KeyProvider` key ring — so nothing after this phase ever has to invent crypto, logging or error shape.
**Status:** done (2026-08-26) · **Size:** M · **Session:** 1 of 1
**Depends on:** P00 (must be `done`)
**Blocks:** P02, P06, P07

## Prerequisites (facts, not phases)
- P00 is `done`: pnpm workspace, TS project references, `packages/server-kit` folder skeleton, `@wp/domain`, `@wp/contracts` (error envelope + error-code union), dependency-cruiser, `scripts/check-*.ts`, `scripts/ci.ps1`.
- `scripts/ci.ps1` is **green on the tree as you found it**, every guard reporting a non-zero matched-file count (SESSION-PROTOCOL O2).
- Node 24 + pnpm installed. **This phase needs no Postgres, no Redis, no Docker** — every test here is a pure unit test.
- ADRs 0002 (stack), 0013 (Baileys engine), 0014 (repo structure), 0018 (metric-label allow-list), 0020 (phase/session protocol) accepted.
- No production key ring exists yet and none is created here. Everything this session touches is a **dev/test** key ring.

## What you are building (3-6 bullets)
- `TenantContext` + `runInTenant()` (AsyncLocalStorage). Missing context **throws**; it never defaults to "all tenants". The `SET LOCAL app.client_id` half belongs to `withTenant`/`TenantDb` in **P02** — do not build it here.
- Zod-parsed frozen `config` loaded once at boot (the single `process.env` reader), a shared pino logger with a **field allow-list serializer**, the `AppError` hierarchy + HTTP envelope mapper, and a metrics registry that enforces the `wp_` prefix and the label allow-list.
- Envelope AES-256-GCM: DEK per record, KEK per purpose, **split AAD** (blueprint § Security → Encryption), plus `rewrapDek()` so KEK rotation touches only the wrapped DEK.
- `KeyProvider` interface + `FileKeyProvider` reading a purpose-separated key ring file; a missing purpose fails closed with `CRYPTO_KEY_UNAVAILABLE` (this is what makes "an RCE in the API cannot decrypt a session" true).
- A codec-injected JSON boundary (`sealJson`/`openJson`) so the auth-state serialisation happens **exactly once in each direction**, and mandatory tests 8 and 9 go green.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | § Security, tenant isolation & encryption → *Encryption*, *Auth*, *Hardening*; § Testing strategy tests **8** and **9**; row 15 of the decisions table |
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | the "one serialisation boundary" paragraph (search `BufferJSON.replacer`) |
| Data & security design | `.memory/research/2026-08-25-v1-design-data-and-security.md` | §4.2 envelope, §4.3 key ring + purpose table, §4.5 the one crypto module, §4.6 rotation, §"log field allow-list" |
| Repo structure design | `.memory/research/2026-08-25-v1-design-repo-structure.md` | §2.2 dependency graph, §5 base services table |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | § *What breaks first* row 7 (metric cardinality); § Observability ("one rule, not two") |
| ADR | `.memory/decisions/0002-tech-stack.md` | — |
| ADR | `.memory/decisions/0014-repo-structure-shared-packages-and-conventions.md` | binding rules 4 and 5 |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | — |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/api.md` | error envelope + logging only (`database.md` and `queue-workers.md` are out of scope this phase) |
| Safety | `.claude/skills/safety-compliance/SKILL.md` | honest-claims section |

## Ordered minimum steps
- [x] 1. Wire the package: exports map (one subpath per module, no deep imports), `composite: true` tsconfig + project reference, vitest project, runtime deps (`zod`, `pino`, `prom-client`, `node:crypto` only) and an **exact-version test-only** `baileys` devDependency; add a depcruise rule `server-kit-src-never-imports-baileys` scoped to `packages/server-kit/src/**`; record the exact Baileys version in the Files list below and carry it to P08 → `packages/server-kit/package.json`, `packages/server-kit/tsconfig.json`, `packages/server-kit/vitest.config.ts`, `packages/server-kit/src/index.ts`, `.dependency-cruiser.cjs` (changed), `tsconfig.json` (changed).
- [x] 2. TDD `TenantContext` + `runInTenant()` + `currentTenant()` over AsyncLocalStorage; unset context throws `TENANT_CONTEXT_MISSING` → `packages/server-kit/src/tenant/context.ts`, `packages/server-kit/src/tenant/context.test.ts`.
- [x] 3. TDD the config loader: Zod schema, parsed once, `Object.freeze`d, boot throws on anything missing/invalid; keys needed now are `WP_ENV`, `WP_LOG_LEVEL`, `WP_KEY_RING_PATH`, `WP_KEK_PURPOSES` (comma list of purposes this process is allowed to load), `WP_ENC_VERSION` → `packages/server-kit/src/config/schema.ts`, `packages/server-kit/src/config/index.ts`, `packages/server-kit/src/config/config.test.ts`.
- [x] 4. TDD the redacting logger: one shared pino instance (`level` from config, **no per-session bindings** — scope delta memory budget), a `LogFields` allow-list type and a serializer that **drops** every non-allow-listed key and hard-redacts `recipient`/`body`/`payload`/`creds`/`token`/`authorization`/`qr` → `packages/server-kit/src/obs/log-fields.ts`, `packages/server-kit/src/obs/logger.ts`, `packages/server-kit/src/obs/logger.test.ts`.
- [x] 5. TDD errors: `AppError` (code, httpStatus, expose, cause) + `CryptoError` whose `toString()`/`message` is `CRYPTO_<CODE>:{kek_id}` and nothing else, plus `toHttpEnvelope(err, requestId)` emitting the `@wp/contracts` envelope; unknown errors → 500 `INTERNAL` with `requestId` and no internal text → `packages/server-kit/src/errors/app-error.ts`, `packages/server-kit/src/errors/codes.ts`, `packages/server-kit/src/errors/to-http.ts`, `packages/server-kit/src/errors/to-http.test.ts`.
- [x] 6. TDD the metrics registry: `counter/gauge/histogram` factories over one `prom-client` Registry; registration **throws** on a missing `wp_` prefix, on a label outside `ALLOWED_LABELS`, and on `instance_id`/`client_id` used by any metric outside the four-name `INSTANCE_LABELLED_GAUGES` allow-list (`wp_instance_health_state`, `wp_instance_link_state`, `wp_instance_queue_depth`, `wp_instance_oldest_queued_seconds`) → `packages/server-kit/src/obs/metric-policy.ts`, `packages/server-kit/src/obs/metrics.ts`, `packages/server-kit/src/obs/metrics.test.ts`.
- [x] 7. TDD the key ring: `KekPurpose = 'session' | 'tenant-secrets' | 'user-secrets'`, `KeyProvider` interface (`getActive(purpose)`, `get(kekId, purpose)`), `FileKeyProvider` that reads + Zod-validates the ring at boot, rejects non-32-byte material, rejects a purpose mismatch, allows a `retired` key to **open but never seal**, keeps material out of every error/log, and throws `CRYPTO_KEY_UNAVAILABLE` for a purpose this process did not mount → `packages/server-kit/src/crypto/purposes.ts`, `packages/server-kit/src/crypto/key-provider.ts`, `packages/server-kit/src/crypto/file-key-provider.ts`, `packages/server-kit/src/crypto/key-ring-schema.ts`, `packages/server-kit/src/crypto/file-key-provider.test.ts`, `packages/server-kit/test/fixtures/key-ring.dev.json`.
- [x] 8. TDD the envelope: `seal(plaintext: Buffer, params): SealedBlob` / `open(blob, params): Buffer`, AES-256-GCM both layers, fresh 12-byte IV on **every** write, and the **split AAD written exactly once here** — `dekWrapAad = enc_version || kek_id || purpose`, `recordAad = enc_version || table_name || column_name || client_id || record_id`. `open()` derives both AADs from the blob's **own stored** `enc_version`/`kek_id`, never from the current constants → `packages/server-kit/src/crypto/aad.ts`, `packages/server-kit/src/crypto/sealed-blob.ts`, `packages/server-kit/src/crypto/envelope.ts`, `packages/server-kit/src/crypto/envelope.test.ts`.
- [x] 9. TDD rotation and the JSON boundary: `rewrapDek(blob, toKekId)` unwraps + rewraps the DEK only and leaves `ciphertext`/`iv`/`auth_tag` byte-identical; `sealJson(value, params, codec)` / `openJson(blob, params, codec)` take an injected `{ replacer, reviver }` so `@wp/server-kit` never imports Baileys at runtime → `packages/server-kit/src/crypto/rotate.ts`, `packages/server-kit/src/crypto/json-codec.ts`, `packages/server-kit/src/crypto/rotate.test.ts`, `packages/server-kit/test/auth-state-round-trip.test.ts`.
- [x] 10. Dev ergonomics + docs: a key-ring generator that writes a **dev-only** ring (refuses to run when `WP_ENV=production`, refuses to overwrite an existing file), the `.secrets/` exclusion added to `scripts/snapshot.ps1`, `@wp/server-kit` added to the `scripts/ci.ps1` typecheck/test set, and the crypto + logging conventions written down → `scripts/gen-key-ring.mjs`, `scripts/ci.ps1` (changed), `scripts/snapshot.ps1` (changed), `docs/CONVENTIONS.md` (changed).

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `packages/server-kit/test/kek-rotation.test.ts` | `kek_rotation_preserves_decryptability` | a real `initAuthCreds()` blob sealed under `k1`, rotated to `k2`, opens to **byte-identical** plaintext; `ciphertext`/`iv`/`auth_tag` unchanged, only `dek_wrapped`/`dek_iv`/`dek_tag`/`kek_id` changed. *(Moved from `envelope.test.ts` during the session: the case needs baileys' `initAuthCreds()`, and `src/**` may not import baileys — depcruise rule from step 1 — nor reach outside `rootDir: src`; `test/` is the phase-sanctioned home for the only baileys reference.)* |
| `packages/server-kit/src/crypto/envelope.test.ts` | `a_blob_sealed_at_enc_version_1_still_opens_after_the_constant_moves_to_2` | bumping `WP_ENC_VERSION` does not break existing rows; new writes carry 2 |
| `packages/server-kit/src/crypto/envelope.test.ts` | `a_blob_moved_to_another_tenant_fails_to_open` | same ciphertext + different `client_id`/`record_id` in the record AAD → auth-tag failure, `CryptoError`, no plaintext |
| `packages/server-kit/src/crypto/envelope.test.ts` | `a_tampered_ciphertext_byte_fails_the_auth_tag` | one flipped bit → throws, never returns partial plaintext |
| `packages/server-kit/src/crypto/envelope.test.ts` | `every_seal_uses_a_fresh_iv` | 1,000 seals of the same plaintext → 1,000 distinct IVs and 1,000 distinct ciphertexts |
| `packages/server-kit/test/auth-state-round-trip.test.ts` | `auth_state_round_trip_preserves_buffers` | real `initAuthCreds()` → `sealJson` → `openJson` deep-equals the original **and** `Buffer.isBuffer()` is true for every key field (the double-parse bug class) |
| `packages/server-kit/test/auth-state-round-trip.test.ts` | `a_double_parse_is_unrepresentable` | no exported function accepts or returns a JSON string; `openJson` returns the object, and a value passed through the boundary twice is detected, not silently mangled |
| `packages/server-kit/src/crypto/rotate.test.ts` | `a_dek_wrapped_for_one_purpose_cannot_be_unwrapped_by_another_purposes_kek` | purpose is in the DEK-wrap AAD → cross-purpose unwrap throws |
| `packages/server-kit/src/crypto/file-key-provider.test.ts` | `a_missing_purpose_key_throws_CRYPTO_KEY_UNAVAILABLE` | a provider booted without the `session` purpose cannot open a session blob (threat model row 4) |
| `packages/server-kit/src/crypto/file-key-provider.test.ts` | `a_retired_kek_opens_but_never_seals` | `get('k1')` works, `getActive()` never returns a retired key |
| `packages/server-kit/src/crypto/file-key-provider.test.ts` | `a_key_ring_with_short_or_non_base64_material_fails_to_load` | boot throws with a code, not a stack containing material |
| `packages/server-kit/src/crypto/file-key-provider.test.ts` | `key_material_never_appears_in_an_error_or_a_log_line` | serialise the provider, the thrown errors and a full log stream; grep for the base64 material → zero hits |
| `packages/server-kit/src/tenant/context.test.ts` | `a_call_without_tenant_context_throws` | `currentTenant()` outside `runInTenant` throws `TENANT_CONTEXT_MISSING`; there is no default client id |
| `packages/server-kit/src/tenant/context.test.ts` | `two_concurrent_tenant_contexts_do_not_bleed` | two interleaved async `runInTenant` calls each observe only their own `clientId` |
| `packages/server-kit/src/config/config.test.ts` | `boot_fails_on_a_missing_required_env_var` | throws at load, names the key, prints no value |
| `packages/server-kit/src/config/config.test.ts` | `config_is_frozen_and_process_env_is_read_once` | mutation throws; a second `process.env` change is not observed |
| `packages/server-kit/src/obs/logger.test.ts` | `a_non_allow_listed_field_is_dropped` | `{ recipient, body, payload, creds, token, authorization, qr }` never reach the output stream |
| `packages/server-kit/src/errors/to-http.test.ts` | `an_unknown_error_becomes_a_500_envelope_with_a_request_id_and_no_internal_text` | envelope matches `@wp/contracts`; no stack, no message leak |
| `packages/server-kit/src/errors/to-http.test.ts` | `a_crypto_error_stringifies_to_a_code_and_kek_id_only` | `String(err)` === `CRYPTO_DECRYPT_FAILED:{kek_id}` |
| `packages/server-kit/src/obs/metrics.test.ts` | `a_metric_with_a_non_allow_listed_label_fails_at_registration` | throws at registration (boot), not at scrape |
| `packages/server-kit/src/obs/metrics.test.ts` | `only_four_gauges_may_carry_instance_id` | a fifth `instance_id`-labelled metric fails registration; the allow-list is exactly the four named gauges |

Mandatory-suite tests this phase makes green: **8** (`kek_rotation_preserves_decryptability`) and **9** (`auth_state_round_trip_preserves_buffers`) from the blueprint's gating engine suite.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green (all 12 steps, 205 unit tests, 2026-08-26).
- [x] Named tests above exist and pass; no test is skipped or `.only`. (One placement deviation, documented in the table: `kek_rotation_preserves_decryptability` lives in `test/kek-rotation.test.ts`.)
- [x] `reviewer` verdict recorded: **APPROVED-with-notes** (2 CRITICALs found and fixed + re-reviewed same session; carried notes filed in `.memory/progress/master-plan.md`).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding — written answers in the session log.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- fill during the session; the reviewer reviews exactly this list -->
- `packages/server-kit/package.json` — changed: exports map (`.`, `./tenant`, `./config`, `./obs`, `./errors`, `./crypto`), runtime deps zod/pino/prom-client, test-only devDependency **`baileys@7.0.0-rc14` (exact pin — carry to P08)**
- `packages/server-kit/src/index.ts` — changed: re-exports the five subpath modules
- `packages/server-kit/src/tenant/index.ts` — created step 1, filled step 2 (re-exports context.ts surface)
- `packages/server-kit/src/tenant/context.ts` — created (TenantContext, TenantContextMissingError, runInTenant, currentTenant; role narrowed in P04)
- `packages/server-kit/src/tenant/context.test.ts` — created
- `packages/server-kit/src/config/index.ts` — created step 1, filled step 3 (single process.env reader, parse-once, deep-frozen, ConfigError names keys never values)
- `packages/server-kit/src/config/schema.ts` — created (Zod schema; `KEK_PURPOSES` single authority — crypto/purposes.ts re-exports from here)
- `packages/server-kit/src/config/config.test.ts` — created
- `packages/server-kit/src/obs/index.ts` — created step 1, filled steps 4/6 (logger + metrics re-exports)
- `packages/server-kit/src/obs/log-fields.ts` — created (LogFields type + runtime ALLOWED_LOG_FIELDS set, design §6.5 key set)
- `packages/server-kit/src/obs/logger.ts` — created (createLogger factory + shared singleton; hard-drops sensitive keys then allow-list filters; no .child())
- `packages/server-kit/src/obs/logger.test.ts` — created
- `packages/server-kit/src/obs/metric-policy.ts` — created (wp_ prefix, ALLOWED_LABELS, four-gauge instance/client label rule — ADR 0018)
- `packages/server-kit/src/obs/metrics.ts` — created (one prom-client Registry, policy-enforcing counter/gauge/histogram factories)
- `packages/server-kit/src/obs/metrics.test.ts` — created
- `packages/server-kit/src/errors/index.ts` — created step 1, filled step 5 (re-exports codes/app-error/to-http surface)
- `packages/server-kit/src/errors/codes.ts` — created (internal code table + exhaustive internal→contracts HTTP-code map)
- `packages/server-kit/src/errors/app-error.ts` — created (AppError + CryptoError; CryptoError message/toString is `<code>:<kekId>` only)
- `packages/server-kit/src/errors/to-http.ts` — created (toHttpEnvelope; unknown → 500 INTERNAL, no internal text)
- `packages/server-kit/src/errors/to-http.test.ts` — created
- `packages/server-kit/src/crypto/index.ts` — created step 1, filled steps 7-9 (crypto module public surface)
- `packages/server-kit/src/crypto/purposes.ts` — created (re-exports KEK_PURPOSES/KekPurpose from config/schema; purpose→mount table documented)
- `packages/server-kit/src/crypto/key-provider.ts` — created (KeyProvider interface + KekEntry with non-enumerable material, toJSON/inspect redaction)
- `packages/server-kit/src/crypto/key-ring-schema.ts` — created (Zod ring schema; 32-byte base64 refine; active/purpose/retired cross-checks)
- `packages/server-kit/src/crypto/file-key-provider.ts` — created (mounted-purposes fail-closed provider; retired opens never seals)
- `packages/server-kit/src/crypto/file-key-provider.test.ts` — created
- `packages/server-kit/test/fixtures/key-ring.dev.json` — created (dev/test-only ring, deterministic material, k1 retired)
- `packages/server-kit/src/crypto/aad.ts` — created (the ONE split-AAD implementation, length-prefixed encoding; recordAad has no rotation-mutated field)
- `packages/server-kit/src/crypto/sealed-blob.ts` — created (SealedBlob type, snake_case per-record fields per design §4.2)
- `packages/server-kit/src/crypto/envelope.ts` — created (seal/open AES-256-GCM both layers; open derives AADs from the blob's own enc_version/kek_id; single-code error surface CRYPTO_ENCRYPT_FAILED/CRYPTO_DECRYPT_FAILED)
- `packages/server-kit/src/crypto/envelope.test.ts` — created (4 named + 6 extra cases; the kek_rotation case lives in test/kek-rotation.test.ts, see amended table)
- `packages/server-kit/src/crypto/rotate.ts` — created (rewrapDek: DEK-wrap layer only; retired target rejected; blob's own enc_version used)
- `packages/server-kit/src/crypto/json-codec.ts` — created (JsonCodec, sealJson/openJson — the ONE serialisation boundary; string in / string out both throw)
- `packages/server-kit/src/crypto/rotate.test.ts` — created (cross-purpose unwrap, retired-target rejection, bytes-preserved)
- `packages/server-kit/test/auth-state-round-trip.test.ts` — created (mandatory test 9 + a_double_parse_is_unrepresentable)
- `packages/server-kit/test/kek-rotation.test.ts` — created (mandatory test 8, real initAuthCreds via test/ helper)
- `packages/server-kit/test/fixtures/auth-creds.ts` — created (the ONLY baileys-importing module; makeAuthCreds + authStateCodec)
- `scripts/gen-key-ring.mjs` — created (dev-only ring generator; refuses WP_ENV=production, refuses overwrite, never prints material)
- `scripts/check-tree.ts` — changed: `.secrets` added to the top-level allow-list
- `scripts/guards/check-tree.test.ts` — changed: `.secrets` allow-list regression test
- `docs/CONVENTIONS.md` — changed: crypto + logging conventions (incl. the mandatory honest-claims pairing; check-copy green)
- `scripts/snapshot.ps1` — **created** (was missing entirely — P00 completeness gap found this session; design §6.6 spec, `.secrets`/`node_modules`/`demo`/`dist`/`coverage`/`.env*`/`*.tsbuildinfo` excluded, -DryRun, VERSION/CHANGELOG bump; lesson filed at C6)
- `scripts/ci.ps1` — verified, NO edit: root `tsc -b` and root vitest already cover @wp/server-kit (no explicit package list exists to extend)
- `packages/server-kit/src/crypto/envelope.ts` — changed (E3 hardening): seal/open reject empty `clientId`/`recordId` (empty ids would void the tenant binding in the record AAD)
- `packages/server-kit/src/crypto/aad.test.ts` — created (E3: length-prefix non-collision, unicode, empty-field byte-shift)
- `packages/server-kit/src/crypto/envelope-edge-cases.test.ts` — created (E3: empty/5MB plaintext, per-field tampering, franken-blob, unknown kek_id)
- `packages/server-kit/src/crypto/rotate-edge-cases.test.ts` — created (E3: same-kek rewrap pinned, tampered-wrap, double rotation)
- `packages/server-kit/src/crypto/key-ring-schema.test.ts` — created (E3: proto-pollution kek ids, shared kek id rejected, root-shape cases)
- `packages/server-kit/src/crypto/edge-cases.test.ts` — created (E3: codec Buffer/Uint8Array/null/BigInt pins, double-stringify detection, documented codec limitation)
- `packages/server-kit/src/tenant/context.test.ts` — extended (E3: reentrancy, outside-chain no-bleed, ctx-not-frozen pinned)
- `packages/server-kit/src/config/config.test.ts` — extended (E3: purposes whitespace/comma cases, WP_ENC_VERSION rejects 0/-1/1.5/abc/'')
- `packages/server-kit/src/obs/logger.test.ts` — extended (E3: shallow-allow-list and free-text-message gaps pinned as by-design)
- `packages/server-kit/src/obs/metrics.test.ts` — extended (E3: registry isolation, label-value non-validation pinned)
- `packages/server-kit/src/errors/to-http.test.ts` — extended (E3: kekId injection non-leak, cause chain never serialized)
- `packages/server-kit/src/crypto/envelope.test.ts` — extended (E3), `rotate.test.ts` — extended (E3), `file-key-provider.test.ts` — extended (E3)
- `packages/server-kit/vitest.config.ts` — created
- `packages/server-kit/tsconfig.json` — changed: added `"types": ["node"]` (Node-only package; pnpm isolation kept root @types/node invisible)
- `vitest.config.ts` — changed: added `packages/*/test/**/*.test.ts` to root include
- `.dependency-cruiser.cjs` — changed: added `server-kit-src-never-imports-baileys` rule
- `scripts/guards/__fixtures__/depcruise/packages/server-kit/src/uses-baileys.ts` — created (fixture violating the new rule)
- `scripts/guards/depcruise.test.ts` — changed: added `server_kit_src_importing_baileys_is_rejected`
- `scripts/guards/registry.ts` — changed: added `depcruise:server-kit-never-imports-baileys` guard entry

## Risks / gotchas specific to this phase
- **The AAD formula is split, and the design doc is out of date.** `2026-08-25-v1-design-data-and-security.md` §4.2 shows one combined AAD; the **blueprint supersedes it** with two (DEK-wrap vs record). Implement the blueprint's split — a combined AAD containing `kek_id` makes KEK rotation impossible without re-encrypting every bulk ciphertext, and mandatory test 8 will go red for a reason nobody attributes.
- **`open()` must read `enc_version` and `kek_id` off the blob**, never from `config`. Deriving the AAD from current constants means the day someone bumps `WP_ENC_VERSION` every existing session credential becomes undecryptable — a fleet-wide re-QR event with no rollback.
- **Buffer vs `{type:'Buffer',data:[...]}`.** A plain `JSON.parse` round-trips Baileys key material into objects that pass a loose deep-equal and then fail inside libsignal at send time. Assert `Buffer.isBuffer()` explicitly, per field. This is the exact bug class the evolution-api review flagged (double parse).
- **Never import Baileys from `packages/server-kit/src/**`.** The codec is injected; the only Baileys reference this phase is allowed is the test-only devDependency used by `packages/server-kit/test/auth-state-round-trip.test.ts`. The depcruise rule from step 1 is what keeps that true.
- **No real key ring is created, copied, printed or committed.** `scripts/gen-key-ring.mjs` is dev-only and refuses to run under `WP_ENV=production`. Production key-ring provisioning, the 3-copy rule and the restore drill are P29 — do not pre-build them here.
- **Honest-claims trap.** Anything written in `docs/CONVENTIONS.md` about encryption must stay inside what the blueprint's "What we can and cannot promise" allows: no plaintext session credential at rest, **and** the plain statement that a live session is decrypted in worker memory and cannot be protected from root on the host. Do not write "end-to-end encrypted" or "zero gaps" anywhere.
- **If the session is running out of time**, the safe split line is after step 9: steps 1-5 and 7-9 deliver the phase's demonstrable outcome; step 6 (metrics registry) and step 10 (dev generator + docs) become `P01a-server-kit-metrics-and-tooling.md`, added as a row in `plan/README.md`. Do **not** split inside the crypto steps — a half-built envelope is worse than no envelope.
- **Scope creep to refuse:** cache, rate limiter, storage, audit writer, queue client, event bus, notifier and feature flags are also `@wp/server-kit` services, but they are **not** this phase. They land with the phases that first need them. Same for `withTenant`/`SET LOCAL` (P02) and the narrow `decryptSessionCreds(ctx, instanceId)` wrapper (P07).

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P02 — db-foundations-and-isolation. Read plan/v1/P02-db-foundations-and-isolation.md
and follow it exactly: one phase, one session. Deps P01 are done (see plan/README.md).
Do not start P03. Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
