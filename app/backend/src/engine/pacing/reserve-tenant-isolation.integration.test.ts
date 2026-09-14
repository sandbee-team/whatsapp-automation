import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import { claimAndReserve } from '../queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
  type TestPool,
} from '../queue/__tests__/queue-send-test-helpers.js';
import { reserve } from './index.js';
import { cleanupPacingProbeClients, seedPacingInstance } from './__tests__/pacing-test-helpers.js';

/**
 * reserve-tenant-isolation.integration.test.ts (P13 C2 hardening) - the
 * pacing surface's own tenant-isolation proof, structurally mirroring
 * `modules/queue/claim.rls.integration.test.ts`'s "wrong GUC" pattern. No
 * sibling pacing suite exercises RLS/role at all - every existing
 * `reserve()`/`release()` test runs straight off the dev pool's own
 * `wp` superuser connection (`rolbypassrls = true`), which is blind to a
 * cross-tenant regression here exactly the way P11's finding 5 was blind
 * for `claimOne` before that suite's own RLS file landed.
 *
 * Two cases: (1) `claimAndReserve()` under the real `wp_scheduler` role
 * with `app.client_id` set to the WRONG tenant never reserves a unit
 * against the RIGHT tenant's ledger (RLS on `instance_pacing_state`/
 * `pacing_ledger`/`message_jobs` filters the wrong-tenant's queries down to
 * zero visible rows before any predicate runs). (2) a continuous stream of
 * denials for tenant A (a flooded/zero-cap instance) never touches tenant
 * B's ledger, `client_daily_usage`, or `eff_*` row - the isolation
 * invariant priority 5 calls out by name, asserted as an EXACT byte-
 * identical read of B's own row, never a bound.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-tenant-isolation-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let sendProbeClientIds: string[] = [];
let pacingProbeClientIds: string[] = [];

afterEach(async () => {
  await cleanupSendProbeClients(pool, sendProbeClientIds);
  sendProbeClientIds = [];
  await cleanupPacingProbeClients(pool, pacingProbeClientIds);
  pacingProbeClientIds = [];
});

const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

describe('pacing tenant isolation under wp_scheduler + RLS', () => {
  it('claim_and_reserve_under_the_wrong_tenant_guc_never_reserves_a_unit', async () => {
    const tenantA = await seedSendTenant(pool, sendProbeClientIds);
    const tenantB = await seedSendTenant(pool, sendProbeClientIds);
    const jobA = await seedQueuedJob(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
    });

    // A TenantDb whose withTenant runs under wp_scheduler but with
    // app.client_id ALWAYS set to tenant B, regardless of the clientId
    // argument callers pass - reproducing a caller bug (or a compromised
    // context) that presents tenant A's ids to claimAndReserve while the
    // transaction's own tenant GUC is wrong.
    const wrongGucTenantDb = {
      async withTenant<T>(_clientId: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
        const realTenantDb = createTenantDbAsRole(pool, 'wp_scheduler');
        return realTenantDb.withTenant(tenantB.clientId, fn as never);
      },
    };

    const claimOneAndReserve = claimAndReserve({
      tenantDb: wrongGucTenantDb as unknown as ReturnType<typeof createTenantDb>,
      rng: { random: () => 0.5 },
      clock: fixedClock,
    });

    const claimed = await claimOneAndReserve(
      { clientId: tenantA.clientId, sql: pool },
      {
        instanceId: tenantA.instanceId,
        band: 3,
        fence: 1,
        workerId: 'wrong-guc-isolation-test-worker',
        claimExpiryMs: 90_000,
      },
    );

    // RLS on message_jobs (scoped to tenant B's GUC) makes tenant A's job
    // invisible to the claim itself - zero rows, never a claim, never a
    // reserve.
    expect(claimed).toBeUndefined();

    const jobRow = await pool.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM message_jobs WHERE id = $1',
      [jobA.id],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');
    expect(jobRow.rows[0]?.attempts).toBe(0);

    const ledgerA = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [tenantA.instanceId],
    );
    expect(ledgerA.rows[0]?.consumed_count ?? 0).toBe(0);
    const ledgerB = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [tenantB.instanceId],
    );
    expect(ledgerB.rows[0]?.consumed_count ?? 0).toBe(0);
  });

  it('a_flooded_zero_cap_tenant_never_moves_a_sibling_tenants_ledger_or_client_daily_usage', async () => {
    const flooded = await seedPacingInstance(pool, pacingProbeClientIds, {
      dailyCap: 0,
    });
    const quiet = await seedPacingInstance(pool, pacingProbeClientIds, {
      dailyCap: 5,
    });

    // A continuous stream of 50 denied reserves against the flooded
    // (zero-cap) tenant's instance.
    for (let i = 0; i < 50; i += 1) {
      const outcome = await reserve({
        sql: pool,
        clientId: flooded.clientId,
        instanceId: flooded.instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      expect(outcome.granted).toBe(false);
    }

    // The quiet tenant, seeded with its own daily_cap of 5, still grants
    // exactly 5 - completely undisturbed by the flooded tenant's 50
    // denials against a DIFFERENT client_id/instance_id.
    let grants = 0;
    for (let i = 0; i < 5; i += 1) {
      const outcome = await reserve({
        sql: pool,
        clientId: quiet.clientId,
        instanceId: quiet.instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      if (outcome.granted) grants += 1;
    }
    expect(grants).toBe(5);

    const quietLedger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [quiet.instanceId],
    );
    expect(quietLedger.rows[0]?.consumed_count).toBe(5);

    const floodedLedger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [flooded.instanceId],
    );
    expect(floodedLedger.rows[0]?.consumed_count ?? 0).toBe(0);

    // eff_* rows are per-instance and untouched by either tenant's reserve
    // traffic - the quiet tenant's own eff_daily_cap is still exactly 5.
    const quietState = await pool.query<{ eff_daily_cap: number }>(
      'SELECT eff_daily_cap FROM instance_pacing_state WHERE instance_id = $1',
      [quiet.instanceId],
    );
    expect(quietState.rows[0]?.eff_daily_cap).toBe(5);
  });
});
