import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { createTenantDb } from '@wp/db';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRealLease,
  buildStore,
  cleanupProbeClients,
  createStoreTestHandles,
  disposeStoreTestHandles,
  type StoreTestHandles,
} from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { createDrain } from './drain.js';

/**
 * drain-flow.integration.test.ts (P09 U4 step 7, FIX-P09-B split) - real
 * PG+Redis proof of `createDrain`'s full-run behavior, split out of
 * `drain.integration.test.ts` at FIX-P09-B for the max-lines cap (topic
 * split only - same case, unchanged). See
 * `drain-reconcile.integration.test.ts` for the `markNeedsReconcile` probes.
 *
 *   `drain_completes_within_45s_and_flushes_creds` - a full drain run
 *   against real ports: `exit(0)` captured, a real creds row updated by
 *   `flushCreds` (via the P07 `EncryptedAuthStore.saveCreds` path, same
 *   harness as that store's own integration tests), and the real lease
 *   released (a second acquirer succeeds promptly, same grace-skip proof
 *   as `shed.integration.test.ts`).
 */

let handles: StoreTestHandles;
let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupProbeClients(handles.pool, probeClientIds);
  if (probeClientIds.length > 0) {
    await handles.pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  probeClientIds = [];
});

afterAll(async () => {
  if (handles) {
    await disposeStoreTestHandles(handles);
  }
});

describe('createDrain - real PG+Redis', () => {
  it('drain_completes_within_45s_and_flushes_creds', async () => {
    handles = createStoreTestHandles();

    const clientId = randomUUID();
    const instanceId = randomUUID();

    await handles.pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, 'Drain Probe Client', `drain-probe-${clientId}`, 'active'],
    );
    await handles.pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, $3, 'connected', 0)`,
      [instanceId, clientId, 'probe'],
    );
    probeClientIds.push(clientId);

    const lease = await acquireRealLease(handles, clientId, instanceId, 'worker-drain-a');
    const store = buildStore(handles, {
      instanceId,
      clientId,
      fence: lease.fence,
      workerId: 'worker-drain-a',
    });

    // The real lease release: exercised directly (mirrors how wiring binds
    // `releaseLease()` to `LeaseManager.release`) so the "second acquirer
    // succeeds" proof below is real, not simulated.
    const { LeaseManager } = await import('../lease/lease-manager.js');
    const { createLeaseRedis } = await import('../lease/lease-redis.js');
    const leaseRedis = createLeaseRedis(handles.redisLease, { timeoutMs: 2000 });
    const managerA = new LeaseManager({
      leaseRedis,
      tenantDb: createTenantDb(handles.pool),
      sessionOwner: { onFenceLost: vi.fn(), close: vi.fn() },
      timing: {
        leaseTtlMs: 5000,
        heartbeatMs: 200,
        takeoverGraceMs: 150,
        watchdogMs: 2000,
        sendTimeoutMs: 1000,
        claimExpiryMs: 2000,
        reaperGraceMs: 500,
        reconcileWindowMs: 5000,
        redisCommandTimeoutMs: 2000,
      } as unknown as typeof import('@wp/domain').TIMING,
      sleep: async () => undefined,
      workerId: 'worker-drain-a',
      env: 'test',
    });

    const exit = vi.fn();
    const drain = createDrain({
      beginDrain: vi.fn(),
      stopClaiming: vi.fn(async () => undefined),
      inFlight: {
        list: () => [],
        awaitQuiescence: async () => undefined,
      },
      markNeedsReconcile: vi.fn(async () => undefined),
      sessions: [
        {
          instanceId,
          flushCreds: async () => {
            await store.saveCreds({
              creds: { drained: true },
              expectedVersion: 0n,
              fence: lease.fence,
            });
          },
          endSocket: vi.fn(),
          releaseLease: async () => {
            await managerA.release(lease);
          },
        },
      ],
      closePools: vi.fn(async () => undefined),
      exit,
    });

    await drain.run();

    expect(exit).toHaveBeenCalledWith(0);

    // Real creds row updated by flushCreds.
    const credsRow = await handles.pool.query<{ cred_version: string }>(
      'SELECT cred_version FROM whatsapp_session_credentials WHERE instance_id = $1',
      [instanceId],
    );
    expect(credsRow.rows).toHaveLength(1);
    expect(Number(credsRow.rows[0]?.cred_version)).toBeGreaterThan(0);

    // Lease released - a second acquirer succeeds promptly (grace skipped).
    const sleepB = vi.fn();
    const managerB = new LeaseManager({
      leaseRedis,
      tenantDb: createTenantDb(handles.pool),
      sessionOwner: { onFenceLost: vi.fn(), close: vi.fn() },
      timing: {
        leaseTtlMs: 5000,
        heartbeatMs: 200,
        takeoverGraceMs: 150,
        watchdogMs: 2000,
        sendTimeoutMs: 1000,
        claimExpiryMs: 2000,
        reaperGraceMs: 500,
        reconcileWindowMs: 5000,
        redisCommandTimeoutMs: 2000,
      } as unknown as typeof import('@wp/domain').TIMING,
      sleep: async (ms: number) => {
        sleepB(ms);
      },
      workerId: 'worker-drain-b',
      env: 'test',
    });
    const leaseB = await managerB.acquire({ instanceId, clientId });
    expect(leaseB).not.toBeNull();
    expect(sleepB).not.toHaveBeenCalled();
  }, 30_000);
});
