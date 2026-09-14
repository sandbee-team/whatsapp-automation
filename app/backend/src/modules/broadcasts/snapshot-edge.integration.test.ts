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
 * snapshot-edge.integration.test.ts (P23 test-engineer hardening pass) -
 * edge cases NOT covered by snapshot.integration.test.ts / snapshot-missing-
 * var.integration.test.ts:
 *   - the exact ceiling boundary (N == limit allowed, N == limit + 1 fails).
 *   - a zero-contact audience completes cleanly with audience_count 0.
 *   - a 2,000-character body freezes and snapshots without truncation.
 *   - a crash injected AFTER the recipient INSERT commits but BEFORE the
 *     cursor UPDATE would run proves the whole batch is one transaction -
 *     a re-run must never double-insert (ON CONFLICT DO NOTHING) and the
 *     cursor must reflect only what actually committed.
 *   - two tenants using the IDENTICAL tag id value never leak into each
 *     other's snapshot (tag ids are client-scoped, not globally unique
 *     otherwise, so this proves scoping, not just id inequality).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-snapshot-edge-test',
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

describe('broadcast snapshot edge cases', () => {
  it('an_audience_exactly_at_the_ceiling_is_allowed', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds, { maxBroadcastRecipients: 10 });
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);
    for (let i = 0; i < 10; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const result = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 10 });

    const campaignRow = await pool.query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(campaignRow.rows[0]?.status).toBe('expanding');
  });

  it('an_audience_one_over_the_ceiling_fails_at_exactly_limit_plus_one', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds, { maxBroadcastRecipients: 10 });
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'snapshotting',
      body: 'Hello!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignId,
      tenant.clientId,
    ]);
    for (let i = 0; i < 11; i += 1) {
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
    expect(campaignRow.rows[0]?.cancel_reason).toBe('audience_over_plan_limit:11/10');

    const recipientCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipientCount.rows[0]?.count).toBe('0');
  });

  it('a_zero_contact_audience_completes_immediately_with_audience_count_zero', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(pool, probeClientIds, 'Hello!');
    // No contacts seeded at all - the tag matches nothing.

    const result = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 0 });

    const campaignRow = await pool.query<{ status: string; audience_count: number }>(
      `SELECT status, audience_count FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(campaignRow.rows[0]?.status).toBe('expanding');
    expect(campaignRow.rows[0]?.audience_count).toBe(0);

    const countersRow = await pool.query<{ total: number }>(
      `SELECT total FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(countersRow.rows[0]?.total).toBe(0);
  });

  it('a_2000_character_body_snapshots_and_freezes_without_truncation', async () => {
    const prefix = 'Hi {{first_name}}! ';
    const longBody = `${prefix}${'x'.repeat(2_000 - prefix.length)}`;
    expect(longBody.length).toBe(2_000);
    const { tenant, campaignId } = await seedSnapshottingCampaign(pool, probeClientIds, longBody);
    await seedBroadcastContact(pool, keyProvider, tenant, 0, { firstName: 'Priya' });

    const result = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 1 });

    const messageRow = await pool.query<{ message: { body: string } }>(
      `SELECT message FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(messageRow.rows[0]?.message.body.length).toBe(2_000);

    const varsRow = await pool.query<{ vars: { first_name: string } }>(
      `SELECT vars FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(varsRow.rows[0]?.vars.first_name).toBe('Priya');
  });

  it('the_recipient_insert_and_the_cursor_update_commit_or_roll_back_together', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(pool, probeClientIds, 'Hello!');
    for (let i = 0; i < 50; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const realTenantDb = createTenantDb(pool);
    // Simulate "crash after the recipient rows would have been written but
    // before the cursor UPDATE runs" by throwing from within the SAME
    // transaction, right after the batch's insert query executes - this
    // proves the insert and the cursor/counter updates are one atomic unit:
    // if the transaction never commits, NEITHER write is visible.
    let insertSeen = false;
    const crashingTenantDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        return realTenantDb.withTenant(clientId, (tx) =>
          fn({
            query: (async (sql: string, params?: unknown[]) => {
              const result = await tx.query(sql, params);
              if (/^\s*INSERT INTO campaign_recipients\b/i.test(sql)) {
                insertSeen = true;
                throw new Error('simulated crash immediately after the recipient insert');
              }
              return result;
            }) as TenantQueryable['query'],
          }),
        );
      },
    };

    await expect(
      runSnapshotBatch({ tenantDb: crashingTenantDb }, { campaignId, clientId: tenant.clientId }),
    ).rejects.toThrow('simulated crash immediately after the recipient insert');
    expect(insertSeen).toBe(true);

    // Nothing committed: zero recipient rows, cursor still NULL.
    const afterCrash = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(afterCrash.rows[0]?.count).toBe('0');
    const cursorRow = await pool.query<{ snapshot_cursor_contact_id: string | null }>(
      `SELECT snapshot_cursor_contact_id FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(cursorRow.rows[0]?.snapshot_cursor_contact_id).toBeNull();

    // A clean re-run now inserts the full batch exactly once.
    const result = await runSnapshotToCompletion(
      { tenantDb: realTenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 50 });
  });

  it('two_tenants_using_an_identical_tag_name_never_leak_into_each_others_snapshot', async () => {
    // `contact_tags.id` is a global uuid PK (cannot literally collide across
    // tenants), but `UNIQUE (client_id, name)` explicitly ALLOWS two
    // different tenants to each own a tag named identically - the realistic
    // "identical value" collision. Rename both tenants' seeded tags to the
    // SAME name and prove the join (`ctl.client_id = c.client_id`) still
    // scopes by client_id, never by the tag's name or a shared audience
    // shape.
    const tenantA = await seedBroadcastTenant(pool, probeClientIds);
    const tenantB = await seedBroadcastTenant(pool, probeClientIds);
    await pool.query(`UPDATE contact_tags SET name = 'vip' WHERE id = ANY($1)`, [
      [tenantA.tagId, tenantB.tagId],
    ]);

    for (let i = 0; i < 5; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenantA, i);
    }
    for (let i = 100; i < 103; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenantB, i);
    }

    const campaignA = await seedBroadcastCampaign(pool, tenantA, {
      status: 'snapshotting',
      body: 'Hi!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignA,
      tenantA.clientId,
    ]);
    const campaignB = await seedBroadcastCampaign(pool, tenantB, {
      status: 'snapshotting',
      body: 'Hi!',
    });
    await pool.query('INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)', [
      campaignB,
      tenantB.clientId,
    ]);

    const resultA = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId: campaignA, clientId: tenantA.clientId },
    );
    const resultB = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId: campaignB, clientId: tenantB.clientId },
    );

    expect(resultA).toEqual({ kind: 'done', audienceCount: 5 });
    expect(resultB).toEqual({ kind: 'done', audienceCount: 3 });

    const crossCheck = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1 AND client_id != $2`,
      [campaignA, tenantA.clientId],
    );
    expect(crossCheck.rows[0]?.count).toBe('0');
  });
});
