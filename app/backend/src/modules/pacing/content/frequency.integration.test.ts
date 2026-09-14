import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { evaluateRecipientFrequency } from './recipient-frequency.js';

/**
 * frequency.integration.test.ts (P14 Unit U5, phase step 6, mandatory test
 * 21 + blueprint amendment; P14 Unit U6 extension) - the rolling
 * per-recipient frequency guard against real Postgres, reading limits from
 * a seeded `pacing_profiles` row (proving the profile chain, never
 * hardcoded numbers). U6 extension proves the pipeline-level group/isGroup
 * boundary: a 4th `@g.us` send is never frequency-deferred, but a `@g.us`
 * job with a blocked word still fails.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const TEST_PROFILE_KEY = 'p14-u5-frequency-test-profile';
const PER_RECIPIENT_24H = 3;
const PER_RECIPIENT_7D = 8;

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'recipient-frequency-test',
  });
  await pool.query(
    `INSERT INTO pacing_profiles (key, name, is_system, per_recipient_24h, per_recipient_7d, dup_fanout_warn, dup_fanout_ack)
     VALUES ($1, 'P14 U5 Frequency Test', false, $2, $3, 150, 500)
     ON CONFLICT (key) DO UPDATE SET per_recipient_24h = EXCLUDED.per_recipient_24h, per_recipient_7d = EXCLUDED.per_recipient_7d`,
    [TEST_PROFILE_KEY, PER_RECIPIENT_24H, PER_RECIPIENT_7D],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM pacing_profiles WHERE key = $1', [TEST_PROFILE_KEY]);
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const PHONE_HASH = Buffer.from('recipient-frequency-fixture', 'utf8');

/** Reads the test profile's limits back from Postgres - proves the evaluator's caller resolves the profile chain rather than hardcoding numbers. */
async function readTestProfileLimits(): Promise<{
  perRecipient24h: number;
  perRecipient7d: number;
}> {
  const result = await pool.query<{ per_recipient_24h: number; per_recipient_7d: number }>(
    `SELECT per_recipient_24h, per_recipient_7d FROM pacing_profiles WHERE key = $1`,
    [TEST_PROFILE_KEY],
  );
  const row = result.rows[0];
  if (!row) throw new Error('test profile row missing');
  return { perRecipient24h: row.per_recipient_24h, perRecipient7d: row.per_recipient_7d };
}

async function insertBucket(clientId: string, hourBucket: Date, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, phone_hash, hour_bucket) DO UPDATE SET count = EXCLUDED.count`,
    [clientId, PHONE_HASH, hourBucket, count],
  );
}

describe('recipient-frequency guard (P14 Unit U5, real Postgres)', () => {
  it('per_recipient_frequency_is_enforced_across_instances', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const limits = await readTestProfileLimits();
    const now = new Date('2026-09-02T12:00:00.000Z');

    // 3 sends from 3 DIFFERENT instances of the same client - buckets carry
    // no instance_id, so this fixture proves the guard is enforced per
    // CLIENT, not reset by which instance sent.
    await insertBucket(clientId, new Date('2026-09-02T09:00:00.000Z'), 1);
    await insertBucket(clientId, new Date('2026-09-02T10:00:00.000Z'), 1);
    await insertBucket(clientId, new Date('2026-09-02T11:00:00.000Z'), 1);

    const decision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateRecipientFrequency(tx, {
        clientId,
        phoneHash: PHONE_HASH,
        isGroup: false,
        limits,
        now,
      }),
    );

    // 3 sends already RECORDED in the 24h window = the limit itself - this
    // evaluation is deciding the 4th (pending) send, and the convention is
    // deny at recordedCount >= limit (see the evaluator's own "COUNTING
    // CONVENTION" doc) - so the 4th defers, matching mandatory test 21
    // exactly ("4 sends to one contact from 4 instances -> the 4th
    // defers"). recordedCount(3) - limit(3) + 1 = 1 oldest send must age
    // out; that is the 09:00 bucket, so retryAt = 09:00 + 24h.
    expect(decision).toEqual({
      ok: false,
      reason: 'PER_RECIPIENT_FREQ',
      retryAt: new Date('2026-09-03T09:00:00.000Z'),
    });
  });

  it('frequency_window_is_rolling_and_survives_local_midnight', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const limits = await readTestProfileLimits();
    const now = new Date('2026-09-02T00:30:00.000Z');

    // Two sends RECORDED at 22:00 and 23:00 the previous local day - `now`
    // is 00:30 the next day. Only 2 recorded so far (< limit of 3): no
    // local-midnight reset means both still count toward the window, but
    // the guard is not yet breached - proves the count survives midnight
    // without asserting a denial yet.
    await insertBucket(clientId, new Date('2026-09-01T22:00:00.000Z'), 1);
    await insertBucket(clientId, new Date('2026-09-01T23:00:00.000Z'), 1);

    const decision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateRecipientFrequency(tx, {
        clientId,
        phoneHash: PHONE_HASH,
        isGroup: false,
        limits,
        now,
      }),
    );
    expect(decision).toEqual({ ok: true });

    // A 3rd send is RECORDED at 00:00 the next day, reaching the limit
    // (recordedCount 3 >= limit 3) - re-evaluating now (the 4th pending
    // send) must defer. The exact retryAt is the OLDEST in-window bucket
    // (22:00 the previous day) + 24h - proving the pre-midnight 22:00
    // bucket was counted, not discarded at a midnight boundary.
    await insertBucket(clientId, new Date('2026-09-02T00:00:00.000Z'), 1);
    const decisionAfterThird = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateRecipientFrequency(tx, {
        clientId,
        phoneHash: PHONE_HASH,
        isGroup: false,
        limits,
        now,
      }),
    );
    expect(decisionAfterThird).toEqual({
      ok: false,
      reason: 'PER_RECIPIENT_FREQ',
      retryAt: new Date('2026-09-02T22:00:00.000Z'),
    });
  });

  it('a_bucket_exactly_24h_old_is_out_of_the_24h_window', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const limits = await readTestProfileLimits();
    const now = new Date('2026-09-02T12:00:00.000Z');

    // Exactly 24h before now - documented boundary: OUT of the 24h window
    // (hour_bucket > now - 24h is the in-window predicate; equality is
    // excluded).
    await insertBucket(clientId, new Date('2026-09-01T12:00:00.000Z'), PER_RECIPIENT_24H);

    const decision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateRecipientFrequency(tx, {
        clientId,
        phoneHash: PHONE_HASH,
        isGroup: false,
        limits,
        now,
      }),
    );

    // The 3 sends at exactly -24h are excluded from the 24h window (0 count
    // there) but still land inside the 7d window - both under their
    // respective limits, so ok.
    expect(decision).toEqual({ ok: true });
  });

  it('a_group_job_skips_the_frequency_guard_entirely', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const limits = await readTestProfileLimits();
    const now = new Date('2026-09-02T12:00:00.000Z');

    await insertBucket(clientId, new Date('2026-09-02T11:00:00.000Z'), 999);

    const decision = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateRecipientFrequency(tx, {
        clientId,
        phoneHash: PHONE_HASH,
        isGroup: true,
        limits,
        now,
      }),
    );
    expect(decision).toEqual({ ok: true });
  });
});

// 'a_group_job_skips_the_frequency_guard_but_not_the_content_guards' (P14
// Unit U6 extension, pipeline level) moved to the sibling
// 'frequency-group-pipeline.integration.test.ts' - this file's own
// max-lines cap (same established split idiom as
// 'session-worker-discovery-wiring.ts').
