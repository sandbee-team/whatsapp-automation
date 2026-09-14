import { createPool } from '@wp/db';
import { applyDisconnect } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import type { EncryptedAuthStore } from '../../provider/baileys/auth-state/types.js';
import { applyEngineTransition, runLoggedOutFlow, type InstanceServiceDeps } from './service.js';
import {
  PROBE_WORKER_ID,
  cleanupProbeClients,
  ctxFor,
  seedLease,
  seedTenant,
  type TestPool,
} from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.audit.integration.test.ts (P08 Unit U4) - proves
 * EVERY transition out of `health_state 'connected'` writes exactly ONE
 * `audit_logs` row with a reason + actor, driven via `service.ts` (not the
 * raw repo) so the audit-writing behavior itself is under test, not just the
 * state write.
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

async function auditRowsFor(
  instanceId: string,
): Promise<{ action: string; actor_type: string; metadata: unknown }[]> {
  const result = await pool.query<{ action: string; actor_type: string; metadata: unknown }>(
    `SELECT action, actor_type, metadata FROM audit_logs WHERE target_id = $1 ORDER BY created_at`,
    [instanceId],
  );
  return result.rows;
}

describe('every transition out of connected writes an audit row', () => {
  it('every_transition_out_of_connected_writes_an_audit_row', async () => {
    // --- connected -> degraded (an "unknown" disconnect, first occurrence).
    {
      const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
      probeClientIds.push(clientId);
      const fence = 7n;
      await seedLease(pool, { clientId, instanceId, fence });
      const deps: InstanceServiceDeps = { ctx: ctxFor(pool, clientId), auditSql: pool as never };

      const transition = applyDisconnect(
        {
          healthState: 'connected',
          linkState: 'linked',
          autoReconnect: true,
          budget: 'limited2',
          action: 'stay',
          surfaceAsError: false,
        },
        { restart515Used: 0, unknownAttempts: 0 },
      );
      expect(transition.healthState).toBe('degraded');

      await applyEngineTransition(deps, instanceId, 'connected', transition, {
        fence,
        workerId: PROBE_WORKER_ID,
      });

      const rows = await auditRowsFor(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'instance.degraded', actor_type: 'system' });
    }

    // --- connected -> paused (restriction signal, the "403" class).
    {
      const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
      probeClientIds.push(clientId);
      const fence = 9n;
      await seedLease(pool, { clientId, instanceId, fence });
      const deps: InstanceServiceDeps = { ctx: ctxFor(pool, clientId), auditSql: pool as never };

      const transition = applyDisconnect(
        {
          healthState: 'connected',
          linkState: 'linked',
          autoReconnect: false,
          budget: null,
          action: 'restriction',
          surfaceAsError: true,
        },
        { restart515Used: 0, unknownAttempts: 0 },
      );
      expect(transition.healthState).toBe('paused');
      expect(transition.userActionReason).toBe('RESTRICTION_SIGNAL');

      await applyEngineTransition(deps, instanceId, 'connected', transition, {
        fence,
        workerId: PROBE_WORKER_ID,
        code: '403',
      });

      const rows = await auditRowsFor(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'instance.paused', actor_type: 'system' });
      expect(rows[0]?.metadata).toMatchObject({ reason: 'RESTRICTION_SIGNAL', code: '403' });

      const row = await pool.query<{ pause_reason: string | null; paused_at: Date | null }>(
        'SELECT pause_reason, paused_at FROM whatsapp_instances WHERE id = $1',
        [instanceId],
      );
      expect(row.rows[0]?.pause_reason).toBe('provider_restriction');
      expect(row.rows[0]?.paused_at).not.toBeNull();
    }

    // --- connected -> logged_out (via the dedicated logged-out flow).
    {
      const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
      probeClientIds.push(clientId);
      const fence = 11n;
      await seedLease(pool, { clientId, instanceId, fence });
      const deps: InstanceServiceDeps = { ctx: ctxFor(pool, clientId), auditSql: pool as never };
      const authStore: EncryptedAuthStore = {
        loadCreds: vi.fn(),
        saveCreds: vi.fn(),
        getKeys: vi.fn(),
        setKeys: vi.fn(),
        purge: vi.fn().mockResolvedValue({ purged: true }),
        asSignalKeyStore: vi.fn(),
      } as unknown as EncryptedAuthStore;

      await runLoggedOutFlow(deps, { instanceId, fence, workerId: PROBE_WORKER_ID, authStore });

      const rows = await auditRowsFor(instanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'instance.logged_out', actor_type: 'system' });
      expect(authStore.purge).toHaveBeenCalledWith(fence);

      const row = await pool.query<{ health_state: string; link_state: string }>(
        'SELECT health_state, link_state FROM whatsapp_instances WHERE id = $1',
        [instanceId],
      );
      expect(row.rows[0]).toEqual({ health_state: 'logged_out', link_state: 'unlinked' });
    }
  });
});
