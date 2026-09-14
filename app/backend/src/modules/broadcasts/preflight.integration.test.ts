import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { BROADCAST_FREQUENCY_NOTE } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { PreflightNotAllowedError } from './broadcasts.errors.js';
import { preflightBroadcast } from './preflight.service.js';
import {
  buildBroadcastsKeyProvider,
  cleanupBroadcastProbeClients,
  seedBroadcastCampaign,
  seedBroadcastContact,
  seedBroadcastTenant,
  type SeededBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import {
  seedPreflightPacingState,
  seedPreflightPricing,
  seedPreflightSecondInstance,
  seedPreflightWallet,
} from './__tests__/preflight-test-support.js';
import { randomUUID } from 'node:crypto';

/**
 * preflight.integration.test.ts (P23a Unit U1a, step 2) - real-Postgres
 * proofs for the pre-flight quote: client-level frequency deferrals (and
 * that a second instance of the SAME client never raises the per-recipient
 * limit), the client's resolved integer-paise rate + the conditional quote
 * stamp, a tier-1 account's 250-day estimate with no invented "faster"
 * option, and the CONFLICT rejection on a non-draft/scheduled campaign.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-preflight-test',
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

async function seedFullTenant(maxBroadcastRecipients?: number): Promise<SeededBroadcastTenant> {
  const tenant = await seedBroadcastTenant(pool, probeClientIds, { maxBroadcastRecipients });
  await seedPreflightPacingState(pool, tenant);
  await seedPreflightPricing(pool, tenant.clientId);
  await seedPreflightWallet(pool, tenant.clientId);
  return tenant;
}

describe('preflightBroadcast (P23a Unit U1a)', () => {
  it('preflight_counts_client_level_frequency_deferrals', async () => {
    const tenant = await seedFullTenant();
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    const per24h = await pool.query<{ per_recipient_24h: number }>(
      `SELECT p.per_recipient_24h AS per_recipient_24h
         FROM instance_pacing_state s JOIN pacing_profiles p ON p.key = s.profile_key
        WHERE s.instance_id = $1 AND s.client_id = $2`,
      [tenant.instanceId, tenant.clientId],
    );
    const limit = per24h.rows[0]!.per_recipient_24h;

    const contacts = [];
    for (let i = 0; i < 5; i += 1) {
      contacts.push(await seedBroadcastContact(pool, keyProvider, tenant, i));
    }

    // Deny at >= per_recipient_24h (see the .sql file's own header) - a
    // single bucket row carrying exactly the limit's count breaches it.
    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, date_trunc('hour', now()), $3)`,
        [tenant.clientId, contacts[i]!.phoneHash, limit],
      );
    }

    // A bucket for a THIRD contact's hash under ANOTHER probe client must NOT count.
    const otherTenant = await seedFullTenant();
    const otherContact = await seedBroadcastContact(pool, keyProvider, otherTenant, 0, {
      tagged: false,
    });
    await pool.query(
      `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
       VALUES ($1, $2, date_trunc('hour', now()), $3)`,
      [otherTenant.clientId, contacts[2]!.phoneHash, limit],
    );
    void otherContact;

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(5);
    expect(quote.audience.sendable).toBe(5);
    expect(quote.alreadyMessaged.deferred).toBe(2);
    expect(quote.billable.count).toBe(3);
  });

  it('the_same_audience_on_a_second_instance_does_not_raise_the_per_recipient_limit', async () => {
    const tenant = await seedFullTenant();
    const secondInstanceId = randomUUID();
    await seedPreflightSecondInstance(pool, tenant, secondInstanceId);
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    const secondCampaignId = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
       VALUES ($1, $2, $3, 'draft', 'second', $4, $5, 'low') RETURNING id`,
      [
        randomUUID(),
        tenant.clientId,
        secondInstanceId,
        JSON.stringify({ kind: 'contacts', tagIds: [tenant.tagId], contactIds: [] }),
        JSON.stringify({ kind: 'text', body: 'Hi!' }),
      ],
    );

    const per24h = await pool.query<{ per_recipient_24h: number }>(
      `SELECT p.per_recipient_24h AS per_recipient_24h
         FROM instance_pacing_state s JOIN pacing_profiles p ON p.key = s.profile_key
        WHERE s.instance_id = $1 AND s.client_id = $2`,
      [tenant.instanceId, tenant.clientId],
    );
    const limit = per24h.rows[0]!.per_recipient_24h;

    const contacts = [];
    for (let i = 0; i < 5; i += 1) {
      contacts.push(await seedBroadcastContact(pool, keyProvider, tenant, i));
    }
    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, date_trunc('hour', now()), $3)`,
        [tenant.clientId, contacts[i]!.phoneHash, limit],
      );
    }

    const firstQuote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );
    expect(firstQuote.alreadyMessaged.deferred).toBe(2);
    expect(firstQuote.alreadyMessaged.note).toBe(BROADCAST_FREQUENCY_NOTE);

    const secondQuote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: secondCampaignId.rows[0]!.id },
    );
    expect(secondQuote.alreadyMessaged.deferred).toBe(2);
  });

  it('the_quote_uses_integer_paise_and_the_clients_resolved_rate', async () => {
    const tenant = await seedFullTenant();
    await pool.query(
      `UPDATE client_pricing SET override_items = '{"text": 37}'::jsonb WHERE client_id = $1`,
      [tenant.clientId],
    );
    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    for (let i = 0; i < 3; i += 1) {
      await seedBroadcastContact(pool, keyProvider, tenant, i);
    }

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.billable.rateMinor).toBe(37);
    expect(quote.billable.quoteMinor).toBe(quote.billable.count * 37);
    expect(Number.isInteger(quote.billable.quoteMinor)).toBe(true);
    expect(Number.isInteger(quote.billable.rateMinor)).toBe(true);
    expect(Number.isInteger(quote.wallet.balanceMinor)).toBe(true);
    expect(Number.isInteger(quote.wallet.afterMinor)).toBe(true);

    const stamped = await pool.query<{ quote_minor: string; price_key: string }>(
      `SELECT quote_minor::text AS quote_minor, price_key FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(Number(stamped.rows[0]?.quote_minor)).toBe(quote.billable.quoteMinor);
    expect(stamped.rows[0]?.price_key).toBe('text');

    const secondTenant = await seedFullTenant();
    const secondCampaignId = await seedBroadcastCampaign(pool, secondTenant, {
      status: 'draft',
      body: 'Hi!',
    });
    for (let i = 0; i < 3; i += 1) {
      await seedBroadcastContact(pool, keyProvider, secondTenant, i);
    }
    const secondQuote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: secondTenant.clientId, id: secondCampaignId },
    );
    expect(secondQuote.billable.rateMinor).toBe(15);
  });

  it('a_tier_1_account_gets_a_250_day_estimate_and_no_faster_option', async () => {
    const tenant = await seedFullTenant(10_000);
    await pool.query(
      `UPDATE instance_pacing_state SET warmup_tier = 1, eff_daily_cap = 20 WHERE instance_id = $1 AND client_id = $2`,
      [tenant.instanceId, tenant.clientId],
    );
    const profile = await pool.query<{ dup_fanout_ack: number }>(
      `SELECT p.dup_fanout_ack AS dup_fanout_ack
         FROM instance_pacing_state s JOIN pacing_profiles p ON p.key = s.profile_key
        WHERE s.instance_id = $1 AND s.client_id = $2`,
      [tenant.instanceId, tenant.clientId],
    );
    const ackThreshold = profile.rows[0]!.dup_fanout_ack;

    const campaignId = await seedBroadcastCampaign(pool, tenant, { status: 'draft', body: 'Hi!' });
    await pool.query(
      `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, first_name, attrs, source)
       SELECT gen_random_uuid(), $1,
              '+1' || lpad((6000000 + g)::text, 10, '0'),
              digest('+1' || lpad((6000000 + g)::text, 10, '0'), 'sha256'),
              lpad((6000000 + g)::text, 10, '0') || '@s.whatsapp.net',
              'Bulk', '{}'::jsonb, 'manual'
         FROM generate_series(1, 5000) AS g`,
      [tenant.clientId],
    );
    await pool.query(
      `INSERT INTO contact_tag_links (client_id, tag_id, contact_id)
       SELECT $1, $2, id FROM contacts WHERE client_id = $1`,
      [tenant.clientId, tenant.tagId],
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.estimate.totalDays).toBe(250);
    expect(quote.estimate.options).toEqual(['reduce_audience', 'wait_for_warm_up']);
    expect(JSON.stringify(quote)).not.toMatch(/faster/i);
    expect(JSON.stringify(quote)).not.toMatch(/boost/i);
    expect(quote.fanOut.requiresHumanAck).toBe(true);
    expect(quote.fanOut.ackThreshold).toBe(ackThreshold);
  });

  it('preflight_on_a_started_broadcast_is_rejected', async () => {
    const tenant = await seedFullTenant();
    const campaignId = await seedBroadcastCampaign(pool, tenant, {
      status: 'running',
      body: 'Hi!',
    });

    await expect(
      preflightBroadcast(
        { tenantDb, publishWake: () => {} },
        { kind: 'user', userId: 'u1' },
        { clientId: tenant.clientId, id: campaignId },
      ),
    ).rejects.toBeInstanceOf(PreflightNotAllowedError);

    const row = await pool.query<{ quote_minor: string | null }>(
      `SELECT quote_minor::text AS quote_minor FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(row.rows[0]?.quote_minor).toBeNull();
  });
});
