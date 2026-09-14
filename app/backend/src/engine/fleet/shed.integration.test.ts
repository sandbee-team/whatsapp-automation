import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseManager } from '../lease/lease-manager.js';
import { createLeaseRedis, type LeaseRedis } from '../lease/lease-redis.js';
import type { SessionOwner } from '../lease/session-owner.port.js';
import { shedVictims, type ShedPorts } from './shed.js';

/**
 * shed.integration.test.ts (P09 U4 step 6, named test
 * `shed_releases_the_lease_gracefully_and_queued_jobs_are_untouched`) - real
 * PG+Redis proof that `shedVictims`'s `releaseLeaseGracefully` port, wired to
 * the real `LeaseManager.release()`, lets a second acquirer re-grab
 * PROMPTLY (grace skipped, same signature as `lease-release.integration.test.ts`'s
 * own grace-skip proof), and leaves seeded `message_jobs` rows byte-identical
 * (count + status + payload) before and after the shed.
 */

type TestPool = ReturnType<typeof createPool>;
type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;

const ENV = 'test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 200,
  takeoverGraceMs: 150,
  watchdogMs: 2_000,
  sendTimeoutMs: 1000,
  claimExpiryMs: 2000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 1_000,
} as const;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

let probeClientIds: string[] = [];
let probeKeys: string[] = [];

afterEach(async () => {
  if (probeKeys.length > 0) {
    await redis.del(...probeKeys);
    probeKeys = [];
  }
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedTenantAndInstance(): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Shed Probe Client',
    `shed-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, 'probe'],
  );

  probeClientIds.push(clientId);
  probeKeys.push(tenantKey(ENV, clientId, 'lease', 'i', instanceId));
  return { clientId, instanceId };
}

interface SeededJobRow {
  id: string;
  status: string;
  payload: unknown;
}

async function seedQueuedJob(clientId: string, instanceId: string): Promise<SeededJobRow> {
  const result = await pool.query<{ id: string; status: string; payload: unknown }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'queued', now(), now())
     RETURNING id, status, payload`,
    [clientId, instanceId, '15550000000@s.whatsapp.net', JSON.stringify({ text: 'shed-probe' })],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedQueuedJob: INSERT ... RETURNING returned no row');
  return row;
}

async function readJobRows(clientId: string): Promise<SeededJobRow[]> {
  const result = await pool.query<{ id: string; status: string; payload: unknown }>(
    'SELECT id, status, payload FROM message_jobs WHERE client_id = $1 ORDER BY id',
    [clientId],
  );
  return result.rows;
}

function makeSessionOwner(): SessionOwner {
  return { onFenceLost: vi.fn(), close: vi.fn() };
}

function makeManager(workerId: string, leaseRedis: LeaseRedis): LeaseManager {
  return new LeaseManager({
    leaseRedis,
    tenantDb: createTenantDb(pool),
    sessionOwner: makeSessionOwner(),
    timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    sleep: async () => undefined,
    workerId,
    env: ENV,
  });
}

describe('shedVictims - real PG+Redis', () => {
  it('shed_releases_the_lease_gracefully_and_queued_jobs_are_untouched', async () => {
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const { clientId, instanceId } = await seedTenantAndInstance();
    const seededJob = await seedQueuedJob(clientId, instanceId);

    const managerA = makeManager('worker-a', leaseRedis);
    const leaseA = await managerA.acquire({ instanceId, clientId });
    expect(leaseA).not.toBeNull();

    const endSocket = vi.fn(async () => undefined);
    const ports: ShedPorts = {
      endSocket,
      releaseLeaseGracefully: async () => {
        await managerA.release(leaseA!);
      },
    };

    const results = await shedVictims([instanceId], ports);
    expect(results).toEqual([{ instanceId, ok: true, endOk: true, releaseOk: true }]);
    expect(endSocket).toHaveBeenCalledWith(instanceId);

    // released_at is set - the grace-skip authority for the next acquirer.
    const releasedRow = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(releasedRow.rows[0]?.released_at).not.toBeNull();

    // A second acquirer re-grabs PROMPTLY: grace skipped (no sleep needed -
    // sleep is a no-op here, so the meaningful proof is a non-null lease at
    // a strictly greater fence, mirroring lease-release.integration.test.ts's
    // own "released_at recent -> grace skipped" contract).
    const sleepB = vi.fn();
    const managerB = new LeaseManager({
      leaseRedis,
      tenantDb: createTenantDb(pool),
      sessionOwner: makeSessionOwner(),
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      sleep: async (ms: number) => {
        sleepB(ms);
      },
      workerId: 'worker-b',
      env: ENV,
    });
    const leaseB = await managerB.acquire({ instanceId, clientId });
    expect(leaseB).not.toBeNull();
    expect(sleepB).not.toHaveBeenCalled();
    expect(leaseB!.fence).toBeGreaterThan(leaseA!.fence);

    // Seeded message_jobs rows are byte-identical before/after (count +
    // status + payload) - shedding a lease must never touch the queue.
    const afterRows = await readJobRows(clientId);
    expect(afterRows).toEqual([
      { id: seededJob.id, status: seededJob.status, payload: seededJob.payload },
    ]);
  }, 30_000);
});
