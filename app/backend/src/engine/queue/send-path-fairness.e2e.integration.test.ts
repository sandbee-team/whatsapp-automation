import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createDwrrSelector, type Band } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { runOneSendLoopIteration } from './send-loop.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';
import { sendLoopDepsUsing } from './__tests__/send-path-e2e-test-support.js';

/**
 * send-path-fairness.e2e.integration.test.ts (P11 Unit U6b) - the DWRR
 * fairness half of mandatory test 19: proves the same 6:3:1 deficit-
 * weighted starvation-freedom property `packages/domain/src/queue/
 * dwrr.test.ts`'s pure selector already proves, but THROUGH the real
 * `claimOne()` against real Postgres, via `send-path.e2e.integration.
 * test.ts`'s sibling wiring (`__tests__/send-path-e2e-test-support.ts`).
 *
 * The phase text says "continuous HIGH enqueue for 2 min" - a literal
 * 2-minute wall-clock soak is FORBIDDEN here (core-invariants.md's "no
 * ambient state" rule: no test may assert on a wall-clock margin or a
 * sampled outcome that ambient load can perturb). What the property
 * actually requires is proved instead with a BOUNDED, fully deterministic
 * number of iterations against a continuous supply and an exact expected
 * band split - never a bound.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'send-path-fairness-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('send-path e2e - DWRR fairness through the real claim (P11 U6b, mandatory test 19)', () => {
  it('high_flood_does_not_starve_low', async () => {
    // Determinism recipe: (1) a SHARED DwrrSelector instance is reused
    // across every iteration below - exactly like production's per-lease
    // selector [R-39] - so its internal deficit state evolves identically
    // to the pure-selector test's own sequence; (2) a FROZEN clock (never
    // advances) means the 3s interim pacing floor never blocks a
    // consecutive claim, so the loop's iteration count alone determines
    // how many jobs get claimed; (3) 30 iterations = exactly 3 full 6:3:1
    // DWRR cycles, seeded with 30 jobs per band so no band ever runs dry
    // mid-run. The exact resulting split (18/9/3) is the SAME split the
    // pure selector produces for an identical 30-call sequence against
    // `available = {HIGH:true, NORMAL:true, LOW:true}` throughout - verified
    // by simulation before writing this assertion.
    const clientId = randomUUID();
    const instanceId = randomUUID();
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, 'Flood Probe Client', `flood-probe-${clientId}`, 'active'],
    );
    await pool.query(
      'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1, $2, $3, $4)',
      [clientId, 1_000_000, 'active', 100],
    );
    // P18 U3: resolveAck resolves the tenant's rate inside the result
    // transaction and fails closed (UnpricedKeyError) with no
    // client_pricing row - same fix as queue-send-tenant-fixture.ts's
    // seedSendTenant.
    await pool.query('INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)', [
      clientId,
      'default_inr',
    ]);
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'flood-probe', 'connected', 0)`,
      [instanceId, clientId],
    );
    await pool.query(
      'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
      [instanceId, clientId, 1],
    );
    probeClientIds.push(clientId);

    const ITERATIONS = 30;
    const bandWeights: Record<Band, number> = { HIGH: 6, NORMAL: 3, LOW: 1 };
    for (const band of ['HIGH', 'NORMAL', 'LOW'] as const) {
      for (let i = 0; i < ITERATIONS; i += 1) {
        await seedQueuedJob(pool, { clientId, instanceId, priorityRank: bandWeights[band] });
      }
    }

    const transport = createFakeTransport();
    for (let i = 0; i < ITERATIONS; i += 1) {
      transport.queueResolve(0, `wamid.flood-${String(i)}`);
    }

    const frozenNow = Date.now();
    const dwrr = createDwrrSelector();
    const claimedBandCounts: Record<Band, number> = { HIGH: 0, NORMAL: 0, LOW: 0 };

    for (let i = 0; i < ITERATIONS; i += 1) {
      const result = await runOneSendLoopIteration(
        sendLoopDepsUsing(
          pool,
          tenantDb,
          clientId,
          instanceId,
          1,
          transport,
          dwrr,
          () => frozenNow,
        ),
      );
      expect(result.claimed).toBe(true);

      const claimedRow = await pool.query<{ priority_rank: number }>(
        `SELECT priority_rank FROM message_jobs WHERE client_id = $1 AND status = 'sent'
          ORDER BY sent_at DESC LIMIT 1`,
        [clientId],
      );
      const rank = claimedRow.rows[0]?.priority_rank;
      const band = (Object.keys(bandWeights) as Band[]).find((b) => bandWeights[b] === rank);
      if (band) claimedBandCounts[band] += 1;
    }

    // Exact expected split for 30 iterations under the real 6:3:1 DWRR
    // selector - never a bound.
    expect(claimedBandCounts).toEqual({ HIGH: 18, NORMAL: 9, LOW: 3 });

    // NORMAL and LOW both cleared a non-zero throughput floor under a
    // continuous HIGH stream - the starvation-freedom property itself.
    expect(claimedBandCounts.NORMAL).toBeGreaterThan(0);
    expect(claimedBandCounts.LOW).toBeGreaterThan(0);
  });
});
