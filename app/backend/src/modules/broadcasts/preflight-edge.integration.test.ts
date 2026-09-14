import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { preflightBroadcast } from './preflight.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastCampaign,
  seedBroadcastContact,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { insertBucket, readLimits, seedFullTenant } from './__tests__/preflight-edge-support.js';

/**
 * preflight-edge.integration.test.ts (P23a test-engineer hardening pass) -
 * frequency-deferral and audience-matching edge cases over
 * `preflightBroadcast`: tenant isolation of the client-level buckets, exact
 * boundary values at the 24h/7d deny-at->= limits, skip precedence
 * (opted-out wins over a missing var), and DISTINCT matched counting.
 * Limit/status/concurrency edge cases live in the max-lines sibling
 * `preflight-c2.integration.test.ts`.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-preflight-edge-test',
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

describe('preflightBroadcast frequency/audience edge cases (P23a hardening)', () => {
  it('two_tenants_share_a_phone_hash_but_tenant_a_buckets_never_defer_tenant_bs_recipient', async () => {
    const tenantA = await seedFullTenant(pool, probeClientIds);
    const tenantB = await seedFullTenant(pool, probeClientIds);
    const limits = await readLimits(pool, tenantA);

    const contactB = await seedBroadcastContact(pool, keyProvider, tenantB, 0);
    // Same phone_hash bytes recorded under tenant A's buckets, at the
    // tenant A deny threshold.
    await insertBucket(pool, tenantA.clientId, contactB.phoneHash, limits.perRecipient24h);

    const campaignB = await seedBroadcastCampaign(pool, tenantB, { status: 'draft', body: 'Hi!' });
    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenantB.clientId, id: campaignB },
    );

    expect(quote.audience.matched).toBe(1);
    expect(quote.alreadyMessaged.deferred).toBe(0);
    expect(quote.billable.count).toBe(1);
  });

  it('a_bucket_at_exactly_limit_minus_one_is_not_deferred_and_at_the_limit_is', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const limits = await readLimits(pool, tenant);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    const belowLimit = await seedBroadcastContact(pool, keyProvider, tenant, 0);
    const atLimit = await seedBroadcastContact(pool, keyProvider, tenant, 1);
    await insertBucket(pool, tenant.clientId, belowLimit.phoneHash, limits.perRecipient24h - 1);
    await insertBucket(pool, tenant.clientId, atLimit.phoneHash, limits.perRecipient24h);

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(2);
    expect(quote.alreadyMessaged.deferred).toBe(1);
    expect(quote.billable.count).toBe(1);
  });

  it('under_24h_limit_but_at_7d_limit_is_deferred_and_a_bucket_older_than_7d_counts_for_nothing', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const limits = await readLimits(pool, tenant);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    // Contact 1: spread across multiple hours within the 7d window, well
    // under the 24h limit per-bucket, but summing to exactly the 7d limit.
    const contact7d = await seedBroadcastContact(pool, keyProvider, tenant, 0);
    const perBucket = 1;
    let remaining = limits.perRecipient7d;
    let hoursAgo = 30; // outside the 24h window, inside the 7d window
    while (remaining > 0) {
      const thisCount = Math.min(perBucket, remaining);
      await insertBucket(pool, tenant.clientId, contact7d.phoneHash, thisCount, hoursAgo);
      remaining -= thisCount;
      hoursAgo += 1;
    }

    // Contact 2: a bucket older than 7 days at a huge count - must not count at all.
    const contactOld = await seedBroadcastContact(pool, keyProvider, tenant, 1);
    await insertBucket(
      pool,
      tenant.clientId,
      contactOld.phoneHash,
      limits.perRecipient7d * 10,
      24 * 8,
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(2);
    expect(quote.alreadyMessaged.deferred).toBe(1);
    expect(quote.billable.count).toBe(1);
  });

  it('a_contact_both_opted_out_and_missing_a_variable_is_counted_once_as_opted_out', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'draft',
      body: 'Hi {{attrs.city}}!',
    });
    const contact = await seedBroadcastContact(pool, keyProvider, tenant, 0, { attrs: {} });
    await pool.query(
      `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source)
       VALUES (gen_random_uuid(), $1, 'client', $1, $2, $3, 'manual')`,
      [tenant.clientId, contact.phoneHash, Buffer.from('enc-placeholder')],
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(1);
    expect(quote.audience.skipped).toBe(1);
    expect(quote.audience.skipReasons).toEqual([{ reason: 'opted_out', count: 1 }]);
    expect(quote.audience.sendable).toBe(0);
    expect(quote.billable.count).toBe(0);
  });

  it('a_contact_matched_by_a_tag_and_listed_in_contact_ids_is_counted_once', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const contact = await seedBroadcastContact(pool, keyProvider, tenant, 0);
    const campaignId = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
       VALUES ($1, $2, $3, 'draft', 'dup-match', $4, $5, 'low')`,
      [
        campaignId,
        tenant.clientId,
        tenant.instanceId,
        JSON.stringify({
          kind: 'contacts',
          tagIds: [tenant.tagId],
          contactIds: [contact.contactId],
        }),
        JSON.stringify({ kind: 'text', body: 'Hi!' }),
      ],
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(1);
    expect(quote.billable.count).toBe(1);
  });
});
