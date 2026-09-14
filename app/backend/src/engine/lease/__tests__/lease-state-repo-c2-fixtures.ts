import { randomUUID } from 'node:crypto';
import { createPool, createWorkerDb } from '@wp/db';
import type { createRedis } from '../../../platform/redis.js';
import { mintFence, type MintFenceCtx } from '../lease-state-repo.js';

/**
 * lease-state-repo-c2-fixtures.ts (__tests__ fixture - the tenant-scope guard's test-path convention: seeding helpers that touch tenant tables must live under a tests?/__tests__ segment or a .test suffix, scripts/check-tenant-scope.ts TEST_FILE_PATTERN) - shared Postgres/Redis
 * lifecycle and probe-client/instance seeding for
 * lease-state-repo.c2.integration.test.ts (probes 1-2) and
 * lease-state-repo.c2.cross-worker.integration.test.ts (probes 6-7), split
 * out of a single over-300-line integration test file so both halves share
 * one setup instead of duplicating it.
 */

export type TestPool = ReturnType<typeof createPool>;
export type TestRedis = ReturnType<typeof createRedis>;

export interface C2Fixtures {
  pool: TestPool;
  redis: TestRedis;
  workerDb: ReturnType<typeof createWorkerDb>;
  probeClientIds: string[];
  probeKeys: string[];
}

export async function seedClientAndInstance(
  pool: TestPool,
  probeClientIds: string[],
  label: string,
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Lease C2 Probe Client',
    `lease-c2-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch, desired_state, link_state, deleted_at)
     VALUES ($1, $2, $3, 'connected', 0, 'online', 'linked', NULL)`,
    [instanceId, clientId, label],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

export async function mintFenceInOwnTransaction(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  workerId: string,
): Promise<bigint> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx: MintFenceCtx = { clientId, sql: client };
    const result = await mintFence(ctx, { instanceId, workerId });
    await client.query('COMMIT');
    return result.fence;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
