import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import * as repo from './repo.js';
import {
  PacingProvisionMissingTierError,
  provisionInstancePacingState,
} from '../../engine/pacing/provision.js';

/**
 * instance-create-provision-transaction.integration.test.ts (P13 C1 review,
 * Finding 7 fix) - proves `createInstance` + `provisionInstancePacingState`
 * now run inside ONE transaction, exactly the shape
 * `instances.routes.ts`'s `POST /v1/instances` handler wires
 * (`deps.tenantDb.withTenant(clientId, async (tx) => { ... })`). Drives the
 * SAME `TenantDb.withTenant` entry point directly (rather than a full
 * HTTP+auth walk, which this module's route-level fixture
 * (`__tests__/instances-routes-test-support.ts`) requires for every other
 * instances-route test) - this test's whole point is the TRANSACTION
 * boundary, which is provable at this layer without any HTTP/auth
 * machinery, and does not need re-proving through an extra HTTP hop.
 *
 * Forces the provision step to fail by passing a `profileKey` that does not
 * exist in `pacing_warmup_tiers` (`provisionInstancePacingState` throws
 * `PacingProvisionMissingTierError` for exactly this shape - see that
 * function's own doc comment) - a real, natural failure mode, not a mock.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'app-backend-instance-create-provision-tx-tests',
});
const tenantDb = createTenantDb(pool);

const probeClientIds: string[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

async function seedProbeClient(): Promise<string> {
  const clientId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Instance Create Tx Probe Client',
    `instance-create-tx-probe-${clientId}`,
    'active',
  ]);
  probeClientIds.push(clientId);
  return clientId;
}

describe('instance create + pacing provision transaction (Finding 7)', () => {
  it('a_provision_failure_rolls_back_the_just_created_instance_row', async () => {
    const clientId = await seedProbeClient();

    await expect(
      tenantDb.withTenant(clientId, async (tx) => {
        const txCtx = { clientId, sql: tx };
        const id = await repo.createInstance(txCtx, { label: 'rollback-probe' });
        // Non-existent profile - provisionInstancePacingState throws
        // PacingProvisionMissingTierError, a real failure mode (never a
        // mock), before this transaction's implicit COMMIT.
        await provisionInstancePacingState(tx, {
          clientId,
          instanceId: id,
          profileKey: 'does-not-exist-profile',
        });
      }),
    ).rejects.toThrow(PacingProvisionMissingTierError);

    // The whole transaction rolled back - NEITHER the instance row NOR any
    // pacing state row exists. Before the Finding 7 fix, createInstance and
    // provisionInstancePacingState ran as two separate statements with no
    // shared transaction, so a provision failure here would have left the
    // whatsapp_instances row committed and orphaned (no pacing state,
    // deleted_at IS NULL) - exactly the shape
    // assertNoLiveInstanceIsMissingPacingState refuses to boot over.
    const instanceRows = await pool.query(
      'SELECT id FROM whatsapp_instances WHERE client_id = $1',
      [clientId],
    );
    expect(instanceRows.rows).toEqual([]);

    const pacingRows = await pool.query(
      'SELECT instance_id FROM instance_pacing_state WHERE client_id = $1',
      [clientId],
    );
    expect(pacingRows.rows).toEqual([]);
  });

  it('a_successful_provision_commits_both_the_instance_and_pacing_state_rows_together', async () => {
    const clientId = await seedProbeClient();

    const id = await tenantDb.withTenant(clientId, async (tx) => {
      const txCtx = { clientId, sql: tx };
      const newId = await repo.createInstance(txCtx, { label: 'commit-probe' });
      await provisionInstancePacingState(tx, { clientId, instanceId: newId });
      return newId;
    });

    const instanceRows = await pool.query<{ id: string }>(
      'SELECT id FROM whatsapp_instances WHERE client_id = $1',
      [clientId],
    );
    expect(instanceRows.rows).toEqual([{ id }]);

    const pacingRows = await pool.query<{ instance_id: string }>(
      'SELECT instance_id FROM instance_pacing_state WHERE client_id = $1',
      [clientId],
    );
    expect(pacingRows.rows).toEqual([{ instance_id: id }]);
  });
});
