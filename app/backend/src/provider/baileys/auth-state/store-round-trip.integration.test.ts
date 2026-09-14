import { initAuthCreds } from 'baileys';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  seedTenantInstanceAndLease,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';

/**
 * store-round-trip.integration.test.ts (P07 Unit U5) - a REAL
 * `initAuthCreds()` object saved via `saveCreds` and loaded back, plus a
 * fake 'session' record and an 'app-state-sync-key' through
 * `setKeys`/`getKeys`: deep equality with Buffer/Uint8Array identity intact
 * end to end through PG and Redis (the double-parse bug class at store
 * level), and the app-state-sync-key value comes back proto-rehydrated
 * (DECIDED FACT 3).
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

describe('store round trip', () => {
  it('store_round_trip_preserves_buffers_through_pg_and_redis', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);

    const store = buildStore(handles, { instanceId, clientId, fence });

    // --- creds: a real initAuthCreds() object through saveCreds/loadCreds ---
    const creds = initAuthCreds();
    await store.saveCreds({ creds, expectedVersion: 0n, fence });

    const loaded = (await store.loadCreds()) as typeof creds;
    expect(loaded).not.toBeNull();
    expect(Buffer.isBuffer(loaded.noiseKey.private)).toBe(true);
    expect((loaded.noiseKey.private as Buffer).equals(creds.noiseKey.private as Buffer)).toBe(true);
    expect(Buffer.isBuffer(loaded.noiseKey.public)).toBe(true);
    expect((loaded.noiseKey.public as Buffer).equals(creds.noiseKey.public as Buffer)).toBe(true);
    expect(Buffer.isBuffer(loaded.signedIdentityKey.private)).toBe(true);
    expect(loaded.registrationId).toBe(creds.registrationId);
    expect(loaded.advSecretKey).toBe(creds.advSecretKey);

    // --- a fake 'session' record through setKeys/getKeys (Redis signal tier) ---
    const sessionValue = new Uint8Array([9, 8, 7, 6, 5]);
    await store.setKeys({ session: { 'peer-1': sessionValue } }, fence);
    const sessionResult = await store.getKeys('session', ['peer-1']);
    expect(sessionResult['peer-1']).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.from(sessionResult['peer-1'] as Uint8Array).equals(Buffer.from(sessionValue)),
    ).toBe(true);

    // --- an 'app-state-sync-key' through setKeys/getKeys (Postgres durable tier) ---
    // proto-rehydrated on read: getKeys must return an
    // `AppStateSyncKeyData` message instance, not a plain object.
    const appStateSyncKeyValue = {
      keyData: new Uint8Array([1, 2, 3]),
      fingerprint: { rawId: 7, currentIndex: 1, deviceIndexes: [0] },
      timestamp: 1700000000000,
    };
    await store.setKeys({ 'app-state-sync-key': { 'k-1': appStateSyncKeyValue } }, fence);
    const appStateSyncResult = await store.getKeys('app-state-sync-key', ['k-1']);
    const rehydrated = appStateSyncResult['k-1'] as {
      keyData?: Uint8Array | null;
      fingerprint?: { rawId?: number | null } | null;
      toJSON?: () => unknown;
    };
    expect(typeof rehydrated.toJSON).toBe('function');
    expect(rehydrated.keyData).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(rehydrated.keyData as Uint8Array).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(rehydrated.fingerprint?.rawId).toBe(7);

    // --- a 'lid-mapping' bare-string value through setKeys/getKeys (Redis rebuildable/cache tier) ---
    // `SignalDataTypeMap['lid-mapping']` is a bare `string` (unlike every
    // other Signal/rebuildable type) - the value must come back as the
    // identical string, not rejected and not double-parsed.
    const lidMappingValue = '1234567890@lid';
    await store.setKeys({ 'lid-mapping': { 'lid-1': lidMappingValue } }, fence);
    const lidMappingResult = await store.getKeys('lid-mapping', ['lid-1']);
    expect(lidMappingResult['lid-1']).toBe(lidMappingValue);
  });
});
