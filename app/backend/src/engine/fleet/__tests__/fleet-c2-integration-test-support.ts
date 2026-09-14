import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import type { createRedis } from '../../../platform/redis.js';

/**
 * fleet-c2-integration-test-support.ts (FIX-P09-B split) - shared
 * `seedInstance` helper for `fleet-c2.integration.test.ts`'s split files,
 * mechanically extracted at FIX-P09-B for the max-lines cap. No logic
 * change - same helper, same behavior.
 *
 * Lives under `__tests__/` so the tenant-scope guard's own test-path
 * exemption covers its seed INSERTs - see
 * `discovery-integration-test-support.ts`'s own doc comment for the exact
 * convention this follows.
 */

export type Pool = ReturnType<typeof createPool>;

export async function seedInstance(
  pool: Pool,
  probeClientIds: string[],
  options: { clientCompanyName: string; label: string },
): Promise<{
  clientId: string;
  instanceId: string;
}> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    options.clientCompanyName,
    `fleet-c2-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, session_epoch, desired_state, link_state)
     VALUES ($1, $2, $3, 'connected', 0, 'online', 'linked')`,
    [instanceId, clientId, options.label],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

export const COMPRESSED_TIMING = {
  leaseTtlMs: 3_000,
  heartbeatMs: 200,
  takeoverGraceMs: 100,
  watchdogMs: 2_000,
  sendTimeoutMs: 1000,
  claimExpiryMs: 2000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 2_000,
} as const;

export type RedisHandle = ReturnType<typeof createRedis>;
