import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  classifyWriteMiss,
  getKeys,
  loadCreds,
  purgeDurable,
  saveCreds,
  setKeys,
} from './pg-repo.js';
import type { SealedBlob } from '@wp/server-kit/crypto';

/**
 * save-creds.integration.test.ts (P07 Unit U4) - the fence-predicated
 * `whatsapp_session_credentials`/`whatsapp_session_keys` Postgres repo,
 * against a real, migrated dev Postgres (mirrors P06's
 * `lease-fence.concurrency.integration.test.ts` fixture pattern: seed a
 * `clients` row, a `whatsapp_instances` row, and an `instance_lease_state`
 * row with a known `current_fence`, then exercise the repo directly - no
 * crypto involved, plain Buffer fixture blobs, since `pg-repo.ts` deals only
 * in already-sealed `SealedBlob` column values (DECIDED FACT 4)).
 */

type TestPool = ReturnType<typeof createPool>;

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM whatsapp_session_keys WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_session_credentials WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedTenantInstanceAndLease(fence: bigint): Promise<{
  clientId: string;
  instanceId: string;
}> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Session Creds Probe Client',
    `session-creds-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, 'probe'],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, $3, 'worker-probe', now())`,
    [instanceId, clientId, fence.toString()],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

function makeBlob(tag: string): SealedBlob {
  return {
    ciphertext: Buffer.from(`ciphertext-${tag}`),
    iv: Buffer.from(`iv-${tag}------`).subarray(0, 12),
    auth_tag: Buffer.from(`authtag-${tag}-`).subarray(0, 16),
    dek_wrapped: Buffer.from(`dek-wrapped-${tag}`),
    dek_iv: Buffer.from(`dek-iv-${tag}--`).subarray(0, 12),
    dek_tag: Buffer.from(`dek-tag-${tag}--`).subarray(0, 16),
    kek_id: 'kek-test-1',
    enc_version: 1,
  };
}

describe('pg-repo saveCreds / loadCreds / classifyWriteMiss', () => {
  it('first_save_of_a_new_instance_does_not_throw', async () => {
    const fence = 1n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(fence);

    const result = await saveCreds(pool, {
      instanceId,
      clientId,
      blob: makeBlob('first'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence,
      workerId: 'worker-probe',
    });

    expect(result).not.toBeNull();
    expect(result?.credVersion).toBe(1n);
  });

  it('zero_rows_is_classified_as_version_or_fence_conflict', async () => {
    const fence = 5n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(fence);

    // Establish a real row at cred_version=1 first.
    const firstSave = await saveCreds(pool, {
      instanceId,
      clientId,
      blob: makeBlob('base'),
      sessionEpoch: 0,
      expectedVersion: 0n,
      fence,
      workerId: 'worker-probe',
    });
    expect(firstSave?.credVersion).toBe(1n);

    // Wrong expectedVersion at the LIVE fence -> zero rows -> version_conflict.
    const wrongVersion = await saveCreds(pool, {
      instanceId,
      clientId,
      blob: makeBlob('wrong-version'),
      sessionEpoch: 0,
      expectedVersion: 99n,
      fence,
      workerId: 'worker-probe',
    });
    expect(wrongVersion).toBeNull();

    const classifiedVersionConflict = await classifyWriteMiss(pool, {
      instanceId,
      clientId,
      expectedVersion: 99n,
      fence,
      workerId: 'worker-probe',
    });
    expect(classifiedVersionConflict).toBe('version_conflict');

    // Any expectedVersion, but a STALE fence (F-1) -> zero rows -> fence_conflict.
    const staleFence = fence - 1n;
    const staleFenceSave = await saveCreds(pool, {
      instanceId,
      clientId,
      blob: makeBlob('stale-fence'),
      sessionEpoch: 0,
      expectedVersion: 1n,
      fence: staleFence,
      workerId: 'worker-probe',
    });
    expect(staleFenceSave).toBeNull();

    const classifiedFenceConflict = await classifyWriteMiss(pool, {
      instanceId,
      clientId,
      expectedVersion: 1n,
      fence: staleFence,
      workerId: 'worker-probe',
    });
    expect(classifiedFenceConflict).toBe('fence_conflict');

    // Stale-fence setKeys changes nothing and reports the miss.
    const staleSetKeys = await setKeys(
      pool,
      { instanceId, clientId, fence: staleFence, workerId: 'worker-probe', sessionEpoch: 0 },
      [{ keyType: 'pre-key', keyId: 'k-stale', blob: makeBlob('stale-key') }],
    );
    expect(staleSetKeys).toEqual({ written: 0, missed: true });
    const keysAfterStaleWrite = await getKeys(pool, { instanceId, clientId }, 'pre-key', [
      'k-stale',
    ]);
    expect(keysAfterStaleWrite.size).toBe(0);

    // Stale-fence purgeDurable changes nothing.
    const stalePurge = await purgeDurable(pool, {
      instanceId,
      clientId,
      fence: staleFence,
      workerId: 'worker-probe',
    });
    expect(stalePurge).toBeNull();
    const credsStillThere = await loadCreds(pool, { instanceId, clientId });
    expect(credsStillThere).not.toBeNull();
  });

  it('round_trip_saveCreds_loadCreds_and_setKeys_getKeys', async () => {
    const fence = 7n;
    const { clientId, instanceId } = await seedTenantInstanceAndLease(fence);
    // sessionEpoch=3 below must match whatsapp_instances.session_epoch (FIX-A CRITICAL-1(b) predicate).
    await pool.query('UPDATE whatsapp_instances SET session_epoch = 3 WHERE id = $1', [instanceId]);

    const blob = makeBlob('roundtrip');
    const saved = await saveCreds(pool, {
      instanceId,
      clientId,
      blob,
      sessionEpoch: 3,
      expectedVersion: 0n,
      fence,
      workerId: 'worker-probe',
    });
    expect(saved?.credVersion).toBe(1n);

    const loaded = await loadCreds(pool, { instanceId, clientId });
    expect(loaded).not.toBeNull();
    expect(loaded?.credVersion).toBe(1n);
    expect(loaded?.sessionEpoch).toBe(3);
    expect(loaded?.blob.ciphertext).toEqual(blob.ciphertext);
    expect(loaded?.blob.iv).toEqual(blob.iv);
    expect(loaded?.blob.auth_tag).toEqual(blob.auth_tag);
    expect(loaded?.blob.dek_wrapped).toEqual(blob.dek_wrapped);
    expect(loaded?.blob.dek_iv).toEqual(blob.dek_iv);
    expect(loaded?.blob.dek_tag).toEqual(blob.dek_tag);
    expect(loaded?.blob.kek_id).toBe(blob.kek_id);
    expect(loaded?.blob.enc_version).toBe(blob.enc_version);

    // A second save with the correct expectedVersion bumps cred_version.
    const secondBlob = makeBlob('roundtrip-2');
    const secondSave = await saveCreds(pool, {
      instanceId,
      clientId,
      blob: secondBlob,
      sessionEpoch: 3,
      expectedVersion: 1n,
      fence,
      workerId: 'worker-probe',
    });
    expect(secondSave?.credVersion).toBe(2n);

    // setKeys upsert of two keys, then getKeys returns only requested ids.
    const key1 = makeBlob('key-1');
    const key2 = makeBlob('key-2');
    const setResult = await setKeys(
      pool,
      { instanceId, clientId, fence, workerId: 'worker-probe', sessionEpoch: 3 },
      [
        { keyType: 'pre-key', keyId: 'k1', blob: key1 },
        { keyType: 'pre-key', keyId: 'k2', blob: key2 },
      ],
    );
    expect(setResult).toEqual({ written: 2, missed: false });

    const fetched = await getKeys(pool, { instanceId, clientId }, 'pre-key', ['k1']);
    expect(fetched.size).toBe(1);
    expect(fetched.get('k1')?.ciphertext).toEqual(key1.ciphertext);

    // null blob = fence-predicated DELETE.
    const deleteResult = await setKeys(
      pool,
      { instanceId, clientId, fence, workerId: 'worker-probe', sessionEpoch: 3 },
      [{ keyType: 'pre-key', keyId: 'k1', blob: null }],
    );
    expect(deleteResult).toEqual({ written: 1, missed: false });

    const afterDelete = await getKeys(pool, { instanceId, clientId }, 'pre-key', ['k1', 'k2']);
    expect(afterDelete.size).toBe(1);
    expect(afterDelete.has('k1')).toBe(false);
    expect(afterDelete.has('k2')).toBe(true);

    // purgeDurable removes both remaining creds and keys rows.
    const purged = await purgeDurable(pool, {
      instanceId,
      clientId,
      fence,
      workerId: 'worker-probe',
    });
    expect(purged).toEqual({ credsDeleted: 1, keysDeleted: 1 });

    const afterPurgeCreds = await loadCreds(pool, { instanceId, clientId });
    expect(afterPurgeCreds).toBeNull();
    const afterPurgeKeys = await getKeys(pool, { instanceId, clientId }, 'pre-key', ['k2']);
    expect(afterPurgeKeys.size).toBe(0);
  });
});
