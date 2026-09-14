import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Redis } from 'ioredis';
import { createPool, createTenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import {
  createRedis,
  resolveCacheRedisUrl,
  resolveSigRedisUrl,
} from '../../../../platform/redis.js';
import { resolveDatabaseUrl } from '../../../../platform/db/db-url.js';
import { LeaseManager, type SessionLease } from '../../../../engine/lease/lease-manager.js';
import { createLeaseRedis } from '../../../../engine/lease/lease-redis.js';
import type { SessionOwner } from '../../../../engine/lease/session-owner.port.js';
import { createAuthCodec } from '../codec.js';
import { createSignalRedisRepo } from '../redis-repo.js';
import { createEncryptedAuthStore } from '../store.js';
import type { AuthStorePorts, EncryptedAuthStore, SessionStoreDb } from '../types.js';
import type { SignalMetricsHandles } from '../../../../platform/metrics/signal-metrics.js';

/**
 * __tests__/store-fixtures.ts (P07 Unit U5) - shared real-Postgres/real-
 * Redis/real-lease/real-crypto scaffolding for `store.ts`'s four integration
 * test files (fence, save-creds, store-round-trip, purge). Mirrors P06's own
 * `lease-fence.concurrency.integration.test.ts` seed pattern (seed a
 * `clients` row, a `whatsapp_instances` row, and an `instance_lease_state`
 * row at a known `current_fence`).
 */

export const TEST_ENV = 'test';

export const FAST_TIMING = {
  leaseTtlMs: 5000,
  heartbeatMs: 1000,
  takeoverGraceMs: 10,
  watchdogMs: 1000,
  sendTimeoutMs: 5000,
  claimExpiryMs: 5000,
  reaperGraceMs: 2000,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 2000,
} as const;

export function writeTempSessionKeyRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-auth-store-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x09).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'ts1',
        'user-secrets': 'us1',
        'optout-pepper': 'op1',
        'api-key-pepper': 'ak1',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        ts1: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        us1: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        op1: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        ak1: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

export function makeNoopMetrics(): SignalMetricsHandles {
  return {
    hitTotal: undefined as unknown as SignalMetricsHandles['hitTotal'],
    missTotal: undefined as unknown as SignalMetricsHandles['missTotal'],
    evictedTotal: undefined as unknown as SignalMetricsHandles['evictedTotal'],
    decryptFailureTotal: undefined as unknown as SignalMetricsHandles['decryptFailureTotal'],
    redisSigFieldEvictedTotal:
      undefined as unknown as SignalMetricsHandles['redisSigFieldEvictedTotal'],
    redisSigFieldCapReachedTotal:
      undefined as unknown as SignalMetricsHandles['redisSigFieldCapReachedTotal'],
    incrementHit: vi.fn(),
    incrementMiss: vi.fn(),
    incrementEvicted: vi.fn(),
    incrementDecryptFailure: vi.fn(),
    incrementRedisSigFieldEvicted: vi.fn(),
    incrementRedisSigFieldCapReached: vi.fn(),
  };
}

export function makeNoopPorts(overrides: Partial<AuthStorePorts> = {}): AuthStorePorts {
  return {
    onFenceConflict: vi.fn().mockResolvedValue(undefined),
    onSignalWriteFailure: vi.fn().mockResolvedValue(undefined),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export interface StoreTestHandles {
  pool: ReturnType<typeof createPool>;
  redisSig: Redis;
  redisCache: Redis;
  redisLease: Redis;
  keyRingPath: string;
}

export function createStoreTestHandles(): StoreTestHandles {
  return {
    pool: createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'app-backend-tests',
    }),
    redisSig: createRedis(resolveSigRedisUrl()),
    redisCache: createRedis(resolveCacheRedisUrl()),
    redisLease: createRedis(resolveSigRedisUrl()),
    keyRingPath: writeTempSessionKeyRing(),
  };
}

export async function disposeStoreTestHandles(handles: StoreTestHandles): Promise<void> {
  await handles.pool.end();
  handles.redisSig.disconnect();
  handles.redisCache.disconnect();
  handles.redisLease.disconnect();
}

/** The `owner_worker_id` `seedTenantInstanceAndLease` mints its lease row under - callers building a store must use the SAME id. */
export const PROBE_WORKER_ID = 'worker-probe';

/** Seeds `clients`/`whatsapp_instances`/`instance_lease_state` rows for a fresh probe tenant, at `fence`, owned by `PROBE_WORKER_ID`. */
export async function seedTenantInstanceAndLease(
  pool: ReturnType<typeof createPool>,
  fence: bigint,
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Auth Store Probe Client',
    `auth-store-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, 'probe'],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, $3, $4, now())`,
    [instanceId, clientId, fence.toString(), PROBE_WORKER_ID],
  );

  return { clientId, instanceId };
}

export async function cleanupProbeClients(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  // P17 U6 (step 5) - notifications.client_id has no ON DELETE CASCADE; a
  // leaked row would FK-block the DELETE FROM clients below for any caller
  // whose write path now also calls notify() (e.g. runLoggedOutFlow).
  // FIX (P17 close, gate attempt 4): notify() also writes 3 outbox_events
  // rows per notification; outbox_events has no FK to clients either, so it
  // leaked forever and poisoned any later cross-tenant drainOnce/
  // runOneReconcilerSweep-driving test - same mechanism as the P16 lesson,
  // same gap repeated across this fixture's sibling helpers.
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_session_keys WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_session_credentials WHERE client_id = ANY($1)', [
    clientIds,
  ]);
  await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}

/** Builds an `EncryptedAuthStore` bound to real Postgres/Redis/crypto at a given fence. */
export function buildStore(
  handles: StoreTestHandles,
  identity: {
    instanceId: string;
    clientId: string;
    fence: bigint;
    sessionEpoch?: number;
    workerId?: string;
  },
  overrides: { ports?: Partial<AuthStorePorts> } = {},
): EncryptedAuthStore {
  const provider = new FileKeyProvider({
    ringPath: handles.keyRingPath,
    mountedPurposes: ['session'],
  });
  const codec = createAuthCodec({ provider, encVersion: 1 });
  const redisRepo = createSignalRedisRepo({
    redisSig: handles.redisSig,
    redisCache: handles.redisCache,
    env: TEST_ENV,
  });

  return createEncryptedAuthStore({
    db: handles.pool as unknown as SessionStoreDb,
    redisRepo,
    codec,
    identity: {
      instanceId: identity.instanceId,
      clientId: identity.clientId,
      sessionEpoch: identity.sessionEpoch ?? 0,
      fence: identity.fence,
      env: TEST_ENV,
      workerId: identity.workerId ?? PROBE_WORKER_ID,
    },
    ports: makeNoopPorts(overrides.ports),
    metrics: makeNoopMetrics(),
  });
}

/** Acquires a REAL `SessionLease` via `LeaseManager` against real Redis/Postgres. */
export async function acquireRealLease(
  handles: StoreTestHandles,
  clientId: string,
  instanceId: string,
  workerId = 'worker-store-test',
): Promise<SessionLease> {
  const leaseRedis = createLeaseRedis(handles.redisLease, {
    timeoutMs: FAST_TIMING.redisCommandTimeoutMs,
  });
  const tenantDb = createTenantDb(handles.pool);
  const sessionOwner: SessionOwner = { onFenceLost: vi.fn(), close: vi.fn() };

  const manager = new LeaseManager({
    leaseRedis,
    tenantDb,
    sessionOwner,
    timing: FAST_TIMING as unknown as typeof import('@wp/domain').TIMING,
    sleep: async () => undefined,
    workerId,
    env: TEST_ENV,
  });

  const lease = await manager.acquire({ instanceId, clientId });
  if (!lease) {
    throw new Error('acquireRealLease: LeaseManager.acquire returned null - probe setup is wrong');
  }
  return lease;
}
