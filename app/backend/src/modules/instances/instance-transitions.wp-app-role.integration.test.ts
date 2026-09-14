import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { provisioningRepo } from '../tenancy/index.js';
import {
  createInstance,
  beginPairingIntent,
  markLinkedConnected,
  type InstanceCtx,
} from './repo.js';
import { cleanupProbeClients, type TestPool } from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.wp-app-role.integration.test.ts (P08 Unit U4,
 * MANDATORY per the task - P07 lesson) - `createInstance` +
 * `beginPairingIntent` + one ENGINE write (`markLinkedConnected`) + the
 * audit insert ALL run under `SET LOCAL ROLE wp_app` with
 * `set_config('app.client_id', ...)`, exactly mirroring
 * `provider/baileys/auth-state/wp-app-role.integration.test.ts`'s own
 * harness pattern. If ANY statement hits 42501 (insufficient_privilege),
 * this test fails loudly - migration 0023's grants are proven live, not
 * merely trusted.
 */

interface TestPoolClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: Error): void;
}

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

/** Builds an `InstanceQueryable`-shaped executor where EVERY `.query()` call runs under `SET LOCAL ROLE wp_app` with `app.client_id` set - one short-lived transaction per call, mirroring `wp-app-role.integration.test.ts`'s `createSessionStoreDbAsWpApp`. */
function ctxAsWpApp(testPool: TestPool, clientId: string): InstanceCtx {
  return {
    clientId,
    sql: {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<{ rows: T[] }> {
        const client: TestPoolClient = await testPool.connect();
        let releaseError: unknown;
        try {
          await client.query('BEGIN');
          try {
            await client.query('SET LOCAL ROLE wp_app');
            await client.query('SELECT set_config($1, $2, true)', ['app.client_id', clientId]);
            const result = await client.query<T>(sql, params);
            await client.query('COMMIT');
            return { rows: result.rows };
          } catch (err) {
            try {
              await client.query('ROLLBACK');
              releaseError = undefined;
            } catch (rollbackErr) {
              releaseError = rollbackErr;
            }
            throw err;
          }
        } finally {
          if (releaseError !== undefined) {
            client.release(releaseError as Error);
          } else {
            client.release();
          }
        }
      },
    },
  };
}

const PROBE_WORKER_ID = 'worker-instances-wp-app-role-probe';

describe('modules/instances state transitions under the real wp_app role', () => {
  it('createInstance_beginPairingIntent_markLinkedConnected_and_the_audit_insert_all_succeed_under_wp_app', async () => {
    const clientId = randomUUID();
    probeClientIds.push(clientId);
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [
        clientId,
        'Instances WP App Role Probe',
        `instances-wp-app-role-probe-${clientId}`,
        'active',
      ],
    );

    const ctx = ctxAsWpApp(pool, clientId);

    // 1. createInstance - full-row INSERT under wp_app (migration 0023 ITEM 3).
    const instanceId = await createInstance(ctx, { label: 'probe' });
    expect(instanceId).toEqual(expect.any(String));

    // Seed the lease row as the superuser pool - the lease row itself is not
    // part of the wp_app grant proof (instance_lease_state's own grants are
    // P06's, already proven live there).
    const fence = 3n;
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
       VALUES ($1, $2, $3, $4, now())`,
      [instanceId, clientId, fence.toString(), PROBE_WORKER_ID],
    );

    // 2. beginPairingIntent - client-scoped UPDATE under wp_app.
    const paired = await beginPairingIntent(ctx, instanceId);
    expect(paired).toBe(true);

    // 3. markLinkedConnected - fence-guarded ENGINE UPDATE under wp_app.
    await markLinkedConnected(ctx, {
      instanceId,
      fence,
      workerId: PROBE_WORKER_ID,
      ownerJid: 'probe@s.whatsapp.net',
      phoneE164: '+15550000000',
    });

    // 4. The audit insert - reuses provisioningRepo.insertAuditLog, run
    // through the SAME wp_app-role-wrapped executor.
    await provisioningRepo.insertAuditLog(ctx.sql as never, {
      clientId,
      actorType: 'system',
      action: 'instance.linked',
      targetType: 'instance',
      targetId: instanceId,
    });

    const instanceRow = await pool.query<{ link_state: string; health_state: string }>(
      'SELECT link_state, health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]).toEqual({ link_state: 'linked', health_state: 'connected' });

    const auditRow = await pool.query<{ action: string }>(
      'SELECT action FROM audit_logs WHERE target_id = $1',
      [instanceId],
    );
    expect(auditRow.rows.map((row) => row.action)).toEqual(['instance.linked']);
  });
});
