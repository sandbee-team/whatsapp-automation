import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { cancelBroadcast, pauseBroadcast, resumeBroadcast } from './lifecycle.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { jobRows, queueCampaignJobs, tryClaim } from './__tests__/lifecycle-test-support.js';

/**
 * lifecycle-pause-resume.integration.test.ts (P23 Unit U5, step 6) - pause/
 * resume (invariant 5: pause preserves work, resume publishes exactly one
 * wake per instance) and the cross-tenant invisibility/uncancellability
 * proof. Split out of `lifecycle.integration.test.ts` (max-lines cap) -
 * shared fixture helpers in `__tests__/lifecycle-test-support.ts`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-lifecycle-pause-resume-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildBroadcastsKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function queued(count: number) {
  return queueCampaignJobs(pool, tenantDb, keyProvider, probeClientIds, count);
}

describe('broadcast lifecycle - pause/resume and tenant isolation', () => {
  it('pausing_a_broadcast_loses_no_job_and_resume_publishes_a_wake', async () => {
    const { clientId, instanceId, campaignId } = await queued(200);
    // The claim predicate ALSO requires a wallet_accounts row (INNER JOIN,
    // fail-closed) - seedBroadcastTenant does not seed one (snapshot/
    // expansion never claim), so this test seeds it directly.
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor)
       VALUES ($1, 1000000, 'active', 100)`,
      [clientId],
    );
    await pool.query(
      `UPDATE campaigns SET status = 'running', expand_done_at = now() WHERE id = $1`,
      [campaignId],
    );
    const before = await jobRows(pool, clientId, campaignId);

    await pauseBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: randomUUID() },
      { clientId, id: campaignId },
    );

    expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);

    const afterPause = await jobRows(pool, clientId, campaignId);
    expect(afterPause).toEqual(before);
    expect(afterPause.every((r) => r.status === 'queued')).toBe(true);

    const wakes: Array<{ clientId: string; instanceId: string }> = [];
    await resumeBroadcast(
      {
        tenantDb,
        publishWake: (cId, iId) => {
          wakes.push({ clientId: cId, instanceId: iId });
        },
      },
      { kind: 'user', userId: randomUUID() },
      { clientId, id: campaignId },
    );

    expect(wakes).toEqual([{ clientId, instanceId }]);
    expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(true);
  });

  it('another_tenants_broadcast_is_invisible_and_uncancellable', async () => {
    const a = await queued(5);
    const b = await queued(5);
    const beforeA = await jobRows(pool, a.clientId, a.campaignId);

    await expect(
      cancelBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: randomUUID() },
        { clientId: b.clientId, id: a.campaignId },
      ),
    ).rejects.toThrow();

    const afterA = await jobRows(pool, a.clientId, a.campaignId);
    expect(afterA).toEqual(beforeA);

    const auditRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE client_id = $1 AND target_id = $2 AND action = 'broadcast.cancel'`,
      [b.clientId, a.campaignId],
    );
    expect(auditRows.rows[0]?.count).toBe('0');
  });
});
