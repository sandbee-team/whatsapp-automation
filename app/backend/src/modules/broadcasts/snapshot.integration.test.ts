import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { BroadcastLimitError } from './limits.js';
import { runSnapshotBatch, runSnapshotToCompletion } from './snapshot.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastCampaign,
  seedBroadcastContact,
  seedBroadcastTenant,
  seedSnapshottingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';

/**
 * snapshot.integration.test.ts (P23 Unit U4, step 4) - Phase A, the audience
 * snapshot worker: the frozen-vars guarantee, opt-out exclusion, the plan
 * ceiling (fail loud, truncate nothing), and crash-resumability.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-snapshot-test',
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

describe('broadcast snapshot worker (Phase A)', () => {
  it('the_snapshot_is_frozen_against_later_contact_edits', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(
      pool,
      probeClientIds,
      'Hi {{first_name}}!',
    );

    for (let i = 0; i < 50; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i, { firstName: `Name${String(i)}` });
    }

    const result = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      {
        campaignId,
        clientId: tenant.clientId,
      },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 50 });

    const before = await pool.query<{ vars: { first_name: string } }>(
      `SELECT vars FROM campaign_recipients WHERE campaign_id = $1 ORDER BY contact_id LIMIT 1`,
      [campaignId],
    );
    const frozenFirstName = before.rows[0]?.vars.first_name;
    expect(frozenFirstName).toMatch(/^Name/);

    // Edit an existing contact's first_name AND add 10 more contacts to the tag.
    await pool.query('UPDATE contacts SET first_name = $1 WHERE client_id = $2', [
      'Edited-After-Snapshot',
      tenant.clientId,
    ]);
    for (let i = 50; i < 60; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i, { firstName: `Name${String(i)}` });
    }

    // Re-running snapshot is a no-op (already snapshot_done -> status is now 'expanding').
    const rerun = await runSnapshotBatch({ tenantDb }, { campaignId, clientId: tenant.clientId });
    expect(rerun).toEqual({ kind: 'done', audienceCount: 0 });

    const audienceCountRow = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(audienceCountRow.rows[0]?.count).toBe('50');

    const stillFrozen = await pool.query<{ vars: { first_name: string } }>(
      `SELECT vars FROM campaign_recipients WHERE campaign_id = $1 ORDER BY contact_id LIMIT 1`,
      [campaignId],
    );
    expect(stillFrozen.rows[0]?.vars.first_name).toBe(frozenFirstName);
    expect(stillFrozen.rows[0]?.vars.first_name).not.toBe('Edited-After-Snapshot');
  });

  it('opted_out_contacts_are_snapshotted_as_skipped_and_never_expanded', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(
      pool,
      probeClientIds,
      'Hello there!',
    );

    const contacts = [];
    for (let i = 0; i < 20; i += 1) {
      contacts.push(await seedBroadcastContact(pool, keyProvider, tenant, i));
    }
    const optedOut = contacts.slice(0, 5);
    for (const contact of optedOut) {
      await pool.query(
        `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source)
         VALUES (gen_random_uuid(), $1, 'client', $1, $2, $3, 'manual')`,
        [tenant.clientId, contact.phoneHash, Buffer.from('enc-placeholder')],
      );
    }

    const snapResult = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(snapResult).toEqual({ kind: 'done', audienceCount: 20 });

    const skippedRows = await pool.query<{ recipient_hash: Buffer; skip_reason: string }>(
      `SELECT recipient_hash, skip_reason FROM campaign_recipients WHERE campaign_id = $1 AND status = 'skipped'`,
      [campaignId],
    );
    expect(skippedRows.rows).toHaveLength(5);
    for (const row of skippedRows.rows) {
      expect(row.skip_reason).toBe('opted_out');
    }
    const skippedHashes = new Set(skippedRows.rows.map((r) => r.recipient_hash.toString('hex')));
    for (const contact of optedOut) {
      expect(skippedHashes.has(contact.phoneHash.toString('hex'))).toBe(true);
    }

    // Move campaign into 'expanding' (already done by completeSnapshot) and
    // run expansion via the SQL path directly to assert no job exists for
    // opted-out recipients - the expansion worker itself is U4's other half,
    // proven fully in expansion.integration.test.ts; here we assert the
    // snapshot's own contract: pending count excludes opted-out rows.
    const pendingCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId],
    );
    expect(pendingCount.rows[0]?.count).toBe('15');
  });

  it('an_audience_over_the_plan_ceiling_fails_loudly_and_truncates_nothing', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds, { maxBroadcastRecipients: 30 });
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);
    for (let i = 0; i < 31; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    await expect(
      runSnapshotBatch({ tenantDb }, { campaignId, clientId: tenant.clientId }),
    ).rejects.toBeInstanceOf(BroadcastLimitError);

    const campaignRow = await pool.query<{ status: string; cancel_reason: string }>(
      `SELECT status, cancel_reason FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(campaignRow.rows[0]?.status).toBe('failed');
    expect(campaignRow.rows[0]?.cancel_reason).toBe('audience_over_plan_limit:31/30');

    const recipientCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipientCount.rows[0]?.count).toBe('0');

    // No-plan client fails closed too.
    const noPlanClientId = tenant.clientId;
    await pool.query('UPDATE clients SET plan_id = NULL WHERE id = $1', [noPlanClientId]);
    const secondCampaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello again!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      secondCampaignId,
      tenant.clientId,
    ]);

    await expect(
      runSnapshotBatch({ tenantDb }, { campaignId: secondCampaignId, clientId: tenant.clientId }),
    ).rejects.toBeInstanceOf(BroadcastLimitError);

    const secondCampaignRow = await pool.query<{ status: string; cancel_reason: string }>(
      `SELECT status, cancel_reason FROM campaigns WHERE id = $1`,
      [secondCampaignId],
    );
    expect(secondCampaignRow.rows[0]?.status).toBe('failed');
    expect(secondCampaignRow.rows[0]?.cancel_reason).toBe('no_plan');
  });

  it('snapshot_resumes_from_its_cursor_after_a_crash', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(pool, probeClientIds, 'Hello!');
    for (let i = 0; i < 2_500; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const realTenantDb = createTenantDb(pool);
    let calls = 0;
    const crashingTenantDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        calls += 1;
        if (calls > 1) {
          throw new Error('simulated crash after first committed batch');
        }
        return realTenantDb.withTenant(clientId, fn);
      },
    };

    await expect(
      runSnapshotToCompletion(
        { tenantDb: crashingTenantDb, batchSize: 1_000 },
        { campaignId, clientId: tenant.clientId },
      ),
    ).rejects.toThrow('simulated crash');

    const afterCrash = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(afterCrash.rows[0]?.count).toBe('1000');

    const result = await runSnapshotToCompletion(
      { tenantDb: realTenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 2_500 });

    const finalCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(finalCount.rows[0]?.count).toBe('2500');

    const countersRow = await pool.query<{ total: number }>(
      `SELECT total FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(countersRow.rows[0]?.total).toBe(2_500);

    const campaignRow = await pool.query<{
      snapshot_cursor_contact_id: string;
      audience_count: number;
    }>(`SELECT snapshot_cursor_contact_id, audience_count FROM campaigns WHERE id = $1`, [
      campaignId,
    ]);
    expect(campaignRow.rows[0]?.audience_count).toBe(2_500);

    const maxContactId = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE client_id = $1 ORDER BY id DESC LIMIT 1`,
      [tenant.clientId],
    );
    expect(campaignRow.rows[0]?.snapshot_cursor_contact_id).toBe(maxContactId.rows[0]?.id);
  });
});
