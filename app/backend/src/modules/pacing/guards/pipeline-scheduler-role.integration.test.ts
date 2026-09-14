import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../../platform/db/test-support/wp-app-role.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { recordOptOut, type OptOutMirrorPort } from '../optout/registry.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });
import { evaluateDuplicateFanout } from '../content/fingerprint.js';

/**
 * pipeline-scheduler-role.integration.test.ts (Finding 4, P14 review-fix
 * F2) - the role-fidelity gap that let CRITICALs 1-3 ship green: every
 * other guard-pipeline integration test in this suite runs against the raw
 * dev-pool superuser connection (`rolbypassrls = true`), which is BLIND to
 * a column-privilege gap the real `wp_scheduler` role hits in production
 * (see migration 0040's own header - four statements failed outright under
 * `wp_scheduler` before that migration, and nothing in this suite would
 * have caught it). `createTenantDbAsRole(pool, 'wp_scheduler')` (the
 * established idiom - see `send-loop-worker-wiring.rls.integration.test.ts`)
 * runs every write below under the REAL production role, with RLS FORCE'd,
 * exactly as `roles/session-worker.ts` connects in production.
 *
 * Four passes, matching the task's own list exactly:
 *   (a) claim -> guards -> terminal-dispose (an opted-out job).
 *   (b) claim -> guards -> defer (a frequency-breached job).
 *   (c) one `resolveAck`-shaped bucket upsert (`recipient_send_buckets`,
 *       the ON CONFLICT DO UPDATE migration 0040 Part 3 grants).
 *   (d) one duplicate-fanout evaluation crossing the
 *       `content_fingerprint_recipients` INSERT (migration 0040 Part 1).
 *
 * Each of these fails with a column-privilege error WITHOUT migration 0040 -
 * that is the point (this file exists to make a future REVOKE/regression
 * fail loudly here, under the role that actually matters, instead of only
 * ever failing quietly in production).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'guard-pipeline-scheduler-role-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
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

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

async function seedGuardJob(options: {
  clientId: string;
  instanceId: string;
  recipientHash?: Buffer | null;
  body?: string;
}): Promise<{ id: string }> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      recipientJid,
      options.recipientHash ?? null,
      JSON.stringify({ text: options.body ?? 'Thanks for your order, see you soon!' }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedGuardJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, options.clientId, options.instanceId, row.id, row.created_at],
  );
  return { id: row.id };
}

async function jobStatus(
  id: string,
): Promise<{ status: string; pacing_deny_reason: string | null }> {
  const result = await pool.query<{ status: string; pacing_deny_reason: string | null }>(
    `SELECT status, pacing_deny_reason FROM message_jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`jobStatus: no message_jobs row with id ${id}`);
  return row;
}

describe('guard pipeline under the real wp_scheduler role (Finding 4, P14 review-fix F2)', () => {
  it('a_claim_guards_terminal_dispose_pass_succeeds_under_wp_scheduler', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('scheduler-role-optout-hash');
    const tenantDbSuperuser = createTenantDb(pool);
    await tenantDbSuperuser.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'manual',
        },
        { mirror: noopMirror },
      ),
    );
    const job = await seedGuardJob({ clientId, instanceId, recipientHash: phoneHash });

    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');
    const claimFn = claimAndReserve({
      tenantDb: tenantDbAsScheduler,
      rng: { random: () => 0.5 },
      clock: claimClock,
    });
    const result = await claimFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'scheduler-role-worker', claimExpiryMs: 90_000 },
    );
    expect(result).toBeUndefined();

    const row = await jobStatus(job.id);
    expect(row.status).toBe('cancelled');
    expect(row.pacing_deny_reason).toBe('OPT_OUT');
  });

  it('a_claim_guards_defer_pass_succeeds_under_wp_scheduler', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('scheduler-role-frequency-hash');
    // safe_default's per_recipient_24h is 3 (migration 0040 seed
    // correction) - three prior buckets already at the limit.
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, $3, 1)`,
        [clientId, phoneHash, new Date(claimClock.now() - (i + 1) * 60 * 60 * 1000)],
      );
    }
    const job = await seedGuardJob({ clientId, instanceId, recipientHash: phoneHash });

    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');
    const claimFn = claimAndReserve({
      tenantDb: tenantDbAsScheduler,
      rng: { random: () => 0.5 },
      clock: claimClock,
    });
    const result = await claimFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'scheduler-role-worker', claimExpiryMs: 90_000 },
    );
    expect(result).toBeUndefined();

    const row = await jobStatus(job.id);
    expect(row.status).toBe('queued');
    expect(row.pacing_deny_reason).toBe('PER_RECIPIENT_FREQ');
  });

  it('a_recipient_send_buckets_upsert_succeeds_under_wp_scheduler', async () => {
    // Migration 0040 Part 3 - the resolveAck bucket upsert
    // (ON CONFLICT (client_id, phone_hash, hour_bucket) DO UPDATE SET
    // count = recipient_send_buckets.count + 1), reproduced directly here
    // (the same statement shape result.ts#resolveAck runs) rather than
    // driving a full dispatch+resolveAck round trip, which is already
    // covered end-to-end (under the superuser pool) elsewhere.
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('scheduler-role-bucket-hash');
    const hourBucket = new Date(claimClock.now());

    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');
    await tenantDbAsScheduler.withTenant(clientId, (tx) =>
      tx.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (client_id, phone_hash, hour_bucket)
         DO UPDATE SET count = recipient_send_buckets.count + 1
         -- client_id = $1`,
        [clientId, phoneHash, hourBucket],
      ),
    );

    const row = await pool.query<{ count: number }>(
      `SELECT count FROM recipient_send_buckets WHERE client_id = $1 AND phone_hash = $2 AND hour_bucket = $3`,
      [clientId, phoneHash, hourBucket],
    );
    expect(row.rows[0]?.count).toBe(1);
  });

  it('a_duplicate_fanout_evaluation_crossing_the_recipient_insert_succeeds_under_wp_scheduler', async () => {
    // Migration 0040 Part 1 - the content_fingerprint_recipients/
    // content_fingerprints ON CONFLICT arbiter SELECT grants.
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const fingerprint = Buffer.from('scheduler-role-fingerprint-hash');
    const recipientHash = Buffer.from('scheduler-role-fanout-recipient');
    const localDate = '2026-09-02';

    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');
    const decision = await tenantDbAsScheduler.withTenant(clientId, (tx) =>
      evaluateDuplicateFanout(tx, {
        clientId,
        localDate,
        fingerprint,
        recipientHash,
        warnAt: 150,
        ackAt: 500,
        now: new Date(claimClock.now()),
      }),
    );
    expect(decision.ok).toBe(true);

    const recipientRow = await pool.query(
      `SELECT 1 FROM content_fingerprint_recipients
        WHERE client_id = $1 AND local_date = $2 AND fingerprint = $3 AND recipient_hash = $4`,
      [clientId, localDate, fingerprint, recipientHash],
    );
    expect(recipientRow.rowCount).toBe(1);
  });
});
