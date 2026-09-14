import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initAuthCreds } from 'baileys';
import { tenantKey } from './keys.js';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';

/**
 * isolation-suite-c.integration.test.ts (P07 Unit U6, step 9) - NEW this
 * session (recorded deviation: "isolation suite C" did not exist anywhere in
 * the repo before this file). Seeds a real `EncryptedAuthStore` (durable +
 * signal + rebuildable tiers all touched), then enumerates the FULL keyspace
 * of both the sig and cache Redis handles and asserts every key matches the
 * `tenantKey()` grammar:
 *   ^wp:[a-z]+:c:<uuid>:(sig|cache):i:<uuid>:h:<one of the ten known key types>$
 * or an explicit sys-key allowlist (`wp:{env}:sys:*`). Any unmatched key is a
 * failure listing the offending key.
 *
 * ENUMERATION MECHANISM (test-only exception): `KEYS` is used below to walk
 * the ENTIRE keyspace of each handle. Production code is banned from
 * SCAN/KEYS against these handles (see `redis-repo.ts`'s own header: "HMGET/
 * HSET/HDEL only - never HGETALL, never SCAN") - this is allowed here, and
 * ONLY here, because a security/isolation proof test's whole point is to see
 * every key that exists, not just the ones a bounded API call would return.
 *
 * ISOLATION MECHANISM (determinism): rather than FLUSHDB (which would race
 * any other suite sharing these two Redis servers under
 * `fileParallelism: false`), this suite seeds through UNIQUE randomly
 * generated `clientId`/`instanceId` UUIDs per test and asserts the full
 * keyspace grammar-matches for EVERY key present (not just "its own" keys) -
 * so the assertion is deterministic regardless of what any other test left
 * behind, as long as that other test also only ever writes grammar-
 * conformant keys (which is exactly the property this suite is proving). Each
 * test still purges its own instance's keys in `afterEach` via
 * `cleanupProbeClients`/`redisRepo.purgeInstance`-equivalent cleanup so the
 * suite does not itself leave a growing key trail across runs.
 */

const KEY_TYPE_ALTERNATION =
  '(?:pre-key|app-state-sync-key|app-state-sync-version|session|sender-key|identity-key|' +
  'sender-key-memory|lid-mapping|device-list|tctoken)';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const TENANT_KEY_GRAMMAR = new RegExp(
  `^wp:[a-z]+:c:${UUID_PATTERN}:(?:sig|cache):i:${UUID_PATTERN}:h:${KEY_TYPE_ALTERNATION}$`,
);

/**
 * FIX-A's atomic Lua fence gate (`fence-gate-write.lua`, driven by
 * `redis-repo.ts`'s `gateKeyFor`) writes ONE additional per-(tier, instance)
 * key that is NOT a hash-of-a-key-type: `tenantKey(env, clientId, tier, 'i',
 * instanceId, 'fence')` - shape `...:(sig|cache):i:<uuid>:fence`, no `:h:`
 * segment at all (the fence gate is metadata ABOUT the hash, never the hash
 * itself - see redis-repo.ts's WARNING-3). This is registered as its own
 * precise pattern, not folded into `KEY_TYPE_ALTERNATION` or a loosened
 * `TENANT_KEY_GRAMMAR` - "fence" is not a key type `classifyAuthKeyType`
 * knows, and a looser general regex here would stop this suite from
 * catching a REAL grammar violation elsewhere.
 */
const FENCE_GATE_KEY_GRAMMAR = new RegExp(
  `^wp:[a-z]+:c:${UUID_PATTERN}:(?:sig|cache):i:${UUID_PATTERN}:fence$`,
);

/**
 * FIX-P13a: the lease engine (`engine/lease/lease-manager.ts`,
 * `heartbeat.ts`, predating this suite - P06/P07r, Aug 31) writes its own
 * distinct key shape on the SAME redis-sig instance this suite enumerates:
 * `tenantKey(env, clientId, 'lease', 'i', instanceId)` ->
 * `wp:{env}:c:<uuid>:lease:i:<uuid>` - no `:h:<type>` suffix (it is not a
 * cache-tier hash) and no `:fence` suffix (that is the separate fence-gate
 * key above). This suite never modeled it because P07 only proved the
 * EncryptedAuthStore's sig/cache tiers; a lease key surfaced as a false
 * "offender" only when a killed lease-area test run left one behind with no
 * `afterEach` to delete it (P13a close-gate debug, 2026-09-02) - the key
 * shape itself is legitimate production output, not a violation.
 */
const LEASE_KEY_GRAMMAR = new RegExp(`^wp:[^:]+:c:${UUID_PATTERN}:lease:i:${UUID_PATTERN}$`);

/**
 * FIX-P17: `modules/notifications/dispatch/email.ts`'s hourly email-cap
 * counter (`tenantKey(env, clientId, 'notify', 'email', 'hourly')`, 1h TTL,
 * via `deps.capCounter.incrementAndGet`) writes a THIRD distinct non-hash
 * tenant-key shape on the same redis-sig instance this suite enumerates:
 * `wp:{env}:c:<uuid>:notify:email:hourly` - no `instanceId` segment at all
 * (the cap is per-CLIENT, gating email volume across every instance that
 * client owns, never per-instance) and no `:h:<type>` suffix. Same story as
 * `LEASE_KEY_GRAMMAR` above: this suite only ever modeled the
 * EncryptedAuthStore's sig/cache tiers, so a legitimate production key shape
 * from an unrelated module surfaced as a false "offender" once any
 * email-dispatch-driving integration test left one behind.
 */
const EMAIL_HOURLY_CAP_KEY_GRAMMAR = new RegExp(`^wp:[^:]+:c:${UUID_PATTERN}:notify:email:hourly$`);

/**
 * FIX-P18: the wallet charger worker (`modules/wallet/charger.worker.ts`,
 * ADR 0038 section 9) writes a per-tenant bounded list of repaired-send
 * charge work: `tenantKey(env, clientId, 'charge')` -> `wp:{env}:c:<uuid>:
 * charge` - a FOURTH distinct non-hash tenant-key shape on the same
 * redis-sig instance this suite enumerates, present whenever a repaired send
 * is in flight. Its sibling index key, `sysKey(env, 'sys', 'wallet',
 * 'charge-pending')`, is already covered by `SYS_KEY_ALLOWLIST` (`sys`
 * prefix) - no separate pattern needed for it.
 */
const WALLET_CHARGE_LIST_KEY_GRAMMAR = new RegExp(`^wp:[^:]+:c:${UUID_PATTERN}:charge$`);

/**
 * `sysKey(env, ...parts)` (platform/redis/keys.ts) is a generic non-tenant
 * key builder - `wp:{env}:{parts.join(':')}` - it provides NO structural
 * guarantee that `parts[0]` is literally `'sys'`; that was only ever this
 * suite's own assumption, proven wrong live (P07 debug follow-up,
 * 2026-08-31: `session-mfa-marker.ts`'s `sysKey(env, 'session', 'mfa', id)`
 * and `auth.routes.ts`'s `sysKey(env, 'rl', 'ip'|'acct', ...)` rate-limit
 * keys both got flagged as "offenders" the moment a leaked/TTL-not-yet-
 * expired marker from an UNRELATED identity-module test happened to still
 * be in the shared dev Redis when this suite's `KEYS '*'` ran). Registered
 * here as an explicit alternation of every real first-segment literal any
 * production `sysKey()` call site uses today - deliberately NOT a loose
 * "anything wp:{env}:* that isn't tenant-shaped" pattern, which would also
 * swallow a genuinely malformed tenant key (e.g. a bad UUID) that SHOULD
 * still fail this suite.
 *
 * The env segment itself is `[^:]+`, NOT `[a-z]+` (FIX-P10-B, second gap in
 * the same family as the P07 follow-up above): `sysKey`/`tenantKey`
 * (platform/redis/keys.ts) place zero constraint on `env`'s character set,
 * and several real integration suites legitimately build a per-run unique
 * env as `` `<slug>-${randomUUID()}` `` for shared-dev-Redis isolation
 * (`publish-worker-cap-wiring.integration.test.ts`'s `pwc-wiring-<uuid>`,
 * `fleet-connect-bucket-e3-edge.integration.test.ts`'s `it-e3-<uuid>`) -
 * lowercase letters, digits, and hyphens, never matched by `[a-z]+`. Still
 * anchored on the literal `wp:` prefix and the exact sys-prefix alternation,
 * so a key missing either is still flagged.
 */
const SYS_KEY_ALLOWLIST = /^wp:[^:]+:(?:sys|rl|mfa|session|epoch|totp):/;

function assertAllKeysMatchGrammar(keys: string[]): void {
  const offenders = keys.filter(
    (key) =>
      !TENANT_KEY_GRAMMAR.test(key) &&
      !FENCE_GATE_KEY_GRAMMAR.test(key) &&
      !LEASE_KEY_GRAMMAR.test(key) &&
      !EMAIL_HOURLY_CAP_KEY_GRAMMAR.test(key) &&
      !WALLET_CHARGE_LIST_KEY_GRAMMAR.test(key) &&
      !SYS_KEY_ALLOWLIST.test(key),
  );
  if (offenders.length > 0) {
    throw new Error(
      `isolation-suite-c: ${String(offenders.length)} key(s) do not match the tenantKey() grammar ` +
        `or the sys-key allowlist: ${offenders.join(', ')}`,
    );
  }
}

let handles: StoreTestHandles;
let probeClientIds: string[] = [];

beforeAll(() => {
  handles = createStoreTestHandles();
});

afterAll(async () => {
  await disposeStoreTestHandles(handles);
});

afterEach(async () => {
  await cleanupProbeClients(handles.pool, probeClientIds);
  probeClientIds = [];
});

describe('isolation suite C - Redis key enumeration', () => {
  it('every_sig_and_cache_key_matches_the_tenantkey_grammar_or_the_sys_allowlist', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });

    // Touch all three tiers so both Redis handles (sig + cache) get at least
    // one real key from this store, exercised through the REAL store (never
    // constructed by hand).
    const creds = initAuthCreds();
    await store.saveCreds({ creds, expectedVersion: 0n, fence });
    await store.setKeys(
      { 'pre-key': { 'k-1': { public: new Uint8Array([1]), private: new Uint8Array([2]) } } },
      fence,
    );
    await store.setKeys({ session: { 's-1': new Uint8Array([9, 8, 7]) } }, fence);
    await store.setKeys({ 'sender-key': { 'sk-1': new Uint8Array([1, 1]) } }, fence);
    await store.setKeys({ 'identity-key': { 'ik-1': new Uint8Array([2, 2]) } }, fence);
    await store.setKeys({ 'sender-key-memory': { 'c-1': { peer: true } } }, fence);
    // 'lid-mapping''s Baileys type (`SignalDataTypeMap['lid-mapping']`) is a
    // bare `string` - exercised here with a real lid-mapping value so this
    // suite proves its Redis key matches the tenant-key grammar same as
    // every other cache-tier type (`sealJson`/`openJson`'s envelope now
    // makes a bare string a legitimate value - see
    // packages/server-kit/src/crypto/json-codec.ts).
    await store.setKeys({ 'lid-mapping': { 'lm-1': '1234567890@lid' } }, fence);
    await store.setKeys({ 'device-list': { 'dl-1': ['device-a', 'device-b'] } }, fence);
    await store.setKeys(
      { tctoken: { 'tc-1': { token: Buffer.from([4, 4]), timestamp: '1700000000000' } } },
      fence,
    );

    const sigKeys = await handles.redisSig.keys('*');
    const cacheKeys = await handles.redisCache.keys('*');

    // Sanity: this probe instance's own keys must actually be present in the
    // enumeration (a scanner that finds nothing proves nothing).
    const ownSigKeys = sigKeys.filter((key) => key.includes(instanceId));
    const ownCacheKeys = cacheKeys.filter((key) => key.includes(instanceId));
    expect(ownSigKeys.length).toBeGreaterThan(0);
    expect(ownCacheKeys.length).toBeGreaterThan(0);

    // 'lid-mapping' specifically: its own hash key must be present and
    // conform to the same tenant-key grammar as every other cache-tier type.
    const lidMappingKey = tenantKey(
      TEST_ENV,
      clientId,
      'cache',
      'i',
      instanceId,
      'h',
      'lid-mapping',
    );
    expect(cacheKeys).toContain(lidMappingKey);
    expect(lidMappingKey).toMatch(TENANT_KEY_GRAMMAR);

    assertAllKeysMatchGrammar(sigKeys);
    assertAllKeysMatchGrammar(cacheKeys);

    await store.purge(fence);
  });

  it('a_key_outside_the_tenantkey_grammar_and_outside_the_sys_allowlist_is_flagged', async () => {
    // Negative control: the enumeration+grammar-check machinery itself must
    // be proven load-bearing, not a scanner that can never fail. Plant a
    // deliberately non-conformant key directly (bypassing the store/repo
    // entirely), assert `assertAllKeysMatchGrammar` throws naming it, then
    // delete it so the suite stays deterministic for any later test.
    const rogueKey = `rogue:not-a-wp-key:${randomUUID()}`;
    await handles.redisSig.set(rogueKey, 'plaintext-marker-should-never-survive-here');

    try {
      const keys = await handles.redisSig.keys('*');
      expect(keys).toContain(rogueKey);
      expect(() => assertAllKeysMatchGrammar(keys)).toThrow(rogueKey);
    } finally {
      await handles.redisSig.del(rogueKey);
    }
  });

  it('a_sys_prefixed_key_is_allowlisted_even_though_it_has_no_client_uuid', async () => {
    // Sys keys are legitimately exempt (rate-limit buckets, epoch caches,
    // etc. per `platform/redis/keys.ts`'s `sysKey()`) - plant one directly and
    // assert the grammar check does NOT flag it, proving the allowlist branch
    // (not just the tenant-grammar branch) is exercised.
    const sysKey = `wp:${TEST_ENV}:sys:probe:${randomUUID()}`;
    await handles.redisSig.set(sysKey, 'not-a-marker');

    try {
      const keys = await handles.redisSig.keys('*');
      expect(keys).toContain(sysKey);
      expect(() => assertAllKeysMatchGrammar(keys)).not.toThrow();
    } finally {
      await handles.redisSig.del(sysKey);
    }
  });
});
