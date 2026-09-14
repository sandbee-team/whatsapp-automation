import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { PreflightAudienceOverLimitError, PreflightNoPlanError } from './broadcasts.errors.js';
import { preflightBroadcast } from './preflight.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastCampaign,
  seedBroadcastContact,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { seedFullTenant } from './__tests__/preflight-edge-support.js';

/**
 * preflight-c1fix.integration.test.ts (P23a C1 fix round, unit F2) - MINOR
 * 4: "no plan attached" must throw a distinct `PreflightNoPlanError`, never
 * the audience-over-limit shape with a fabricated `limit: 0`. MINOR 5:
 * `matched` must equal `sendable + skipped` DERIVED from the same audience
 * walk the quote already performs, never a separately-run `countAudience`
 * that can disagree with it under a concurrent write.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-preflight-c1fix-test',
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

describe('preflightBroadcast - C1 fix round (F2)', () => {
  it('a_client_without_a_plan_gets_the_no_plan_error_not_over_limit_zero', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    await pool.query(`UPDATE clients SET plan_id = NULL WHERE id = $1`, [tenant.clientId]);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    let caught: unknown;
    try {
      await preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PreflightNoPlanError);
    expect(caught).not.toBeInstanceOf(PreflightAudienceOverLimitError);

    const stamped = await pool.query<{ quote_minor: string | null }>(
      `SELECT quote_minor::text AS quote_minor FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(stamped.rows[0]?.quote_minor).toBeNull();

    const recipients = await pool.query(
      `SELECT id FROM campaign_recipients WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(recipients.rowCount).toBe(0);
  });

  it('matched_equals_sendable_plus_skipped_from_the_walk', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'draft',
      body: 'Hi {{attrs.city}}!',
    });

    // 4 sendable contacts (attrs.city present).
    for (let i = 0; i < 4; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i, { attrs: { city: 'Pune' } });
    }
    // 1 missing-var contact (no attrs.city).
    const missingVar = await seedBroadcastContact(pool, keyProvider, tenant, 4, { attrs: {} });
    void missingVar;
    // 2 opted-out contacts.
    for (let i = 5; i < 7; i += 1) {
      const contact = await seedBroadcastContact(pool, keyProvider, tenant, i, {
        attrs: { city: 'Pune' },
      });
      await pool.query(
        `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source)
         VALUES (gen_random_uuid(), $1, 'client', $1, $2, $3, 'manual')`,
        [tenant.clientId, contact.phoneHash, Buffer.from('enc-placeholder')],
      );
    }

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(7);
    expect(quote.audience.skipped).toBe(3);
    expect(quote.audience.sendable).toBe(4);
    expect(quote.audience.matched).toBe(quote.audience.sendable + quote.audience.skipped);
  });
});
