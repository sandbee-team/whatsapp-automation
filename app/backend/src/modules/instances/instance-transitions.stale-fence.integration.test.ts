import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { StateWriteLostFenceError, markLinkedConnected } from './repo.js';
import {
  PROBE_WORKER_ID,
  cleanupProbeClients,
  ctxFor,
  seedLease,
  seedTenant,
  type TestPool,
} from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.stale-fence.integration.test.ts (P08 Unit U4) - proves
 * every ENGINE write in `repo.ts` rejects a superseded (stale-fence or
 * wrong-worker) caller with `StateWriteLostFenceError`, at the storage
 * layer, and leaves the live row byte-identical - core invariant 2 (fail-safe:
 * an unclear/superseded ownership state must never silently "win" a write).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('stale fence cannot write a state transition', () => {
  it('stale_fence_cannot_write_a_state_transition', async () => {
    const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(clientId);
    const liveFence = 5n;
    await seedLease(pool, { clientId, instanceId, fence: liveFence, workerId: PROBE_WORKER_ID });

    const ctx = ctxFor(pool, clientId);

    // Caller at F-1 (stale fence, correct worker).
    await expect(
      markLinkedConnected(ctx, {
        instanceId,
        fence: liveFence - 1n,
        workerId: PROBE_WORKER_ID,
        ownerJid: 'stale-owner@s.whatsapp.net',
        phoneE164: '+15551234567',
      }),
    ).rejects.toThrow(StateWriteLostFenceError);

    // Caller at F with the WRONG worker id.
    await expect(
      markLinkedConnected(ctx, {
        instanceId,
        fence: liveFence,
        workerId: 'a-completely-different-worker',
        ownerJid: 'wrong-worker@s.whatsapp.net',
        phoneE164: '+15551234567',
      }),
    ).rejects.toThrow(StateWriteLostFenceError);

    // The live row is byte-identical after both rejected writes.
    const row = await pool.query<{
      link_state: string;
      health_state: string;
      owner_jid: string | null;
      phone_e164: string | null;
    }>(
      'SELECT link_state, health_state, owner_jid, phone_e164 FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]).toEqual({
      link_state: 'linked',
      health_state: 'connected',
      owner_jid: null,
      phone_e164: null,
    });
  });
});
