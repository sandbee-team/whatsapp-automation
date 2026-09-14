import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOptoutRateCheck, OPTOUT_RATE_MIN_SENDS } from './optout-rate-check.js';
import {
  cleanupOptoutRateC2Probes,
  seedAckedSends,
  seedClient,
  seedInstance,
  seedOptOuts,
  type TestPool,
} from './__tests__/optout-rate-check-c2-test-support.js';

/**
 * optout-rate-check.c2.integration.test.ts (P25 SESSION-PROTOCOL C2
 * edge-case pass) - hunt items not already in optout-rate-check.integration
 * .test.ts: the strict `>` boundary at exactly 10/1,000 and the exact
 * `OPTOUT_RATE_MIN_SENDS` boundary. The remaining C2 hunt items (notify
 * throw resilience, UTC-day dedupe boundary, restored opt-outs, and the
 * limit-override/rate-ranking case) live in the max-lines-cap sibling
 * optout-rate-check.c2b.integration.test.ts.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-rate-check-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupOptoutRateC2Probes(pool, probeClientIds);
  probeClientIds = [];
});

const FIXED_NOW_MS = Date.parse('2026-06-15T12:00:00.000Z');

describe('opt-out rate check - C2 edge cases, real Postgres', () => {
  it('exactly_ten_per_thousand_is_not_flagged_eleven_is', async () => {
    const exactlyTen = await seedClient(pool, probeClientIds, 'Optout C2 Exactly Ten');
    const instanceExactlyTen = await seedInstance(pool, exactlyTen);
    await seedAckedSends(pool, exactlyTen, instanceExactlyTen, 1000);
    await seedOptOuts(pool, exactlyTen, 10); // 10/1000 = 10 per 1000, NOT > 10 (strict >)

    const elevenPerK = await seedClient(pool, probeClientIds, 'Optout C2 Eleven Per K');
    const instanceEleven = await seedInstance(pool, elevenPerK);
    await seedAckedSends(pool, elevenPerK, instanceEleven, 1000);
    await seedOptOuts(pool, elevenPerK, 11); // 11/1000 = 11 per 1000, > 10

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });

    const notifRows = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[exactlyTen, elevenPerK]],
    );
    expect(notifRows.rows.map((r) => r.client_id)).toEqual([elevenPerK]);
    expect(result.notified).toBe(1);
  });

  it('exactly_min_sends_counts_ninety_nine_does_not', async () => {
    const exactlyMin = await seedClient(pool, probeClientIds, 'Optout C2 Exactly Min Sends');
    const instanceExactMin = await seedInstance(pool, exactlyMin);
    expect(OPTOUT_RATE_MIN_SENDS).toBe(100);
    await seedAckedSends(pool, exactlyMin, instanceExactMin, OPTOUT_RATE_MIN_SENDS);
    await seedOptOuts(pool, exactlyMin, 20); // 20/100 = 200 per 1000, well above threshold

    const belowMin = await seedClient(pool, probeClientIds, 'Optout C2 Below Min Sends');
    const instanceBelowMin = await seedInstance(pool, belowMin);
    await seedAckedSends(pool, belowMin, instanceBelowMin, OPTOUT_RATE_MIN_SENDS - 1);
    await seedOptOuts(pool, belowMin, 20); // same rate, but sample too small

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });

    const notifRows = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[exactlyMin, belowMin]],
    );
    expect(notifRows.rows.map((r) => r.client_id)).toEqual([exactlyMin]);
    expect(result.notified).toBe(1);
  });

  it('two_clients_over_threshold_in_one_run_each_get_their_own_notification', async () => {
    const clientA = await seedClient(pool, probeClientIds, 'Optout C2 Two Flagged A');
    const instanceA = await seedInstance(pool, clientA);
    await seedAckedSends(pool, clientA, instanceA, 200);
    await seedOptOuts(pool, clientA, 5);

    const clientB = await seedClient(pool, probeClientIds, 'Optout C2 Two Flagged B');
    const instanceB = await seedInstance(pool, clientB);
    await seedAckedSends(pool, clientB, instanceB, 200);
    await seedOptOuts(pool, clientB, 6);

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });
    expect(result.notified).toBe(2);

    const notifRows = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high' ORDER BY client_id`,
      [[clientA, clientB]],
    );
    expect(notifRows.rows.map((r) => r.client_id).sort()).toEqual([clientA, clientB].sort());
  });
});
