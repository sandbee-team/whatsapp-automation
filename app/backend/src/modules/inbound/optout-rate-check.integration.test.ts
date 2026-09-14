import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOptoutRateCheck } from './optout-rate-check.js';

/**
 * optout-rate-check.integration.test.ts (P25 observability-and-runbook, Unit
 * U3) - real Postgres. Proves the trailing-24h threshold (opt-outs * 1000 >
 * 10 * acked sends, minimum 100 acked sends), the once-per-UTC-day dedupe,
 * and that the notification payload carries counts only.
 */

type TestPool = ReturnType<typeof createPool>;

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-rate-check-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // `runOptoutRateCheck` -> `notify()` (`db/queries/notify-fanout.sql`)
    // writes a `notifications` row PLUS a per-channel `outbox_events`
    // fan-out row in the SAME statement - deleting only `notifications`
    // leaves unpublished outbox_events rows fleet-wide, poisoning any
    // later-running relay test's whole-table claim/count assertions (same
    // bug class as lesson 2026-09-03 "p17-new-emit-paths-leak-rows-into-
    // whole-table-relay-tests-and-seed-clients").
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedClient(companyName: string): Promise<string> {
  const clientId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    companyName,
    `optout-rate-probe-${clientId}`,
    'active',
  ]);
  probeClientIds.push(clientId);
  return clientId;
}

async function seedInstance(clientId: string): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'optout-rate-probe', 'connected', 0)`,
    [instanceId, clientId],
  );
  return instanceId;
}

async function seedAckedSends(clientId: string, instanceId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at, sent_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'sent', now(), now(), now())`,
      [
        clientId,
        instanceId,
        `15550000${String(i).padStart(3, '0')}@s.whatsapp.net`,
        JSON.stringify({ text: 'hello' }),
      ],
    );
  }
}

async function seedOptOuts(clientId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source)
       VALUES ($1, $2, 'client', $2, $3, $4, 'manual')`,
      [
        randomUUID(),
        clientId,
        Buffer.from(`hash-${clientId}-${i}`),
        Buffer.from('enc-placeholder'),
      ],
    );
  }
}

const FIXED_NOW_MS = Date.parse('2026-06-15T12:00:00.000Z');

describe('the per-client opt-out-rate check - real Postgres', () => {
  it('a_client_above_ten_per_thousand_is_notified_once_per_day', async () => {
    const clientA = await seedClient('Optout Rate Probe Client A');
    const instanceA = await seedInstance(clientA);
    await seedAckedSends(clientA, instanceA, 200);
    await seedOptOuts(clientA, 5); // 5/200 = 25 per 1000, above the 10/1000 threshold

    const clientB = await seedClient('Optout Rate Probe Client B');
    const instanceB = await seedInstance(clientB);
    await seedAckedSends(clientB, instanceB, 200);
    await seedOptOuts(clientB, 1); // 1/200 = 5 per 1000, below the threshold

    const firstRun = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });
    expect(firstRun.notified).toBe(1);

    const notifRows = await pool.query<{ kind: string; client_id: string }>(
      `SELECT kind, client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[clientA, clientB]],
    );
    expect(notifRows.rows).toHaveLength(1);
    expect(notifRows.rows[0]?.client_id).toBe(clientA);

    const secondRun = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });
    expect(secondRun.notified).toBe(0);
  });

  it('a_small_sample_is_never_flagged', async () => {
    const clientC = await seedClient('Optout Rate Probe Client C');
    const instanceC = await seedInstance(clientC);
    await seedAckedSends(clientC, instanceC, 50);
    await seedOptOuts(clientC, 5); // below OPTOUT_RATE_MIN_SENDS (100)

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });
    expect(result.notified).toBe(0);

    const notifRows = await pool.query(
      `SELECT 1 FROM notifications WHERE client_id = $1 AND kind = 'optout_rate_high'`,
      [clientC],
    );
    expect(notifRows.rows).toHaveLength(0);
  });

  it('the_notification_payload_carries_counts_only', async () => {
    const clientD = await seedClient('Optout Rate Probe Client D');
    const instanceD = await seedInstance(clientD);
    await seedAckedSends(clientD, instanceD, 150);
    await seedOptOuts(clientD, 4); // 4/150 ~ 26.6 per 1000, above threshold

    await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });

    const notifRows = await pool.query<{
      payload: { acked_sends: number; optouts: number; per_thousand: number };
    }>(`SELECT payload FROM notifications WHERE client_id = $1 AND kind = 'optout_rate_high'`, [
      clientD,
    ]);
    expect(notifRows.rows).toHaveLength(1);
    const payload = notifRows.rows[0]?.payload;
    expect(payload && Object.keys(payload).sort()).toEqual([
      'acked_sends',
      'optouts',
      'per_thousand',
    ]);
  });

  it('the_limit_bounds_the_flagged_set_by_rate_not_by_client_id', async () => {
    // Three flagged clients at distinct rates (all >= 100 acked sends):
    // 50/1000, 30/1000, 15/1000. With maxClientsPerRun=2 only the two
    // highest-rate clients (50 and 30 per 1000) are notified in the first
    // run; a second run at the same limit picks up the third (dedupe keeps
    // the first two from re-notifying).
    const clientHigh = await seedClient('Optout Rate Probe Limit High');
    const instanceHigh = await seedInstance(clientHigh);
    await seedAckedSends(clientHigh, instanceHigh, 200);
    await seedOptOuts(clientHigh, 10); // 10/200 = 50 per 1000

    const clientMid = await seedClient('Optout Rate Probe Limit Mid');
    const instanceMid = await seedInstance(clientMid);
    await seedAckedSends(clientMid, instanceMid, 200);
    await seedOptOuts(clientMid, 6); // 6/200 = 30 per 1000

    const clientLow = await seedClient('Optout Rate Probe Limit Low');
    const instanceLow = await seedInstance(clientLow);
    await seedAckedSends(clientLow, instanceLow, 200);
    await seedOptOuts(clientLow, 3); // 3/200 = 15 per 1000

    const firstRun = await runOptoutRateCheck({
      pool,
      tenantDb,
      nowMs: FIXED_NOW_MS,
      maxClientsPerRun: 2,
    });
    expect(firstRun.notified).toBe(2);

    const firstNotifRows = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[clientHigh, clientMid, clientLow]],
    );
    expect(firstNotifRows.rows.map((r) => r.client_id).sort()).toEqual(
      [clientHigh, clientMid].sort(),
    );

    const secondRun = await runOptoutRateCheck({
      pool,
      tenantDb,
      nowMs: FIXED_NOW_MS,
      maxClientsPerRun: 2,
    });
    expect(secondRun.notified).toBe(1);

    const secondNotifRows = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[clientHigh, clientMid, clientLow]],
    );
    expect(secondNotifRows.rows.map((r) => r.client_id).sort()).toEqual(
      [clientHigh, clientMid, clientLow].sort(),
    );
  });
});
