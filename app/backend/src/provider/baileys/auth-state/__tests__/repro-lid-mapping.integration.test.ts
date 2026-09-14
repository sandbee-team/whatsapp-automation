import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  seedTenantInstanceAndLease,
  type StoreTestHandles,
} from './store-fixtures.js';

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

describe('REPRO lid-mapping', () => {
  it('round trips a real bare-string lid-mapping value through setKeys/getKeys', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, fence);
    probeClientIds.push(clientId);
    const store = buildStore(handles, { instanceId, clientId, fence });

    const lidValue = '1234567890@lid';
    await store.setKeys({ 'lid-mapping': { 'lid-1': lidValue } }, fence);
    const result = await store.getKeys('lid-mapping', ['lid-1']);
    expect(result['lid-1']).toBe(lidValue);
  });
});
