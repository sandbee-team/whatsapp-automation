import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { UnpricedKeyError } from '../wallet/index.js';
import {
  BroadcastNotFoundError,
  PreflightAudienceOverLimitError,
  PreflightNoPlanError,
  PreflightNotAllowedError,
} from './broadcasts.errors.js';
import { preflightBroadcast } from './preflight.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastCampaign,
  seedBroadcastContact,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import {
  seedPreflightPacingState,
  seedPreflightWallet,
} from './__tests__/preflight-test-support.js';
import { seedFullTenant } from './__tests__/preflight-edge-support.js';

/**
 * preflight-c2.integration.test.ts (P23a test-engineer hardening pass,
 * max-lines split of preflight-edge.integration.test.ts) - ceiling/pricing
 * fail-closed behaviour, status-gated pre-flight, concurrent pre-flights on
 * the same draft, and cross-tenant id lookups.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-preflight-c2-test',
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

describe('preflightBroadcast limit/status/concurrency edge cases (P23a hardening)', () => {
  it('an_empty_audience_quotes_all_zeros_with_no_throw_and_stamps_zero', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const emptyTagId = randomUUID();
    await pool.query(
      `INSERT INTO contact_tags (id, client_id, name) VALUES ($1, $2, 'empty-tag')`,
      [emptyTagId, tenant.clientId],
    );
    const campaignId = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
       VALUES ($1, $2, $3, 'draft', 'empty-audience', $4, $5, 'low')`,
      [
        campaignId,
        tenant.clientId,
        tenant.instanceId,
        JSON.stringify({ kind: 'contacts', tagIds: [emptyTagId], contactIds: [] }),
        JSON.stringify({ kind: 'text', body: 'Hi!' }),
      ],
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(0);
    expect(quote.billable.count).toBe(0);
    expect(quote.billable.quoteMinor).toBe(0);
    expect(quote.estimate.totalDays).toBe(0);

    const stamped = await pool.query<{ quote_minor: string }>(
      `SELECT quote_minor::text AS quote_minor FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(Number(stamped.rows[0]?.quote_minor)).toBe(0);
  });

  it('audience_over_the_plan_ceiling_throws_and_stamps_nothing', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds, 2);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    for (let i = 0; i < 3; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    await expect(
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      ),
    ).rejects.toBeInstanceOf(PreflightAudienceOverLimitError);

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

  it('no_plan_fails_closed_with_a_typed_error_never_a_generic_throw', async () => {
    // seedBroadcastTenant always assigns a plan; strip it to simulate "no plan".
    // P23a C1 fix round unit F2 (MINOR 4): "no plan" is now its own distinct
    // error, never the audience-over-limit shape with a fabricated `limit: 0`.
    const tenant = await seedFullTenant(pool, probeClientIds);
    await pool.query(`UPDATE clients SET plan_id = NULL WHERE id = $1`, [tenant.clientId]);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });

    await expect(
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      ),
    ).rejects.toBeInstanceOf(PreflightNoPlanError);
  });

  it('no_client_pricing_row_fails_closed_with_unpricedkeyerror_never_a_generic_500', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    await seedPreflightPacingState(pool, tenant);
    await seedPreflightWallet(pool, tenant.clientId);
    // Deliberately no seedPreflightPricing call.
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    await seedBroadcastContact(pool, keyProvider, tenant, 0);

    await expect(
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      ),
    ).rejects.toBeInstanceOf(UnpricedKeyError);

    const stamped = await pool.query<{ quote_minor: string | null }>(
      `SELECT quote_minor::text AS quote_minor FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(stamped.rows[0]?.quote_minor).toBeNull();
  });

  it('preflight_on_scheduled_is_allowed_on_running_paused_cancelled_completed_is_rejected', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const scheduledId = await seedBroadcastCampaign(pool, tenant, {
      status: 'scheduled',
      body: 'Hi!',
    });
    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: scheduledId },
    );
    expect(quote.billable.quoteMinor).toBeDefined();

    for (const status of ['running', 'paused', 'cancelled', 'completed']) {
      const campaignId = await seedBroadcastCampaign(pool, tenant, { status, body: 'Hi!' });
      await expect(
        preflightBroadcast(
          { tenantDb, publishWake: () => {} },
          { kind: 'user', userId: 'u1' },
          { clientId: tenant.clientId, id: campaignId },
        ),
      ).rejects.toBeInstanceOf(PreflightNotAllowedError);

      const stamped = await pool.query<{ quote_minor: string | null }>(
        `SELECT quote_minor::text AS quote_minor FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      expect(stamped.rows[0]?.quote_minor).toBeNull();
    }
  });

  it('two_concurrent_preflights_on_the_same_draft_both_succeed_with_identical_quotes_stamped_once', async () => {
    const tenant = await seedFullTenant(pool, probeClientIds);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    for (let i = 0; i < 4; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const [first, second] = await Promise.all([
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      ),
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      ),
    ]);

    expect(first.billable.quoteMinor).toBe(second.billable.quoteMinor);
    expect(first.billable.count).toBe(second.billable.count);

    const stamped = await pool.query<{ quote_minor: string; price_key: string }>(
      `SELECT quote_minor::text AS quote_minor, price_key FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(Number(stamped.rows[0]?.quote_minor)).toBe(first.billable.quoteMinor);
    expect(stamped.rows[0]?.price_key).toBe(first.billable.priceKey);
  });

  it('a_foreign_tenants_id_throws_broadcastnotfounderror_never_403', async () => {
    const tenantA = await seedFullTenant(pool, probeClientIds);
    const tenantB = await seedFullTenant(pool, probeClientIds);
    const campaignB = await seedBroadcastCampaign(pool, tenantB, { status: 'draft', body: 'Hi!' });
    await seedBroadcastContact(pool, keyProvider, tenantB, 0);

    await expect(
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenantA.clientId, id: campaignB },
      ),
    ).rejects.toBeInstanceOf(BroadcastNotFoundError);

    // Tenant A's own audience must be untouched/uncounted by the attempt.
    const tenantARecipients = await pool.query(
      `SELECT id FROM campaign_recipients WHERE client_id = $1`,
      [tenantA.clientId],
    );
    expect(tenantARecipients.rowCount).toBe(0);
  });
});
