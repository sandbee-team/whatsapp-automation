import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { cancelOptOutJobs } from './registry.js';

/**
 * cancel-optout-jobs-edge.integration.test.ts (P14 E3 edge pass) - two
 * `cancel-optout-jobs.sql` edges not covered by `registry.integration.
 * test.ts`: zero matching jobs is a clean no-op (never an error, `RETURNING`
 * empty), and a job already claimed into `status='processing'` is NEVER
 * cancelled by this statement - only `status='queued'` rows match the WHERE
 * clause (`cancel-optout-jobs.sql`'s own contract).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'cancel-optout-jobs-edge-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedJobWithStatus(
  testPool: TestPool,
  options: {
    clientId: string;
    instanceId: string;
    recipientHash: Buffer;
    status: 'queued' | 'processing';
  },
): Promise<string> {
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const isProcessing = options.status === 'processing';
  // Column names mirror `queue-send-test-helpers.ts#seedClaimedJob` (the
  // established precedent for seeding an already-'processing' row directly
  // via INSERT - never an UPDATE, which `check-single-claim.ts` forbids
  // outside `claim-jobs.sql`): lease_owner/lease_id/owner_fence/leased_at/
  // lease_expires_at, not claimed_by/claimed_at. Branched in JS (not a SQL
  // CASE WHEN keyed off the same bound parameter) because Postgres cannot
  // deduce a single type for one parameter reused across text/uuid/int/
  // timestamp CASE branches ("inconsistent types deduced for parameter").
  const result = isProcessing
    ? await testPool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
            payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
            attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at)
         VALUES ($1, $2, 0, $3, '+15550009999', $4, $5, 'text', 'normal', 3, 'processing', now(),
                 now(), 0, 5, 'edge-test-worker', gen_random_uuid(), 1, now(),
                 now() + interval '60 seconds')
         RETURNING id`,
        [
          options.clientId,
          options.instanceId,
          recipientJid,
          options.recipientHash,
          JSON.stringify({ text: 'hello' }),
        ],
      )
    : await testPool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
            payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
            attempts, max_attempts)
         VALUES ($1, $2, 0, $3, '+15550009999', $4, $5, 'text', 'normal', 3, 'queued', now(),
                 now(), 0, 5)
         RETURNING id`,
        [
          options.clientId,
          options.instanceId,
          recipientJid,
          options.recipientHash,
          JSON.stringify({ text: 'hello' }),
        ],
      );
  const row = result.rows[0];
  if (!row) throw new Error('seedJobWithStatus: no row returned');
  return row.id;
}

describe('cancelOptOutJobs edge cases (P14 E3, real Postgres)', () => {
  it('zero_matching_jobs_is_a_clean_no_op', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const phoneHash = Buffer.from('cancel-edge-no-match-fixture');

    const cancelled = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' }),
    );
    expect(cancelled).toEqual([]);
  });

  it('a_processing_job_is_not_cancelled_only_queued_rows_match', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const phoneHash = Buffer.from('cancel-edge-processing-fixture');

    const processingJobId = await seedJobWithStatus(pool, {
      clientId,
      instanceId,
      recipientHash: phoneHash,
      status: 'processing',
    });
    const queuedJobId = await seedJobWithStatus(pool, {
      clientId,
      instanceId,
      recipientHash: phoneHash,
      status: 'queued',
    });

    const cancelled = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' }),
    );
    expect(cancelled).toEqual([queuedJobId]);

    const rows = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM message_jobs WHERE id = ANY($1)',
      [[processingJobId, queuedJobId]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(byId.get(processingJobId)).toBe('processing');
    expect(byId.get(queuedJobId)).toBe('cancelled');
  });
});
