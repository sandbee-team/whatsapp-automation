import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { mintFence, type MintFenceCtx } from '../lease-state-repo.js';

/**
 * lease-state-repo-edge-fixtures.ts (__tests__ fixture - the tenant-scope guard's test-path convention: seeding helpers that touch tenant tables must live under a tests?/__tests__ segment or a .test suffix, scripts/check-tenant-scope.ts TEST_FILE_PATTERN) - shared
 * client/instance seeding and mint helper for
 * lease-state-repo.edge.integration.test.ts (mint/release/scan probes) and
 * lease-state-repo.edge.renew-fence.integration.test.ts (renew/fence-
 * integrity probes), split out of a single over-300-line integration test
 * file so both halves share one seeding shape instead of duplicating it.
 */

export type TestPool = ReturnType<typeof createPool>;

export async function seedClientAndInstance(
  pool: TestPool,
  probeClientIds: string[],
  label: string,
  overrides: {
    desiredState?: string;
    linkState?: string;
    healthState?: string;
    deletedAt?: boolean;
  } = {},
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Lease Edge Probe Client',
    `lease-edge-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, session_epoch, desired_state, link_state, deleted_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
    [
      instanceId,
      clientId,
      label,
      overrides.healthState ?? 'connected',
      overrides.desiredState ?? 'online',
      overrides.linkState ?? 'linked',
      overrides.deletedAt ? new Date() : null,
    ],
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
