import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { CLAIMABLE_CAMPAIGN_STATUSES } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { cancelBroadcast } from './lifecycle.service.js';
import { runCancelBookkeepingBatch } from './cancel-bookkeeping.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import {
  drainThroughPacing,
  jobRows,
  noopBookkeeping,
  queueCampaignJobs,
  tryClaim,
  type JobRow,
} from './__tests__/lifecycle-test-support.js';

/**
 * lifecycle.integration.test.ts (P23 Unit U5, step 6) - the claim-predicate
 * proof for CANCEL: enforced by the allow-list claim predicate ALONE (the
 * status commit), never by the bookkeeping batch. Pause/resume and the
 * cross-tenant proof live in the `lifecycle-pause-resume.integration.test.ts`
 * sibling (max-lines split - shared fixture helpers in `__tests__/
 * lifecycle-test-support.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-lifecycle-test',
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

describe('broadcast lifecycle - the cancel claim-predicate proof', () => {
  it('cancelled_broadcast_yields_zero_claims_immediately', async () => {
    const { clientId, instanceId, campaignId } = await queued(50);
    const before = await jobRows(pool, clientId, campaignId);
    expect(before).toHaveLength(50);
    expect(before.every((r) => r.status === 'queued')).toBe(true);

    await cancelBroadcast(
      { tenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
      { kind: 'user', userId: randomUUID() },
      { clientId, id: campaignId },
    );

    expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);

    const stillQueued = await jobRows(pool, clientId, campaignId);
    expect(stillQueued).toHaveLength(50);
    expect(stillQueued.every((r) => r.status === 'queued')).toBe(true);

    await runCancelBookkeepingBatch(tenantDb, { clientId, campaignId });

    const afterBookkeeping = await jobRows(pool, clientId, campaignId);
    expect(afterBookkeeping).toHaveLength(50);
    expect(afterBookkeeping.every((r) => r.status === 'cancelled')).toBe(true);
    expect(afterBookkeeping.every((r) => r.cancel_reason === 'campaign_cancelled')).toBe(true);
  });

  it('a_cancelled_broadcast_charges_nothing_after_the_cancel_commit', async () => {
    const { clientId, instanceId, campaignId } = await queued(20);
    await drainThroughPacing(pool, tenantDb, clientId, instanceId, 10);

    await cancelBroadcast(
      { tenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
      { kind: 'user', userId: randomUUID() },
      { clientId, id: campaignId },
    );

    const ledgerBefore = await pool.query<{ seq: string }>(
      `SELECT coalesce(max(seq), 0)::text AS seq FROM wallet_ledger WHERE client_id = $1`,
      [clientId],
    );
    const balanceBefore = await pool.query<{ balance_minor: string }>(
      `SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1`,
      [clientId],
    );

    for (let i = 0; i < 10; i += 1) {
      expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);
    }
    await runCancelBookkeepingBatch(tenantDb, { clientId, campaignId });

    const ledgerAfter = await pool.query<{ seq: string }>(
      `SELECT coalesce(max(seq), 0)::text AS seq FROM wallet_ledger WHERE client_id = $1`,
      [clientId],
    );
    const balanceAfter = await pool.query<{ balance_minor: string }>(
      `SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1`,
      [clientId],
    );

    expect(ledgerAfter.rows[0]?.seq).toBe(ledgerBefore.rows[0]?.seq);
    expect(balanceAfter.rows[0]?.balance_minor).toBe(balanceBefore.rows[0]?.balance_minor);
  });

  it('crashed_cancel_batch_still_sends_nothing', async () => {
    const { clientId, instanceId, campaignId } = await queued(50);

    await cancelBroadcast(
      { tenantDb, publishWake: () => {}, runBookkeeping: noopBookkeeping },
      { kind: 'user', userId: randomUUID() },
      { clientId, id: campaignId },
    );
    expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);

    await runCancelBookkeepingBatch(tenantDb, { clientId, campaignId, batchSize: 10 });
    expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);

    const rows = await jobRows(pool, clientId, campaignId);
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('an_unknown_campaign_status_yields_zero_claims', async () => {
    const { clientId, instanceId, campaignId } = await queued(10);

    for (const status of ['failed', 'draft']) {
      await pool.query(`UPDATE campaigns SET status = $2 WHERE id = $1`, [campaignId, status]);
      expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);
    }

    const before = await jobRows(pool, clientId, campaignId);
    await pool.query(
      `UPDATE message_jobs SET campaign_id = '00000000-0000-0000-0000-000000000000'
        WHERE client_id = $1 AND campaign_id = $2`,
      [clientId, campaignId],
    );
    expect(await tryClaim(tenantDb, clientId, instanceId)).toBe(false);

    const after = await pool.query<JobRow>(
      `SELECT id, status, cancel_reason FROM message_jobs WHERE client_id = $1 ORDER BY id`,
      [clientId],
    );
    expect(after.rows).toEqual(before);
  });

  it('the_claim_allow_list_matches_the_domain_claimable_statuses', () => {
    const sql = readFileSync(
      new URL('../../../../../db/queries/claim-jobs.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain("cp.status IN ('running','expanding')");
    expect(CLAIMABLE_CAMPAIGN_STATUSES).toEqual(['running', 'expanding']);
  });
});
