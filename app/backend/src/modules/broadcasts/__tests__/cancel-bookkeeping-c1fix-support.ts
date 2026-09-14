import { randomUUID } from 'node:crypto';
import type { SeededBroadcastTenant, TestPool } from './broadcasts-test-support.js';
import { seedBroadcastCampaign } from './broadcasts-test-support.js';

/**
 * cancel-bookkeeping-c1fix-support.ts (P23 C1 fix round, unit F1) - shared,
 * non-test fixture machinery for `cancel-bookkeeping-c1fix.integration.
 * test.ts` / `cancel-bookkeeping-c1fix-edge.integration.test.ts` (max-lines
 * split - no `.test.ts` suffix, same convention as `broadcasts-test-
 * support.ts`).
 */

/** Every ACTUAL `message_jobs` partition's month-start timestamp, by catalog inheritance - not a hardcoded month count (same fix as db/tests/helpers/claim-plan-fixture.ts's own header explains). */
export async function fetchMessageJobsPartitionMonthStarts(pool: TestPool): Promise<Date[]> {
  const result = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_catalog.pg_inherits inh
       JOIN pg_catalog.pg_class c ON c.oid = inh.inhrelid
      WHERE inh.inhparent = 'message_jobs'::regclass
      ORDER BY c.relname`,
  );
  return result.rows.map((row) => {
    const match = /^message_jobs_y(\d{4})m(\d{2})$/.exec(row.relname);
    if (!match) throw new Error(`unexpected message_jobs partition name shape: ${row.relname}`);
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 15));
  });
}

/** Seeds a second `whatsapp_instances` row (+ its lease state) under the same client, purely to hold noise `message_jobs` rows for the index-scan test - never touched by any bookkeeping call. */
export async function seedNoiseInstance(pool: TestPool, clientId: string): Promise<string> {
  const noiseInstanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'broadcast-probe-noise', 'connected', 0)`,
    [noiseInstanceId, clientId],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence)
     VALUES ($1, $2, 1)`,
    [noiseInstanceId, clientId],
  );
  return noiseInstanceId;
}

/** Seeds a cancelled campaign with `pending`/`queued` recipient rows and `queued` message_jobs rows, its counters row, and returns the campaign id. */
export async function seedCancelledCampaign(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  pendingCount: number,
  queuedCount: number,
  queuedJobCount: number,
): Promise<string> {
  const campaignId = await seedBroadcastCampaign(pool, tenant, {
    status: 'cancelled',
    body: 'cancel-bookkeeping c1fix probe',
  });
  await pool.query(
    `INSERT INTO campaign_counters (campaign_id, client_id, total, pending, queued)
     VALUES ($1, $2, $3, $4, $5)`,
    [campaignId, tenant.clientId, pendingCount + queuedCount, pendingCount, queuedCount],
  );
  for (let i = 0; i < pendingCount; i += 1) {
    await pool.query(
      `INSERT INTO campaign_recipients
         (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [
        tenant.clientId,
        campaignId,
        randomUUID(),
        `1500000${String(i).padStart(3, '0')}@s.whatsapp.net-pending-${String(i)}`,
        Buffer.from(`pending-${String(i)}`),
      ],
    );
  }
  for (let i = 0; i < queuedCount; i += 1) {
    await pool.query(
      `INSERT INTO campaign_recipients
         (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [
        tenant.clientId,
        campaignId,
        randomUUID(),
        `1500000${String(i).padStart(3, '0')}@s.whatsapp.net-queued-${String(i)}`,
        Buffer.from(`queued-${String(i)}`),
      ],
    );
  }
  for (let i = 0; i < queuedJobCount; i += 1) {
    await pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, campaign_id, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, send_origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'text', 'low', 1, 'queued', 'campaign')`,
      [
        tenant.clientId,
        tenant.instanceId,
        campaignId,
        `1500000${String(i).padStart(3, '0')}@s.whatsapp.net`,
        `+1500000${String(i).padStart(3, '0')}`,
        JSON.stringify({ kind: 'text', body: 'cancel-bookkeeping c1fix probe job' }),
      ],
    );
  }
  return campaignId;
}
