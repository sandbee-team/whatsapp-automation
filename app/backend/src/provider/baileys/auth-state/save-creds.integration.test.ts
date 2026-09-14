import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tenantKey } from '../../../platform/redis.js';
import {
  acquireRealLease,
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  buildStore,
  makeNoopPorts,
  seedTenantInstanceAndLease,
  TEST_ENV,
  type StoreTestHandles,
} from './__tests__/store-fixtures.js';

/**
 * save-creds.integration.test.ts (P07 Unit U5) - `concurrent_saveCreds_
 * from_one_owner_does_not_release_the_lease` (mandatory suite test 7):
 * acquire a REAL lease via P06's `LeaseManager` against real Redis, fire 20
 * concurrent `saveCreds` from the fence holder - all 20 land (the promise
 * chain serialises, `cred_version` advances by exactly 20), the Redis lease
 * key still exists, `whatsapp_instances.health_state` is unchanged, and
 * `ports.onFenceConflict`/`releaseLease` were NEVER called.
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

describe('save-creds', () => {
  it('concurrent_saveCreds_from_one_owner_does_not_release_the_lease', async () => {
    const { clientId, instanceId } = await seedTenantInstanceAndLease(handles.pool, 0n);
    probeClientIds.push(clientId);

    const lease = await acquireRealLease(handles, clientId, instanceId);

    const ports = makeNoopPorts();
    const store = buildStore(
      handles,
      { instanceId, clientId, fence: lease.fence, workerId: lease.workerId },
      { ports },
    );

    const attempts = Array.from({ length: 20 }, (_, i) => i);
    await Promise.all(
      attempts.map((i) =>
        store.saveCreds({ creds: { seq: i }, expectedVersion: BigInt(i), fence: lease.fence }),
      ),
    );

    const credsRow = await handles.pool.query<{ cred_version: string }>(
      'SELECT cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credsRow.rows[0]?.cred_version).toBe('20');

    const leaseKey = tenantKey(TEST_ENV, clientId, 'lease', 'i', instanceId);
    const leaseExists = await handles.redisLease.exists(leaseKey);
    expect(leaseExists).toBe(1);

    const instanceRow = await handles.pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.health_state).toBe('connected');

    expect(ports.onFenceConflict).not.toHaveBeenCalled();
    expect(ports.releaseLease).not.toHaveBeenCalled();

    await handles.redisLease.del(leaseKey);
  });
});
