import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { computeFingerprint } from '../content/fingerprint.js';
import { ackFanout } from './ack-fanout.js';

/**
 * ack-fanout.integration.test.ts (P14 Unit U7, step 8) - the duplicate
 * fan-out ack surface against real Postgres. Mandatory case: acking a
 * fingerprint sets ack_by/ack_at, resets EVERY held NEEDS_HUMAN_ACK job's
 * next_attempt_at across MULTIPLE instances sharing that fingerprint, and
 * publishes exactly one wake per affected instance - completing mandatory
 * test 19 (`fingerprint.integration.test.ts`'s own
 * `duplicate_fanout_holds_not_fails` proved the hold; this proves the ack
 * releases it).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'ack-fanout-test' });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedSecondInstance(clientId: string): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'ack-fanout-probe-2', 'connected', 0)`,
    [instanceId, clientId],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, clientId, 1],
  );
  return instanceId;
}

async function seedHeldJob(
  clientId: string,
  instanceId: string,
  fingerprint: Buffer,
): Promise<string> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation, content_fingerprint, pacing_deny_reason)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(),
             now() + interval '300 seconds', 0, 5, false, $6, 'NEEDS_HUMAN_ACK')
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      recipientJid,
      Buffer.from(`ack-fanout-recipient-${randomUUID()}`),
      JSON.stringify({ text: 'Big sale today, everything 50% off!' }),
      fingerprint,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedHeldJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  return row.id;
}

describe('ackFanout (P14 Unit U7, real Postgres)', () => {
  it('ack_publishes_a_wake_for_every_affected_instance', async () => {
    const { clientId, instanceId: instanceA } = await seedSendTenant(pool, probeClientIds);
    const instanceB = await seedSecondInstance(clientId);
    const localDate = '2026-09-02';
    const fingerprint = computeFingerprint('Big sale today, everything 50% off!');

    await pool.query(
      `INSERT INTO content_fingerprints (client_id, local_date, fingerprint, recipient_count)
       VALUES ($1, $2, $3, 600)`,
      [clientId, localDate, fingerprint],
    );

    const jobA = await seedHeldJob(clientId, instanceA, fingerprint);
    const jobB = await seedHeldJob(clientId, instanceB, fingerprint);

    const publishedWakes: { clientId: string; instanceId: string }[] = [];
    const actorUserId = randomUUID();

    const result = await ackFanout(
      {
        tenantDb,
        publishWake: async (c, i) => void publishedWakes.push({ clientId: c, instanceId: i }),
      },
      { clientId, actorUserId, localDate, fingerprint },
    );

    expect(result.acked).toBe(true);

    const fpRow = await pool.query<{ ack_by: string; ack_at: Date }>(
      `SELECT ack_by, ack_at FROM content_fingerprints WHERE client_id = $1 AND local_date = $2 AND fingerprint = $3`,
      [clientId, localDate, fingerprint],
    );
    expect(fpRow.rows[0]?.ack_by).toBe(actorUserId);
    expect(fpRow.rows[0]?.ack_at).toBeTruthy();

    const jobRows = await pool.query<{ id: string; next_attempt_at: Date }>(
      `SELECT id, next_attempt_at FROM message_jobs WHERE id = ANY($1)`,
      [[jobA, jobB]],
    );
    const now = Date.now();
    for (const row of jobRows.rows) {
      expect(now - row.next_attempt_at.getTime()).toBeLessThan(5000);
    }

    expect(publishedWakes).toHaveLength(2);
    const instanceIds = publishedWakes.map((w) => w.instanceId).sort();
    expect(instanceIds).toEqual([instanceA, instanceB].sort());

    const auditRows = await pool.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM audit_logs WHERE client_id = $1 AND action = 'pacing.fanout_ack'`,
      [clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    const metadata = auditRows.rows[0]?.metadata as { reason: string };
    expect(metadata.reason).toContain(localDate);
    expect(metadata.reason).toContain('600');
  });

  it('acking_an_already_acked_fingerprint_is_idempotent_success', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const localDate = '2026-09-02';
    const fingerprint = computeFingerprint('Repeat ack fixture body');
    await pool.query(
      `INSERT INTO content_fingerprints (client_id, local_date, fingerprint, recipient_count)
       VALUES ($1, $2, $3, 10)`,
      [clientId, localDate, fingerprint],
    );
    await seedHeldJob(clientId, instanceId, fingerprint);

    const wakes: { clientId: string; instanceId: string }[] = [];
    const deps = {
      tenantDb,
      publishWake: async (c: string, i: string) => void wakes.push({ clientId: c, instanceId: i }),
    };

    const first = await ackFanout(deps, {
      clientId,
      actorUserId: randomUUID(),
      localDate,
      fingerprint,
    });
    expect(first.acked).toBe(true);

    const second = await ackFanout(deps, {
      clientId,
      actorUserId: randomUUID(),
      localDate,
      fingerprint,
    });
    // Idempotent success, not an error - 0 rows updated the second time.
    expect(second.acked).toBe(true);

    // MINOR 10 (P14 review-fix F2): the repeat/no-op ack still writes an
    // audit row, but under a DISTINCT action so an auditor can tell a
    // replay from the real ack - never the same 'pacing.fanout_ack' action
    // for both.
    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 ORDER BY created_at ASC`,
      [clientId],
    );
    expect(auditRows.rows.map((row) => row.action)).toEqual([
      'pacing.fanout_ack',
      'pacing.fanout_ack.noop',
    ]);
  });
});
