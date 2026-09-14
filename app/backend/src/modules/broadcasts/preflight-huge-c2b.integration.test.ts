import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { preflightBroadcast } from './preflight.service.js';
import {
  cleanupBroadcastProbeClients,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import { seedFullTenant } from './__tests__/preflight-edge-support.js';

/**
 * preflight-huge-c2b.integration.test.ts (P23a C2b hardening pass) - a
 * 20,000-id `contactIds` audience (the plan ceiling's exact boundary,
 * `seedFullTenant(..., 20_000)`): `matched`/`billable` are exact, the walk
 * touches no frequency buckets (no deferrals possible with none seeded), the
 * quote is stamped exactly once, and pre-flight NEVER writes
 * `campaign_recipients` rows (that is the expansion worker's job, a later
 * phase of the SAME campaign's lifecycle - pre-flight is read-only over the
 * audience).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-preflight-huge-c2b-test',
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

describe('preflightBroadcast huge-audience edge case (P23a C2b)', () => {
  it('a_20000_contact_ids_audience_matches_billable_and_quotes_exactly_and_writes_no_recipient_rows', async () => {
    const AUDIENCE_SIZE = 20_000;
    const tenant = await seedFullTenant(pool, probeClientIds, AUDIENCE_SIZE);

    // Set-based seed (never a per-row loop at this scale): generate_series
    // drives both the phone_e164 uniqueness and the phone_hash distinctness;
    // the hash need not be HMAC-correct for this test (nothing here reads
    // opt_outs/recipient_send_buckets against it), only DISTINCT per row so
    // COUNT(DISTINCT ...) downstream is exact.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, source)
       SELECT $1,
              '+1' || lpad((9000000000 + n)::text, 10, '0'),
              decode(lpad(to_hex(n), 64, '0'), 'hex'),
              lpad((9000000000 + n)::text, 10, '0') || '@s.whatsapp.net',
              'manual'
         FROM generate_series(1, $2) AS n
       RETURNING id`,
      [tenant.clientId, AUDIENCE_SIZE],
    );
    expect(inserted.rowCount).toBe(AUDIENCE_SIZE);
    const contactIds = inserted.rows.map((r) => r.id);

    const campaignId = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message, priority)
       VALUES ($1, $2, $3, 'draft', 'huge-audience probe', $4, $5, 'low')`,
      [
        campaignId,
        tenant.clientId,
        tenant.instanceId,
        JSON.stringify({ kind: 'contacts', tagIds: [], contactIds }),
        JSON.stringify({ kind: 'text', body: 'Hi there!' }),
      ],
    );

    const quote = await preflightBroadcast(
      { tenantDb, publishWake: () => {} },
      { kind: 'user', userId: 'u1' },
      { clientId: tenant.clientId, id: campaignId },
    );

    expect(quote.audience.matched).toBe(AUDIENCE_SIZE);
    expect(quote.audience.skipped).toBe(0);
    expect(quote.audience.sendable).toBe(AUDIENCE_SIZE);
    expect(quote.alreadyMessaged.deferred).toBe(0);
    expect(quote.billable.count).toBe(AUDIENCE_SIZE);
    expect(quote.billable.quoteMinor).toBe(AUDIENCE_SIZE * quote.billable.rateMinor);
    expect(quote.fanOut.requiresHumanAck).toBe(true);

    const stamped = await pool.query<{ quote_minor: string | null }>(
      `SELECT quote_minor::text AS quote_minor FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(Number(stamped.rows[0]?.quote_minor)).toBe(quote.billable.quoteMinor);

    // Pre-flight never writes campaign_recipients rows - that is the
    // expansion worker's job, a later phase entirely.
    const recipients = await pool.query(
      `SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 LIMIT 1`,
      [campaignId],
    );
    expect(recipients.rowCount).toBe(0);
  }, 60_000);
});
