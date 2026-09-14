import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { recomputeCampaignFunnel, runOneFunnelRecomputeSweep } from './funnel.public.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { readCounters, seedCampaignWithRecipients } from './__tests__/funnel-test-support.js';
import { countOutbox } from './__tests__/funnel-edge-support.js';

/**
 * funnel-atomicity-c2b.integration.test.ts (P23a C2b hardening pass) -
 * residual crash/atomicity angles `funnel-edge.integration.test.ts` does not
 * cover: (1) a fault INSIDE `recomputeCampaignFunnel`'s transaction (the
 * `emit` call's own INSERT INTO outbox_events statement) rolls back the
 * WHOLE transaction - counters row and campaign status untouched, zero
 * outbox rows - and the NEXT (unfaulted) recompute completes and emits
 * exactly once; (2) `runOneFunnelRecomputeSweep` continues past one tenant's
 * `withTenant` throwing, reconciling the next tenant in the SAME sweep call.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-funnel-atomicity-c2b-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Wraps a real `TenantDb` so any `tx.query` whose SQL contains `matchSql` rejects - every OTHER statement on the same transaction passes through unchanged. Models a fault inside the business transaction (never a wrapper-level throw before `withTenant` even opens its transaction - that is `funnel-stamp-edge-support.ts`'s sibling shape, not this one). */
function withQueryFault(real: TenantDb, matchSql: string): TenantDb {
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      return real.withTenant(clientId, (tx) => {
        const faulty: TenantQueryable = {
          async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ): Promise<{ rows: TRow[]; rowCount: number | null }> {
            if (sql.includes(matchSql)) {
              throw new Error(`simulated fault on statement containing "${matchSql}"`);
            }
            return tx.query<TRow>(sql, params);
          },
        };
        return fn(faulty);
      });
    },
  };
}

/** Wraps a real `TenantDb` so `withTenant` itself throws (before any transaction opens) for one specific `clientId` - every other `clientId` passes through unchanged. */
function withTenantFault(real: TenantDb, faultClientId: string): TenantDb {
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      if (clientId === faultClientId) {
        throw new Error(`simulated withTenant fault for tenant ${faultClientId}`);
      }
      return real.withTenant(clientId, fn);
    },
  };
}

describe('progress funnel atomicity/crash hardening (P23a C2b)', () => {
  it('an_emit_fault_rolls_back_the_whole_recompute_and_the_next_unfaulted_recompute_emits_exactly_once', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCampaignWithRecipients(
      pool,
      tenant,
      'running',
      { queued: 3, sent: 2 },
      false,
    );
    // Force a real recount delta so `changed` would be true and `emit` would
    // actually run absent the fault.
    await pool.query(
      `UPDATE campaign_counters SET total = 999, sent = 999 WHERE campaign_id = $1`,
      [campaignId],
    );

    const beforeCounters = await readCounters(pool, campaignId);
    const beforeStatus = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    const beforeOutbox = await countOutbox(pool, campaignId);

    const faultyDb = withQueryFault(tenantDb, 'INSERT INTO outbox_events');
    await expect(
      recomputeCampaignFunnel(faultyDb, { clientId: tenant.clientId, campaignId }),
    ).rejects.toThrow(/simulated fault/);

    // Whole transaction rolled back: counters row byte-identical, status
    // untouched, zero outbox rows for this campaign.
    const afterFaultCounters = await readCounters(pool, campaignId);
    expect(afterFaultCounters).toEqual(beforeCounters);
    const afterFaultStatus = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(afterFaultStatus.rows[0]?.status).toBe(beforeStatus.rows[0]?.status);
    expect(await countOutbox(pool, campaignId)).toBe(beforeOutbox);

    // The NEXT recompute, unfaulted, completes and emits exactly once.
    const result = await recomputeCampaignFunnel(tenantDb, {
      clientId: tenant.clientId,
      campaignId,
    });
    expect(result.changed).toBe(true);
    expect(await countOutbox(pool, campaignId)).toBe(beforeOutbox + 1);
    const finalCounters = await readCounters(pool, campaignId);
    expect(finalCounters.total).toBe(5);
    expect(finalCounters.queued).toBe(3);
    expect(finalCounters.sent).toBe(2);
  });

  it('the_sweep_continues_past_one_tenants_withtenant_throwing_and_reconciles_the_other_tenant', async () => {
    const tenantA = await seedBroadcastTenant(pool, probeClientIds);
    const tenantB = await seedBroadcastTenant(pool, probeClientIds);

    const campaignA = await seedCampaignWithRecipients(
      pool,
      tenantA,
      'running',
      { queued: 1 },
      false,
    );
    const campaignB = await seedCampaignWithRecipients(
      pool,
      tenantB,
      'running',
      { sent: 4 },
      false,
    );
    // Make both need a genuine reconcile (their zero-value counters rows
    // disagree with the seeded recipient rows).

    const faultyDb = withTenantFault(tenantDb, tenantA.clientId);

    await expect(
      runOneFunnelRecomputeSweep({
        pool,
        tenantDb: faultyDb,
        mode: 'hourly',
        logger: { warn: () => {} },
      }),
    ).resolves.toBeUndefined();

    // Tenant A's counters were never touched (its recompute never even
    // reached a transaction).
    const countersA = await readCounters(pool, campaignA);
    expect(countersA.total).toBe(0);
    expect(countersA.queued).toBe(0);

    // Tenant B's counters ARE reconciled in this same sweep call, despite A
    // throwing first.
    const countersB = await readCounters(pool, campaignB);
    expect(countersB.total).toBe(4);
    expect(countersB.sent).toBe(4);
  });
});
