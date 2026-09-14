# P07 — session-auth-store

**Goal (one line):** An `EncryptedAuthStore` exists that keeps every WhatsApp credential envelope-encrypted (non-rebuildable material in Postgres, Signal session material in a `noeviction` Redis keyspace), refuses every write from a stale fence, and is fed by **our own** bounded `SignalKeyStore`.
**Status:** done · **Size:** M · **Session:** 1 of 1
**Depends on:** P06 (must be `done`), and transitively P01, P02, P03
**Blocks:** P08, P09, P21

## Prerequisites (facts, not phases)
- Postgres 17 + Redis 7 up via `infra/compose/docker-compose.dev.yml`; `ROLE=migrate` runner works; boot schema-version assertion in place (P02).
- `@wp/server-kit` envelope service exists with `seal`/`open`, the split AAD formula and a `KeyProvider` key ring; mandatory tests 8 (`kek_rotation_preserves_decryptability`) and 9 (`auth_state_round_trip_preserves_buffers`) are already green (P01). **Do not re-implement AES here — call the one envelope service.**
- The `session` purpose KEK is mounted into worker containers only (never the API container).
- `instance_lease_state` exists and is the fence authority; a worker can obtain its `current_fence` for an instance (P06). `whatsapp_instances.current_fence`/`lease_seen_at` no longer exist.
- `whatsapp_instances`, RLS FORCE, the four Postgres roles, the grant snapshot test and isolation suites A/C exist (P02).
- ADRs 0013, 0014, 0015, 0017, 0018 accepted. There is no git; the file list at the bottom is the diff.
- **This phase installs and pins `baileys` at an exact version** (no `^`, no `~`) in `app/backend/package.json` — it is the first phase that needs Baileys types (`SignalKeyStore`, `initAuthCreds`, `BufferJSON`, `SignalDataTypeMap`). Record the pinned version in ADR 0013's implementation note at C6.

## What you are building (3-6 bullets)
- Two durable tables — `whatsapp_session_credentials` (1:1) and `whatsapp_session_keys` (1:N, `CHECK` limited to `pre-key` / `app-state-sync-key` / `app-state-sync-version`) — with the full envelope-crypto column set, RLS FORCE and their own separate GRANTs.
- **One** serialisation boundary module: `JSON.stringify(value, BufferJSON.replacer)` → `envelope.seal`, and `envelope.open` → `JSON.parse(…, BufferJSON.reviver)`, each exactly once, with a CI guard that no other file may import `BufferJSON`.
- A Redis tier for `session` / `sender-key` material on a **`noeviction`** keyspace (TTL 30 d) with a boot-time policy assertion, plus `sender-key-memory` on the rebuildable `allkeys-lru` cache tier.
- `EncryptedAuthStore` (`loadCreds`, `saveCreds({expectedVersion, fence})`, `getKeys`, `setKeys(…, fence)`, `purge(…, fence)`): upsert saveCreds, per-instance promise-chain serialisation, version-conflict retry ×3 with **no** health-state change, fence-conflict self-fence.
- `makeBoundedSignalKeyStore` — **our module**, not a Baileys export — implementing Baileys' `SignalKeyStore` with LRU + TTL + write-through eviction and the 2,000 tracked-group-participant-device cap.

## Read first (do not search — these are the canonical sources)
| What | Path | Section |
|---|---|---|
| Blueprint | `.memory/research/2026-08-25-v1-architecture-blueprint.md` | `Encrypted auth state`; `WhatsApp instances` (the two session tables, line ~236); `Lease + fence (single writer)`; `Encryption` (split AAD, purpose-separated KEKs); `Redis` key grammar (`wp:{env}:{purpose}:c:{client}:i:{instance}:{rest}`); mandatory suite rows 4, 7, 8, 9 |
| Scope delta | `.memory/research/2026-08-26-v1r-scope-delta-and-decisions.md` | `Redis, Signal state and inbound decryptability`; `Techniques, and what each buys` + the **two corrections to the socket factory** (`makeBoundedSignalKeyStore` is ours); `Invariant compliance` rows 2, 3, 4 |
| ADR | `.memory/decisions/0013-v1-whatsapp-engine-baileys-qr.md` | constraints 3 and 4 |
| ADR | `.memory/decisions/0018-ten-thousand-session-target-memory-budget-and-connected-unit.md` | §5 (Signal records are not evictable), §2 (2,000 tracked participant devices) |
| ADR | `.memory/decisions/0014-repo-structure-shared-packages-and-conventions.md` | backend layering rules |
| Invariants | `.claude/rules/core-invariants.md` | all |
| Path rules | `.claude/rules/db-*.md`, `.claude/rules/queue-*.md` | all |
| Protocol | `plan/SESSION-PROTOCOL.md` | O1-O3, E1-E3, C1-C7 |

## Dispatch plan (SESSION-PROTOCOL E1; written at session open 2026-08-31)
- **U1 (implementer):** steps 2 + 3 — `@wp/domain` key-type constants + exact `baileys` pin; codec serialisation boundary + CI guard + guard test. Runs FIRST: step 1's enum-parity test imports `DURABLE_KEY_TYPES` from `@wp/domain`, so the domain constants must exist before the db unit's test can compile (recorded reorder of step 1 after steps 2/3).
- **U2 (db-engineer, solo — contains a migration, never parallel):** step 1 — migration + two schema files + RLS FORCE + GRANTs + suite A registration + grant snapshot refresh + `db/test/schema/session-auth-state.test.ts`.
- **U3 (implementer):** steps 5 + 6 — Redis tiering (`redisSig`/`redisCache`, boot assertion, config, compose) + redis repo + `redis-tier.test.ts`. PARALLEL with U4 (disjoint file scopes).
- **U4 (implementer):** step 4 — pg repo + `classifyWriteMiss()` + the two pg-level `save-creds.test.ts` cases. PARALLEL with U3.
- **U5 (implementer):** steps 7 + 8 — store + types + bounded key store, with `fence.test.ts`, concurrent-save case, `store-round-trip.test.ts`, `purge.test.ts`, `bounded-key-store.test.ts`.
- **U6 (test-engineer, then implementer for fixes):** step 9 — `no-plaintext.test.ts` + isolation suite C Redis-key-grammar row.

## Ordered minimum steps
TDD applies to every step: write the test named in the table below **first**, watch it fail, then implement. Tick the box only when that dispatch is green, and append every touched path to the file list as you go.

- [x] 1. **(db-engineer)** Migration for the two session tables, additive and forward-only → `db/migrations/00NN_session_auth_state.sql`, `db/schema/tables/whatsapp_session_credentials.sql`, `db/schema/tables/whatsapp_session_keys.sql`.
      `whatsapp_session_credentials(instance_id PK, client_id NOT NULL, ciphertext, iv, auth_tag, dek_wrapped, dek_iv, dek_tag, kek_id, enc_version, session_epoch, cred_version bigint, owner_fence bigint, updated_at, rotated_at)` FILLFACTOR 80;
      `whatsapp_session_keys(instance_id, client_id NOT NULL, key_type, key_id, <same crypto columns>, owner_fence, updated_at, PK(instance_id,key_type,key_id))` with `CHECK (key_type IN ('pre-key','app-state-sync-key','app-state-sync-version'))`, FILLFACTOR 70 + aggressive autovacuum. RLS FORCE on both; separate GRANTs (session-worker role only — the API role gets nothing); register both in isolation suite A coverage and refresh the grant snapshot.
- [x] 2. **(implementer)** Pure key-type classification and constants in `@wp/domain` (browser-safe, no Node builtins) → `packages/domain/src/session/auth-key-types.ts`: `DURABLE_KEY_TYPES`, `SIGNAL_KEY_TYPES` (`session`, `sender-key`), `REBUILDABLE_KEY_TYPES` (`sender-key-memory`), `SIGNAL_KEY_TTL_MS = 30d`, `MAX_TRACKED_GROUP_PARTICIPANT_DEVICES = 2000`, and `classifyAuthKeyType()` which **throws on an unknown type** (never silently defaults to Redis). Pin `baileys` exactly in `app/backend/package.json` in this same step.
- [x] 3. **(implementer)** The single serialisation boundary → `app/backend/src/provider/baileys/auth-state/codec.ts` (`sealAuthValue` / `openAuthValue`, taking `{table, column, clientId, recordId}` for the record AAD and delegating to `@wp/server-kit`'s envelope service) **plus** the CI guard `scripts/check-serialisation-boundary.ts` asserting `BufferJSON` is imported by exactly this one file, wired into `scripts/ci.{ps1,sh}` and into the guard meta-assertion (non-zero matched-file count).
- [x] 4. **(implementer)** Postgres repo → `app/backend/src/provider/baileys/auth-state/pg-repo.ts`: `loadCreds`, upsert `saveCreds`, `getKeys`/`setKeys` for durable types, `purgeDurable`. Canonical upsert predicate (verify column names against P06's migration):
      `INSERT … ON CONFLICT (instance_id) DO UPDATE SET … WHERE whatsapp_session_credentials.cred_version = $expectedVersion AND whatsapp_session_credentials.owner_fence <= $fence AND EXISTS (SELECT 1 FROM instance_lease_state ls WHERE ls.instance_id = $instanceId AND ls.client_id = $clientId AND ls.current_fence = $fence) RETURNING cred_version`.
      Zero rows is **ambiguous** — a classifier `classifyWriteMiss()` re-reads `cred_version` and the lease fence and returns `'version_conflict' | 'fence_conflict'`, because the two demand opposite actions.
- [x] 5. **(implementer)** Redis tiering in platform wiring → `app/backend/src/platform/redis.ts` (add `redisSig` and `redisCache` handles alongside `redisCtl`; separate config URLs that may point at one server in dev, so the 2,000-session split is config not a rewrite), `app/backend/src/platform/redis-assertions.ts` (`assertSignalKeyspacePolicy()` — `CONFIG GET maxmemory-policy` on `redisSig` must be `noeviction`, otherwise **refuse to boot**), and `infra/compose/docker-compose.dev.yml` (a `redis-sig` service with `--maxmemory-policy noeviction`).
- [x] 6. **(implementer)** Redis repo → `app/backend/src/provider/baileys/auth-state/redis-repo.ts`: one HASH per `(instance, key_type)` keyed only through `tenantKey()` as `wp:{env}:sig:c:{client}:i:{instance}:h:{key_type}`, fields = `key_id`, values = sealed envelopes; TTL 30 d refreshed on write; `sender-key-memory` goes to `redisCache` instead. `HMGET`/`HSET`/`HDEL` only — **never `HGETALL`, never `SCAN`** — so `purge` is a `DEL` of ≤3 keys. A write failure raises a typed `SignalStateWriteError` that degrades the instance (stop claiming, keep the socket, jobs preserved); it is never swallowed.
- [x] 7. **(implementer)** The store itself → `app/backend/src/provider/baileys/auth-state/store.ts` + `types.ts`: routes each key type via `classifyAuthKeyType()`; serialises `saveCreds` per instance behind a promise chain; on `version_conflict` reloads and retries up to 3 times leaving `health_state` untouched; on `fence_conflict` self-fences and releases the lease through P06's lease module; `purge(fence)` deletes both tables, deletes the Redis hashes and bumps `session_epoch` in **one** transaction with the audit row.
- [x] 8. **(implementer)** `makeBoundedSignalKeyStore` → `app/backend/src/provider/baileys/auth-state/bounded-key-store.ts`, implementing the pinned Baileys `SignalKeyStore` (`get(type, ids)`, `set(data)`, and `transaction` if the pinned version requires it): LRU + TTL over the store, write-through on eviction, a hard per-instance cap of `MAX_TRACKED_GROUP_PARTICIPANT_DEVICES`, and `null`/`undefined` values in `set()` meaning **delete**, not "store null". Counters `wp_signal_keystore_hit_total`, `wp_signal_keystore_miss_total`, `wp_signal_keystore_evicted_total`, `wp_signal_decrypt_failure_total{cause}` registered under the label allow-list (no `client_id`/`instance_id` labels).
- [x] 9. **(test-engineer, then implementer for fixes)** The security and isolation proof → `app/backend/test/integration/auth-state/no-plaintext.test.ts` and a new row in isolation suite C's Redis key enumeration: seed a real `initAuthCreds()`, save it, then scan **every column of both tables and every value in the sig/cache keyspaces** for the known plaintext markers (noise key bytes, `registrationId`, `advSecretKey`) and assert zero hits; assert every Redis key matches the `tenantKey()` grammar.

## Tests that prove it
| Test file | Case | Asserts |
|---|---|---|
| `app/backend/test/integration/auth-state/no-plaintext.test.ts` | `no_plaintext_credential_in_any_datastore` | every column of both tables and every sig/cache Redis value is free of the seeded plaintext markers of a real `initAuthCreds()` |
| `app/backend/test/integration/auth-state/fence.test.ts` | `stale_fence_cannot_save_setkeys_or_purge` | all three writes return **zero rows** under a stale fence; the live session's creds, keys and Redis hashes are byte-identical afterwards (mandatory 4, engine half) |
| `app/backend/test/integration/auth-state/save-creds.test.ts` | `concurrent_saveCreds_from_one_owner_does_not_release_the_lease` | 20 concurrent saves from the fence holder: all land, version conflicts retried, lease still held, `health_state` unchanged (mandatory 7) |
| `app/backend/test/integration/auth-state/save-creds.test.ts` | `first_save_of_a_new_instance_does_not_throw` | upsert path: `expectedVersion = 0` on a row that does not exist yet returns `cred_version = 1` |
| `app/backend/test/integration/auth-state/save-creds.test.ts` | `zero_rows_is_classified_as_version_or_fence_conflict` | `classifyWriteMiss()` returns `version_conflict` when the fence is current and `fence_conflict` when it is not |
| `app/backend/test/integration/auth-state/store-round-trip.test.ts` | `store_round_trip_preserves_buffers_through_pg_and_redis` | a real `initAuthCreds()` + a fake `session` record survive save→load with Buffer/Uint8Array identity intact (the double-parse bug class, at store level) |
| `app/backend/test/integration/auth-state/purge.test.ts` | `purge_removes_both_tables_and_every_redis_key_and_bumps_epoch` | after purge: zero rows in both tables, `EXISTS` false on all three hashes, `session_epoch` +1, one audit row — all in one transaction |
| `app/backend/test/integration/auth-state/redis-tier.test.ts` | `signal_keyspace_must_be_noeviction_or_boot_fails` | `assertSignalKeyspacePolicy()` throws when the sig keyspace reports `allkeys-lru` |
| `app/backend/test/integration/auth-state/redis-tier.test.ts` | `signal_write_failure_degrades_and_never_silently_continues` | a failing `redisSig` produces `SignalStateWriteError` → degraded instance, socket kept, zero jobs failed or deleted |
| `app/backend/src/provider/baileys/auth-state/bounded-key-store.test.ts` | `bounded_key_store_writes_through_on_eviction` | an evicted entry is readable again from the store; `wp_signal_keystore_evicted_total` +1 |
| `app/backend/src/provider/baileys/auth-state/bounded-key-store.test.ts` | `null_value_in_set_deletes_the_key` | `set({ 'pre-key': { '1': null } })` deletes; a later `get` returns nothing rather than a null record |
| `app/backend/src/provider/baileys/auth-state/bounded-key-store.test.ts` | `tracked_participant_devices_cannot_exceed_the_cap` | the 2,001st tracked device evicts LRU instead of growing (ADR 0018 §2) |
| `packages/domain/src/session/auth-key-types.test.ts` | `unknown_auth_key_type_throws` | an unmapped key type throws instead of defaulting to a tier |
| `app/backend/test/guards/serialisation-boundary.test.ts` | `bufferjson_is_imported_by_exactly_one_file` | the guard matches ≥1 file and fails when a second importer is added |
| `db/test/schema/session-auth-state.test.ts` | `session_key_type_check_matches_domain_durable_types` | the PG `CHECK` list equals `DURABLE_KEY_TYPES` from `@wp/domain` (enum-parity, prevents a runtime insert error under load) |

Mandatory-suite tests this phase makes green: **4** (the `save` / `setKeys` / `purge` half — the claim half lands in P11) and **7**. Tests 8 and 9 stay green from P01 and must not be re-implemented; the security suite gains `no_plaintext_credential_in_any_datastore`.

## Definition of done
- [x] Every step box above is ticked.
- [x] `scripts/ci.ps1` output pasted **verbatim** into the session log — green.
- [x] Named tests above exist and pass; no test is skipped or `.only`.
- [x] `reviewer` verdict recorded: APPROVED (or APPROVED-with-notes, notes filed).
- [x] Invariant check done (SESSION-PROTOCOL C3) with no unresolved finding.
- [x] The pinned Baileys version is written into ADR 0013's implementation note.
- [x] Files created/changed listed below (this list *is* the diff — there is no git).

## Files created or changed this session
<!-- ACTUAL list (the diff); corrected paths per repo conventions — see "Deviations recorded" below. -->
db/:
- `db/migrations/0020_session_auth_state.sql` — created (both tables, RLS FORCE, wp_app-only grants, FILLFACTOR, CHECK)
- `db/queries/session-creds-load.sql`, `session-creds-upsert.sql`, `session-creds-classify-miss.sql`, `session-keys-get.sql`, `session-keys-upsert.sql`, `session-keys-delete.sql`, `session-purge-durable-creds.sql`, `session-purge-durable-keys.sql`, `session-purge-epoch-bump.sql` — created
- `db/tests/session-auth-state.test.ts` — created (incl. `session_key_type_check_matches_domain_durable_types`)
- `db/src/schema-version.ts` — changed: EXPECTED_SCHEMA_VERSION 19→20
- `db/src/isolation/tenant-tables.ts` — changed: TENANT_TABLE_COVERAGE + CANONICAL_AUTHORITY_KEYS entries
- `db/src/isolation/send-path-tables.ts` — created: SEND_PATH_TABLES moved here + both session tables appended
- `db/schema/whatsapp-session-credentials.ts`, `db/schema/whatsapp-session-keys.ts` — created (Drizzle mirrors)
- `db/schema/index.ts` — changed; `db/schema/grants.snapshot.json` — refreshed + verified
packages/domain:
- `packages/domain/src/session/auth-key-types.ts` + `.test.ts` — created; `packages/domain/src/index.ts` — changed
app/backend:
- `app/backend/package.json` — changed: `"baileys": "7.0.0-rc14"` exact pin (+ root `pnpm-lock.yaml`)
- `app/backend/src/provider/baileys/auth-state/codec.ts` + `codec.test.ts` — created (the ONE BufferJSON importer)
- `app/backend/src/provider/baileys/auth-state/key-type-parity.test.ts` — created (compile-time exhaustiveness vs pinned baileys)
- `app/backend/src/provider/baileys/auth-state/redis-repo.ts` + `redis-tier.integration.test.ts` — created
- `app/backend/src/provider/baileys/auth-state/pg-repo.ts`, `pg-repo-keys.ts` + `pg-repo-save-creds.integration.test.ts` — created
- `app/backend/src/provider/baileys/auth-state/types.ts`, `store.ts`, `store-keys.ts`, `store-purge.ts` — created
- `app/backend/src/provider/baileys/auth-state/bounded-key-store.ts` + `bounded-key-store.test.ts` — created
- `app/backend/src/provider/baileys/auth-state/fence.integration.test.ts`, `save-creds.integration.test.ts`, `store-round-trip.integration.test.ts`, `purge.integration.test.ts`, `no-plaintext.integration.test.ts` — created
- `app/backend/src/provider/baileys/auth-state/__tests__/store-fixtures.ts`, `__tests__/plaintext-marker-scan.ts` — created
- `app/backend/src/platform/redis.ts` — changed: resolveSigRedisUrl/resolveCacheRedisUrl
- `app/backend/src/platform/redis-assertions.ts` — created: assertSignalKeyspacePolicy (standalone; P08 wires it at boot)
- `app/backend/src/platform/config.ts` — changed: REDIS_SIG_URL / REDIS_CACHE_URL
- `app/backend/src/platform/metrics/signal-metrics.ts` — created (4 counters, `cause` label only)
- `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — created (suite C, first row)
scripts/ + root:
- `scripts/check-serialisation-boundary.ts`, `scripts/guards/serialisation-boundary.test.ts`, `scripts/guards/shell-out-guards.ts` — created
- `scripts/guards/registry.ts`, `scripts/guards/cli-smoke.test.ts`, `scripts/ci-steps.ts`, root `package.json` — changed (guard #19 wired)
- `scripts/check-tenant-scope.ts` — changed: TENANT_TABLES += both session tables
infra/:
- `infra/compose/docker-compose.dev.yml` — changed: `redis-sig` service (noeviction, 127.0.0.1:56380)
- `.secrets/dev.env` — changed: REDIS_SIG_PORT=56380 (machine-local)
E2 debugger fix (lid-mapping bare-string):
- `packages/server-kit/src/crypto/json-codec.ts` — changed: structural envelope `{__wp_sealed_json_v:1, v}` replaces the typeof-string reject guard
- `packages/server-kit/src/crypto/edge-cases.test.ts`, `packages/server-kit/test/auth-state-round-trip.test.ts` — changed: string round-trip + still-safe double-stringify cases
- `app/backend/src/provider/baileys/auth-state/store-round-trip.integration.test.ts`, `no-plaintext.integration.test.ts`, `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — changed: lid-mapping skips flipped to real assertions
- `app/backend/src/provider/baileys/auth-state/__tests__/repro-lid-mapping.integration.test.ts` — created (permanent regression test)
- `.memory/lessons/2026-08-31-sealjson-bare-string-guard-broke-lid-mapping.md` — created (+ MEMORY.md index line)
C2 all-cases pass (test-engineer, 7 probes green, 3 findings → FIX-A):
- `app/backend/src/provider/baileys/auth-state/store.c2.integration.test.ts` — created (crash mid-purge-tx rollback, save replay last-writer-wins, purge replay, dual-store takeover, 50-save retry storm, slow-redis pin, stale-epoch pin)
FIX-A (implementer; all C1+C2 findings):
- `app/backend/src/provider/baileys/auth-state/store.ts`, `store-keys.ts`, `store-purge.ts`, `types.ts`, `pg-repo.ts`, `pg-repo-keys.ts`, `redis-repo.ts`, `bounded-key-store.ts` — changed (single mutation chain, 3-class classify + epoch_conflict, worker-bound predicates, gate mapping, idempotent purge, per-key miss counts)
- `app/backend/src/provider/baileys/auth-state/redis-repo-timeout.ts` — created (bounded command timeouts, TIMING.redisCommandTimeoutMs)
- `app/backend/src/provider/baileys/auth-state/scripts/fence-gate-write.lua` — created (atomic per-instance monotonic fence gate for Redis writes)
- `db/queries/session-creds-upsert.sql`, `session-creds-classify-miss.sql`, `session-keys-upsert.sql`, `session-keys-delete.sql`, `session-purge-durable-creds.sql`, `session-purge-durable-keys.sql`, `session-purge-epoch-bump.sql` — changed (epoch + owner_worker_id predicates)
- `db/queries/session-lease-is-valid.sql` — created (benign-replay vs stale-fence disambiguation)
- `scripts/check-serialisation-boundary.ts` + `scripts/guards/serialisation-boundary.test.ts` — changed (namespace/default import forms + fixtures)
- `app/backend/src/provider/baileys/auth-state/store.c2-more.integration.test.ts`, `store-edge-cases-more.test.ts`, `edge-cases-more.integration.test.ts` — created (max-lines splits; pins flipped to fixed behavior; TOCTOU regression test in fence.integration.test.ts)
FIX-B (db-engineer; re-review CRITICAL+WARNING+SUGGESTIONS):
- `db/migrations/0021_wp_app_instance_epoch_grants.sql` — created (column-level: SELECT (id, client_id, session_epoch) + UPDATE (session_epoch, updated_at) ON whatsapp_instances TO wp_app)
- `db/src/schema-version.ts` — changed (20→21); `db/schema/grants.snapshot.json` — regenerated + verified
- `db/queries/session-keys-upsert.sql`, `session-keys-delete.sql` — changed (epoch EXISTS symmetry)
- `app/backend/src/provider/baileys/auth-state/pg-repo-keys.ts`, `store-keys.ts`, `store.ts`, `types.ts` — changed (sessionEpoch threading; markPurged terminal state, documented on PurgeResult)
- `app/backend/src/provider/baileys/auth-state/wp-app-role.integration.test.ts` — created (red-first 42501 proof, green under wp_app + app.client_id GUC end to end incl. purge epoch bump)
- `store-edge-cases-more.test.ts`, `store.c2.integration.test.ts`, `pg-repo-save-creds.integration.test.ts`, `edge-cases-more.integration.test.ts` — changed (post-purge StoreFencedError; fresh-store purge replay; epoch param threading)
C5 formatting/split fixes (main session, mechanical):
- prettier --write applied repo-wide (18 phase files reflowed; attempt-1 format failure)
- `app/backend/src/provider/baileys/auth-state/store.c2-takeover.integration.test.ts` — created (takeover describe + mintNextFence moved out of store.c2, which prettier pushed past max-lines)
- `app/backend/src/provider/baileys/auth-state/pg-repo-key-type-validation.integration.test.ts` — created (validation-before-SQL case moved out of pg-repo-save-creds, same reason; no seeding needed)
- reviewer-note fixes: near-vacuous negative assertion replaced with a positive name check (store-edge-cases-more.test.ts); drifted comment reworded (store.c2.integration.test.ts)
C5 integration fixes (debugger; attempt-3 failures):
- `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — changed: precise `FENCE_GATE_KEY_GRAMMAR` row for the FIX-A gate-key shape `:(sig|cache):i:{uuid}:fence`; general grammar untouched, negative control intact
- `app/backend/src/engine/lease/stale-fence.integration.test.ts` — changed: this test's own scanUnowned maxRows 50→500 (the SQL's hard ceiling); production scan untouched
- dev-data cleanup only (no source): P03 EXPLAIN-seed rows (`queue-fixture-client-*`, 200k message_jobs) + interrupted-run `claim-probe-*` rows + one leaked P04b `wp:test:session:mfa:*` Redis marker deleted
- `.memory/lessons/2026-08-31-shared-dev-db-poisons-random-sample-scans.md` — created (+ MEMORY.md index line)
- FOLLOW-UP flagged (not P07 scope): P04b `session-mfa-claim.integration.test.ts` never cleans its two MFA Redis markers — for master-plan open items
- `db/tests/claim-plan.test.ts` — changed (debugger round 2): self-seeds all THREE month partitions + ensureAllPartitions, proven on a bare DB (its header claimed seed-independence but the third partition's index coverage was silently propped by the ambient P03 seed); P03 seed re-applied and left in place
- `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts` — changed (round 2): SYS_KEY_ALLOWLIST widened to the explicit alternation of real sysKey() first segments (sys|rl|mfa|session|epoch|totp) — recurring gap fixed precisely, negative controls intact
E3 edge pass (test-engineer, 26 cases, all green):
- `app/backend/src/provider/baileys/auth-state/store-edge-cases.test.ts` — created (7 cases: retry exhaustion, chain integrity, fenced-store rejection, empty-input no-ops)
- `app/backend/src/provider/baileys/auth-state/codec-edge-cases.test.ts` — created (4 cases: truncated/garbage blob fail-closed, AAD recordId/clientId fail-closed)
- `app/backend/src/provider/baileys/auth-state/bounded-key-store-edge-cases.test.ts` — created (4 cases: TTL boundary strict-<, touch-order LRU, no stale resurrect, clear() semantics)
- `app/backend/src/provider/baileys/auth-state/edge-cases.integration.test.ts` — created (12 cases: fence boundaries, classify races, 500-write batch, 64KiB blob, TTL re-arm both tiers, two-tenant probes)

## Deviations recorded (reality vs phase file)
1. Step order: steps 2/3 (U1) ran before step 1 (U2) — the enum-parity test imports `DURABLE_KEY_TYPES` from `@wp/domain`.
2. Pinned baileys 7.0.0-rc14 has TEN SignalDataTypeMap key types, not six. Tier decision (ADR this session): `identity-key` → sig tier (noeviction; Signal trust material); `lid-mapping`/`device-list`/`tctoken` → cache tier (re-queryable). Durable set unchanged (CHECK = 3 types). Purge is now a bounded DEL of 7 hash keys (3 sig + 4 cache), still no SCAN.
3. No `db/schema/tables/*.sql` convention exists — real DDL lives in the migration + Drizzle TS mirrors in `db/schema/*.ts` (repo convention since P02).
4. Grants: no session-worker PG role exists (four-role canon) — CRUD to `wp_app` only; wp_scheduler AND wp_admin_app get zero grants (staff cannot read session ciphertext); API/worker split carried by KEK mounting + depcruise layering (ADR this session).
5. Redis key shape via sanctioned `tenantKey()`: `wp:{env}:c:{client}:(sig|cache):i:{instance}:h:{key_type}` (helper shape wins over the phase literal; raw literals guard-banned).
6. Test placement: colocated `src/**/*.integration.test.ts` + `db/tests/**` (enforced convention; phase-file paths corrected). Guard test lives at `scripts/guards/serialisation-boundary.test.ts` + cli-smoke coverage.
7. Isolation suite C did not exist; created this session at `app/backend/src/platform/redis/isolation-suite-c.integration.test.ts`.
8. E2 stop-line (RESOLVED): U6 exposed a product bug — `lid-mapping` (bare-string value shape) threw `CRYPTO_ENCRYPT_FAILED:boundary`. Root cause one layer below the store: server-kit `sealJson`/`openJson` type-sniffed strings to block double-stringify; fixed with a structural envelope; skips flipped; regression test added; server-kit area 99/99 green; lesson filed.
9. `SignalKeyStore` in rc14 has no `transaction` member on the base type — not implemented (Baileys layers it itself).
10. C1 first pass: **CHANGES-REQUIRED** — 2 CRITICAL (purge resurrection via un-chained purge/setKeys + epoch-blind INSERT arm; released lease still authorises writes — in-memory fenced flag was doing storage's job), 3 WARNING (sig-tier Redis write TOCTOU; silent durable-key miss; guard blind to namespace/default import forms), 2 SUGGESTION (hmgetBuffer; per-key miss counts). C2 pinned 3 findings (double-purge double-bumps epoch + double-audits; no Redis command timeout unlike lease-redis; stale-epoch store stamps old epoch). FIX-A (one implementer batch): single per-instance chain for all mutations; epoch predicate + `epoch_conflict` class; `owner_worker_id = $worker_id` in all six write predicates; Lua fence gate on Redis writes (fence-in-key rejected — would orphan live Signal records on takeover, ADR 0018 §5); idempotent purge (zero-delete ⇒ no bump/audit); TIMING.redisCommandTimeoutMs bounds on all redis-repo commands; guard extended to namespace/default import forms; C2/E3 pins flipped to assert fixed behavior.
11. C1 re-review of FIX-A: all eight fixes verified real; ONE new CRITICAL the superuser fixtures masked (P06 pitfall repeated) — the epoch predicates/epoch bump reference `whatsapp_instances`, on which `wp_app` had ZERO grants: under the production role every creds write and purge would 42501. Plus 1 WARNING (post-purge store misreports `epoch_conflict` instead of a clean terminal state) + 2 SUGGESTIONS (keys-statement epoch symmetry; miss-loop clarity). FIX-B (db-engineer): migration 0021 column-level grants (`SELECT (id, client_id, session_epoch)`, `UPDATE (session_epoch, updated_at)` on whatsapp_instances TO wp_app), schema version 21, grant snapshot refreshed, red-first `wp-app-role.integration.test.ts` proof under `SET LOCAL ROLE wp_app`, post-purge terminal StoreFencedError state, epoch predicate symmetry on keys statements.

## Risks / gotchas specific to this phase
- **Zero rows from the upsert is ambiguous and the two causes demand opposite actions** (retry vs self-fence + release lease). Getting this backwards either drops creds saves forever or hands a live session to a dead owner. Step 4's `classifyWriteMiss()` exists only for this; it has its own test.
- **Baileys' key-type strings must match the `CHECK` constraint byte for byte** (`pre-key`, `app-state-sync-key`, `app-state-sync-version`, `session`, `sender-key`, `sender-key-memory`). A mismatch is not a compile error — it is a runtime insert failure during pairing, under load. The enum-parity test in step 1/9 is the guard; read the strings off the pinned package, not off this file.
- **The double-parse bug (evolution-api's)**: if any module other than `codec.ts` calls `JSON.parse`/`JSON.stringify` on auth material, Buffers come back as `{type:'Buffer',data:[…]}` and Signal breaks in ways that look like a WhatsApp outage. The CI guard is the only durable defence; do not add an "exception".
- **Never "fix" a `redis-sig` memory alert by switching to `allkeys-lru`.** Evicting a Signal session record makes already-encrypted inbound customer mail permanently unreadable (ADR 0018 §5). The correct responses are: size the keyspace, alert at 75%, and degrade the instance on a write failure.
- **`SCAN` on the sig keyspace will not survive 10k sessions.** That is why records live in a per-`(instance,key_type)` HASH — purge is a `DEL`. If you find yourself writing `SCAN`, stop. If per-record TTLs turn out to be required, that is a `/decide` (Redis 7.4 `HEXPIRE` or a per-instance index set), not a silent redesign.
- **Safety boundary:** `purge()` here is our own state deletion — it must never reach for `sock.logout()`/`unlink()`, and nothing in this module may become an "auto-recover by re-pairing" path. Purge happens on an explicit `logged_out` signal or an explicit human unlink, never as an automatic response to a restriction.
- **Metrics labels:** the new counters carry `cause` at most. `client_id`/`instance_id` as labels is a cardinality bomb at 10k sessions and violates the four-gauge label rule.
- **Test placement:** if `docs/CONVENTIONS.md` (P00) puts integration tests somewhere other than `app/backend/test/integration/**`, follow `CONVENTIONS.md` and record the corrected paths in the file list above.

## Session close
Run **`plan/SESSION-PROTOCOL.md` steps C1-C7**. Do not restate them here.

## Next-session prompt (paste this to start the next phase)
```
Start phase P08 — session-qr-linking (Baileys socket factory, QR/pairing and the instance FSM).
Read plan/v1/P08-session-qr-linking.md and follow it exactly: one phase, one session.
Deps P07 and P05 are done (see plan/README.md). Do not start P09.
Work through the ordered steps in order, TDD, using the agent roster in CLAUDE.md.
Stop at the first red test and dispatch debugger. At the end run plan/SESSION-PROTOCOL.md C1-C7.
```
