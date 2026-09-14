import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runSnapshotToCompletion } from './snapshot.worker.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastContact,
  seedSnapshottingCampaign,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';

/**
 * snapshot-missing-var.integration.test.ts (P23 Unit U4, step 4) - sibling
 * of `snapshot.integration.test.ts` (max-lines cap split): a missing
 * template variable is skipped at snapshot time, never rendered empty at
 * send time.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-snapshot-missing-var-test',
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

describe('broadcast snapshot worker (Phase A) - missing variable', () => {
  it('a_missing_variable_is_skipped_at_snapshot_time', async () => {
    const { tenant, campaignId } = await seedSnapshottingCampaign(
      pool,
      probeClientIds,
      'City: {{attrs.city}}',
    );

    for (let i = 0; i < 5; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i, { attrs: { city: 'Mumbai' } });
    }
    for (let i = 5; i < 8; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i, { attrs: {} });
    }

    const result = await runSnapshotToCompletion(
      { tenantDb, batchSize: 1_000 },
      { campaignId, clientId: tenant.clientId },
    );
    expect(result).toEqual({ kind: 'done', audienceCount: 8 });

    const skipped = await pool.query<{ skip_reason: string }>(
      `SELECT skip_reason FROM campaign_recipients WHERE campaign_id = $1 AND status = 'skipped'`,
      [campaignId],
    );
    expect(skipped.rows).toHaveLength(3);
    for (const row of skipped.rows) {
      expect(row.skip_reason).toBe('missing_var:attrs.city');
    }

    const pending = await pool.query<{ vars: { 'attrs.city': string } }>(
      `SELECT vars FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId],
    );
    expect(pending.rows).toHaveLength(5);
    for (const row of pending.rows) {
      expect(row.vars['attrs.city']).toBe('Mumbai');
    }
  });
});
