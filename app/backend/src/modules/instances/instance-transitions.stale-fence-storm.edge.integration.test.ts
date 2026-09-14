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
 * instance-transitions.stale-fence-storm.edge.integration.test.ts - E3
 * edge-case pass (P08 session-qr-linking). `instance-transitions.stale-fence
 * .integration.test.ts` already proves two SEQUENTIAL stale writers each get
 * `StateWriteLostFenceError`. This file adds the CONCURRENCY dimension the
 * dispatch calls out explicitly: 10 stale writers firing `markLinkedConnected`
 * AT ONCE (a lost-lease/failover storm) - every single one must reject with
 * `StateWriteLostFenceError`, ZERO rows may change, and there must be no
 * partial/torn audit trail (this write path has no audit row of its own, so
 * "no partial audit rows" is proven by the row itself staying byte-identical,
 * matching the sequential test's own assertion shape).
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

describe('stale-fence storm: many concurrent writers all lose', () => {
  it('ten_concurrent_stale_writers_all_reject_zero_rows_change', async () => {
    const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(clientId);
    const liveFence = 9n;
    await seedLease(pool, { clientId, instanceId, fence: liveFence, workerId: PROBE_WORKER_ID });

    const ctx = ctxFor(pool, clientId);
    const staleFence = liveFence - 1n;

    const attempts = Array.from({ length: 10 }, (_, i) =>
      markLinkedConnected(ctx, {
        instanceId,
        fence: staleFence,
        workerId: PROBE_WORKER_ID,
        ownerJid: `storm-writer-${String(i)}@s.whatsapp.net`,
        phoneE164: '+15550001111',
      }),
    );

    const results = await Promise.allSettled(attempts);

    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(StateWriteLostFenceError);
      }
    }

    // The live row is byte-identical after all 10 rejected concurrent writes
    // - no torn/partial write from any of the 10 ever landed.
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
