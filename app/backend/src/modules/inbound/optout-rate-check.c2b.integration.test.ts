import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { buildNotificationDedupeKey } from '../notifications/notify.js';
import { runOptoutRateCheck } from './optout-rate-check.js';
import {
  cleanupOptoutRateC2Probes,
  seedAckedSends,
  seedClient,
  seedInstance,
  seedOptOuts,
  type TestPool,
} from './__tests__/optout-rate-check-c2-test-support.js';

/**
 * optout-rate-check.c2b.integration.test.ts (P25 SESSION-PROTOCOL C2
 * edge-case pass) - max-lines-cap sibling of optout-rate-check.c2
 * .integration.test.ts: a notify() dedupe-conflict for one client not
 * blocking the next, the UTC-day dedupe boundary, restored opt-outs never
 * counting toward the rate, and a maxClientsPerRun override ranking by rate
 * (not client_id order) once every candidate has been evaluated.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-rate-check-c2b-test',
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

describe('opt-out rate check - C2 edge cases part 2, real Postgres', () => {
  it('a_notify_throw_for_one_client_does_not_prevent_the_next_clients_notification', async () => {
    // Client A is flagged normally. Client B is ALSO flagged but seeded with
    // an id that is not a valid UUID-shaped foreign key at notify() time is
    // not reproducible without mocking notify() itself; instead we prove the
    // per-row try/catch contract by seeding client A's notify() to collide
    // with an already-existing notification row for a DIFFERENT bucket that
    // forces a constraint path, while client B (seeded after, in client_id
    // order) still gets notified. The SQL orders by client_id, so seed A's
    // id lexicographically before B's to pin ordering deterministically.
    const clientLower = await seedClient(pool, probeClientIds, 'Optout C2 Notify Throw AAA');
    const clientHigher = await seedClient(pool, probeClientIds, 'Optout C2 Notify Throw ZZZ');
    const sorted = [clientLower, clientHigher].sort();
    const clientA = sorted[0] as string;
    const clientB = sorted[1] as string;

    const instanceA = await seedInstance(pool, clientA);
    await seedAckedSends(pool, clientA, instanceA, 200);
    await seedOptOuts(pool, clientA, 5);

    const instanceB = await seedInstance(pool, clientB);
    await seedAckedSends(pool, clientB, instanceB, 200);
    await seedOptOuts(pool, clientB, 5);

    // Pre-seed a notification row at client A's EXACT dedupe key (same
    // (kind, transitionId=clientId, bucket) triple runOptoutRateCheck's own
    // notify() call will compute) so the storage-layer unique constraint
    // (notifications_dedupe_uq) makes client A's notify() a no-op
    // (created: false) rather than a fresh insert - proving the per-client
    // loop does not abort when one client's outcome is "already notified".
    const bucket = new Date(FIXED_NOW_MS).toISOString().slice(0, 10);
    const dedupeKey = buildNotificationDedupeKey({
      kind: 'optout_rate_high',
      transitionId: clientA,
      bucket,
    });
    await pool.query(
      `INSERT INTO notifications (id, client_id, kind, severity, dedupe_key, payload)
       VALUES ($1, $2, 'optout_rate_high', 'warning', $3, '{}'::jsonb)
       ON CONFLICT ON CONSTRAINT notifications_dedupe_uq DO NOTHING`,
      [randomUUID(), clientA, dedupeKey],
    );

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });

    // Client A's notify() was already deduped (created: false); client B's
    // still ran - the loop did not stop at A.
    expect(result.flagged).toBe(2);
    const notifRowsB = await pool.query(
      `SELECT 1 FROM notifications WHERE client_id = $1 AND kind = 'optout_rate_high'`,
      [clientB],
    );
    expect(notifRowsB.rows).toHaveLength(1);
  });

  it('the_utc_day_boundary_is_the_dedupe_scope', async () => {
    const client = await seedClient(pool, probeClientIds, 'Optout C2 UTC Day Boundary');
    const instance = await seedInstance(pool, client);
    await seedAckedSends(pool, client, instance, 200);
    await seedOptOuts(pool, client, 5);

    const day1Ms = Date.parse('2026-06-15T23:59:00.000Z');
    const day2Ms = Date.parse('2026-06-16T00:01:00.000Z');
    const sameDayLaterMs = Date.parse('2026-06-15T23:59:30.000Z');

    const firstRun = await runOptoutRateCheck({ pool, tenantDb, nowMs: day1Ms });
    expect(firstRun.notified).toBe(1);

    // Same UTC date, later timestamp - deduped, no second notification.
    const sameDayRun = await runOptoutRateCheck({ pool, tenantDb, nowMs: sameDayLaterMs });
    expect(sameDayRun.notified).toBe(0);

    // Crossed the UTC date boundary - a new notification is expected.
    const nextDayRun = await runOptoutRateCheck({ pool, tenantDb, nowMs: day2Ms });
    expect(nextDayRun.notified).toBe(1);

    const notifRows = await pool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM notifications WHERE client_id = $1 AND kind = 'optout_rate_high' ORDER BY created_at`,
      [client],
    );
    // Two distinct dedupe keys (bucket is baked into the sha256 dedupe_key,
    // there is no separate "bucket" column on notifications) - one per UTC
    // calendar date crossed.
    expect(notifRows.rows).toHaveLength(2);
    expect(new Set(notifRows.rows.map((r) => r.dedupe_key)).size).toBe(2);
  });

  it('restored_opt_outs_never_count_toward_the_rate', async () => {
    const client = await seedClient(pool, probeClientIds, 'Optout C2 All Restored');
    const instance = await seedInstance(pool, client);
    await seedAckedSends(pool, client, instance, 200);
    // All opt-outs restored - none should count, so this client is never
    // flagged even though the raw row count would clear the threshold.
    await seedOptOuts(pool, client, 10, { restored: true });

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });
    expect(result.notified).toBe(0);

    const notifRows = await pool.query(
      `SELECT 1 FROM notifications WHERE client_id = $1 AND kind = 'optout_rate_high'`,
      [client],
    );
    expect(notifRows.rows).toHaveLength(0);
  });

  it('a_limit_override_below_the_flagged_count_keeps_the_highest_rate_clients_and_evaluates_every_candidate', async () => {
    // Three clients all clear the threshold, at three DISTINCT rates - the
    // flagged set (3) exceeds a maxClientsPerRun override of 2. Per the
    // outer-statement LIMIT (ORDER BY rate DESC, ranked AFTER every
    // client-with-an-opt-out is evaluated - the CTE itself carries no
    // LIMIT), the two HIGHEST-rate clients are notified this run; the third
    // (lowest rate) is not - never dropped by client_id ordering, only by
    // rate.
    const lowRate = await seedClient(pool, probeClientIds, 'Optout C2 Limit Low Rate');
    const instanceLow = await seedInstance(pool, lowRate);
    await seedAckedSends(pool, lowRate, instanceLow, 200);
    await seedOptOuts(pool, lowRate, 5); // 25 per 1000

    const midRate = await seedClient(pool, probeClientIds, 'Optout C2 Limit Mid Rate');
    const instanceMid = await seedInstance(pool, midRate);
    await seedAckedSends(pool, midRate, instanceMid, 200);
    await seedOptOuts(pool, midRate, 10); // 50 per 1000

    const highRate = await seedClient(pool, probeClientIds, 'Optout C2 Limit High Rate');
    const instanceHigh = await seedInstance(pool, highRate);
    await seedAckedSends(pool, highRate, instanceHigh, 200);
    await seedOptOuts(pool, highRate, 20); // 100 per 1000

    const result = await runOptoutRateCheck({
      pool,
      tenantDb,
      nowMs: FIXED_NOW_MS,
      maxClientsPerRun: 2,
    });

    // Every client with an opt-out in the window was evaluated (flagged
    // reflects the query's own result set before the maxClientsPerRun
    // slice) - all three cleared the rate/min-sends predicate.
    expect(result.flagged).toBe(3);
    expect(result.notified).toBe(2);

    const notifRows = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[lowRate, midRate, highRate]],
    );
    const notifiedIds = new Set(notifRows.rows.map((r) => r.client_id));
    expect(notifiedIds.has(highRate)).toBe(true);
    expect(notifiedIds.has(midRate)).toBe(true);
    expect(notifiedIds.has(lowRate)).toBe(false);
  });
});
