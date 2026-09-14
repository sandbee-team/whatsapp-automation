import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initAuthCreds } from 'baileys';
import { tenantKey } from '../../../platform/redis.js';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';
import {
  buildMarkers,
  findMarker,
  IDENTIFIER_COLUMNS,
  type Marker,
} from './__tests__/plaintext-marker-scan.js';

/**
 * no-plaintext.integration.test.ts (P07 Unit U6, step 9) - the no-plaintext
 * proof. Seeds a REAL `initAuthCreds()` plus a durable ('pre-key'), a
 * sig-tier ('session') and a cache-tier ('device-list') record through the
 * REAL `EncryptedAuthStore` (built over the fixture key ring the vitest
 * config wires - see `codec.ts`/`store-fixtures.ts`), then hunts every
 * datastore for the known plaintext markers via `__tests__/plaintext-marker-
 * scan.ts` (split out purely to stay under the repo's `max-lines` guard).
 * Zero hits anywhere is the assertion; on failure the marker-search helper
 * names the datastore and key/column.
 *
 * HAYSTACK CONSTRUCTION: every column of both session tables for the seeded
 * instance (bytea columns cast/rendered as base64, hex AND latin1, since a
 * marker could theoretically leak in any encoding a bug might choose), plus
 * every field value of every key in the sig and cache keyspaces via
 * `HGETALL` (allowed in this test only - see the same test-only exception
 * documented in `isolation-suite-c.integration.test.ts`).
 */

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

describe('no plaintext credential in any datastore', () => {
  it('no_plaintext_credential_in_any_datastore', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });

    const creds = initAuthCreds();
    await store.saveCreds({ creds, expectedVersion: 0n, fence });

    const preKeyPublic = new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88]);
    const preKeyPrivate = new Uint8Array([99, 88, 77, 66, 55, 44, 33, 22]);
    await store.setKeys(
      { 'pre-key': { 'k-1': { public: preKeyPublic, private: preKeyPrivate } } },
      fence,
    );

    const sessionValue = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await store.setKeys({ session: { 's-1': sessionValue } }, fence);

    const deviceListValue = ['device-a-probe', 'device-b-probe'];
    await store.setKeys({ 'device-list': { 'dl-1': deviceListValue } }, fence);

    // 'lid-mapping''s Baileys type (`SignalDataTypeMap['lid-mapping']`) is a
    // bare `string` - written through the REAL store like every other key
    // type, and its plaintext value hunted for below as a string marker
    // (same as `creds.advSecretKey`), never just assumed sealed.
    const lidMappingValue = '19995551234@lid';
    await store.setKeys({ 'lid-mapping': { 'lm-1': lidMappingValue } }, fence);

    const markers = buildMarkers(creds, preKeyPublic, preKeyPrivate, sessionValue);
    const stringMarkers = [
      { name: 'creds.advSecretKey', value: creds.advSecretKey },
      {
        name: 'creds.registrationId',
        value: String(creds.registrationId),
        wordBoundary: true,
      },
      { name: 'lid-mapping value', value: lidMappingValue },
    ];

    // --- Haystack 1: every column of whatsapp_session_credentials ---
    const credsRows = await handles.pool.query<Record<string, unknown>>(
      'SELECT * FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credsRows.rows.length).toBe(1);
    for (const [column, value] of Object.entries(credsRows.rows[0] as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      const haystack = Buffer.isBuffer(value) ? value : String(value);
      const hit = findMarker(
        `whatsapp_session_credentials.${column}`,
        haystack,
        markers,
        stringMarkers,
        { checkWordBoundaryMarkers: !IDENTIFIER_COLUMNS.has(column) },
      );
      expect(hit, `plaintext marker found: ${String(hit)}`).toBeNull();
    }

    // --- Haystack 2: every column of every whatsapp_session_keys row ---
    const keyRows = await handles.pool.query<Record<string, unknown>>(
      'SELECT * FROM whatsapp_session_keys WHERE instance_id = $1',
      [instanceId],
    );
    expect(keyRows.rows.length).toBeGreaterThan(0);
    for (const row of keyRows.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const haystack = Buffer.isBuffer(value) ? value : String(value);
        const hit = findMarker(
          `whatsapp_session_keys.${column} (key_type=${String(row.key_type)}, key_id=${String(row.key_id)})`,
          haystack,
          markers,
          stringMarkers,
          { checkWordBoundaryMarkers: !IDENTIFIER_COLUMNS.has(column) },
        );
        expect(hit, `plaintext marker found: ${String(hit)}`).toBeNull();
      }
    }

    // --- Haystack 3: every field of every key in the sig keyspace (HGETALL - test-only exception) ---
    const sigHashKeys = [
      tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'session'),
      tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'sender-key'),
      tenantKey(TEST_ENV, clientId, 'sig', 'i', instanceId, 'h', 'identity-key'),
    ];
    for (const hashKey of sigHashKeys) {
      const fields = await handles.redisSig.hgetallBuffer(hashKey);
      for (const [field, value] of Object.entries(fields)) {
        // Every Redis hash field value is a whole `encodeSealedBlob` frame
        // (JSON of base64 ciphertext fields) - same "high-entropy, decimal-
        // substring-collides-by-chance" reasoning as `IDENTIFIER_COLUMNS`
        // above applies to the ENTIRE value here, so the word-boundary
        // decimal check is skipped for all Redis haystacks; the Buffer-marker
        // checks (the real secret-leak proof) still run unconditionally.
        const hit = findMarker(`redisSig ${hashKey}[${field}]`, value, markers, stringMarkers, {
          checkWordBoundaryMarkers: false,
        });
        expect(hit, `plaintext marker found: ${String(hit)}`).toBeNull();
      }
    }

    // --- Haystack 4: every field of every key in the cache keyspace ---
    const cacheHashKeys = [
      tenantKey(TEST_ENV, clientId, 'cache', 'i', instanceId, 'h', 'sender-key-memory'),
      tenantKey(TEST_ENV, clientId, 'cache', 'i', instanceId, 'h', 'lid-mapping'),
      tenantKey(TEST_ENV, clientId, 'cache', 'i', instanceId, 'h', 'device-list'),
      tenantKey(TEST_ENV, clientId, 'cache', 'i', instanceId, 'h', 'tctoken'),
    ];
    let cacheFieldsSeen = 0;
    for (const hashKey of cacheHashKeys) {
      const fields = await handles.redisCache.hgetallBuffer(hashKey);
      cacheFieldsSeen += Object.keys(fields).length;
      for (const [field, value] of Object.entries(fields)) {
        const hit = findMarker(`redisCache ${hashKey}[${field}]`, value, markers, stringMarkers, {
          checkWordBoundaryMarkers: false,
        });
        expect(hit, `plaintext marker found: ${String(hit)}`).toBeNull();
      }
    }
    expect(cacheFieldsSeen).toBeGreaterThan(0);

    await store.purge(fence);
  });

  it('the_marker_scanner_is_load_bearing_it_finds_a_deliberately_planted_plaintext_value', async () => {
    // Negative control (mandatory per the task): sealing DISABLED is not
    // reachable through the store, so instead prove `findMarker` itself can
    // match by planting a deliberately plaintext value in a scratch Redis key
    // and asserting the scanner finds it - a scanner that can never match
    // anything is not evidence.
    const scratchKey = `scratch:no-plaintext-negative-control:${randomUUID()}`;
    const plaintextNoiseKeyPrivate = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const markers: Marker[] = [
      { name: 'planted noiseKey.private', buffer: plaintextNoiseKeyPrivate },
    ];

    try {
      // Plant the RAW bytes directly as a string field value (base64-free, so
      // the latin1 rendering must be the one that catches it - proving all
      // three encodings are load-bearing, not just base64/hex).
      await handles.redisSig.hset(
        scratchKey,
        'field-1',
        plaintextNoiseKeyPrivate.toString('latin1'),
      );
      const fields = await handles.redisSig.hgetallBuffer(scratchKey);
      const value = fields['field-1'];
      expect(value).toBeDefined();

      const hit = findMarker('scratch negative control', value as Buffer, markers, []);
      expect(hit).not.toBeNull();
      expect(hit).toContain('planted noiseKey.private');
    } finally {
      await handles.redisSig.del(scratchKey);
    }

    // Also prove the string-marker path (advSecretKey/registrationId-shaped)
    // is load-bearing on its own, independently of the buffer-marker path.
    const plantedSecret = 'AbCdEf1234==';
    const hitString = findMarker(
      'scratch string haystack',
      plantedSecret,
      [],
      [{ name: 'planted advSecretKey', value: plantedSecret }],
    );
    expect(hitString).toBe('planted advSecretKey (in scratch string haystack)');

    // And the word-boundary registrationId path.
    const hitRegistrationId = findMarker(
      'scratch registration id haystack',
      'prefix-424242-suffix',
      [],
      [{ name: 'planted registrationId', value: '424242', wordBoundary: true }],
    );
    expect(hitRegistrationId).toBe('planted registrationId (in scratch registration id haystack)');

    // Negative-negative: a registrationId substring INSIDE a larger number
    // must NOT false-positive (word-boundary guard proven both ways).
    const noHit = findMarker(
      'scratch no-false-positive haystack',
      '17000000',
      [],
      [{ name: 'planted registrationId', value: '17', wordBoundary: true }],
    );
    expect(noHit).toBeNull();
  });
});
