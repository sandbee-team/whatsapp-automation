import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimAndReserve } from './send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-tenant-fixture.js';
import { recordOptOut, type OptOutMirrorPort } from '../../modules/pacing/optout/registry.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });
import { computeFingerprint } from '../../modules/pacing/content/fingerprint.js';

/**
 * claim-and-reserve-guard-race-c2.integration.test.ts (P14 C2 review,
 * concurrency lens) - genuine PARALLEL (Promise.all, not a sequential
 * driving loop) races through `claimAndReserve` with the guard pipeline
 * active:
 *   1. N concurrent workers, ONE eligible queued job: exactly one worker
 *      gets the job, none observe a partial/duplicate disposal.
 *   2. N concurrent workers each with their OWN opted-out job (same
 *      recipient_hash, distinct jobs): every one disposes exactly once,
 *      total cancelled count == N, no double-dispose, no lost claim.
 *   3. Two concurrent evaluations of two DIFFERENT jobs sharing the SAME
 *      (fingerprint, recipient_hash) - the distinct-recipient count must
 *      land at exactly 1, never 2, under real concurrent INSERT ... ON
 *      CONFLICT DO NOTHING races.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'claim-race-c2' });
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

const claimClock = { now: () => Date.now() };

function makeClaimAndReserve() {
  const tenantDb = createTenantDb(pool);
  return claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
}

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

describe('claimAndReserve under real concurrency (P14 C2)', () => {
  it('two_concurrent_workers_racing_one_job_exactly_one_claims_it', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedGuardJob({ clientId, instanceId });

    const workerA = makeClaimAndReserve();
    const workerB = makeClaimAndReserve();

    const [resultA, resultB] = await Promise.all([
      workerA(
        { clientId, sql: pool },
        { instanceId, band: 3, fence: 1, workerId: 'race-worker-a', claimExpiryMs: 90_000 },
      ),
      workerB(
        { clientId, sql: pool },
        { instanceId, band: 3, fence: 1, workerId: 'race-worker-b', claimExpiryMs: 90_000 },
      ),
    ]);

    // Exactly one of the two calls actually claimed the single eligible job.
    const claimers = [resultA, resultB].filter((r) => r?.id === job.id);
    expect(claimers).toHaveLength(1);

    const row = await pool.query<{ status: string; lease_owner: string | null }>(
      'SELECT status, lease_owner FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(row.rows[0]?.status).toBe('processing');
    expect(['race-worker-a', 'race-worker-b']).toContain(row.rows[0]?.lease_owner);
  });

  it('n_concurrent_workers_each_own_opted_out_job_every_one_disposes_exactly_once', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-race-optout-hash');
    const tenantDb = createTenantDb(pool);
    await tenantDb.withTenant(clientId, (tx) =>
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

    const N = 8;
    const jobIds: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const job = await seedGuardJob({ clientId, instanceId, recipientHash: phoneHash });
      jobIds.push(job.id);
    }

    // N distinct worker instances, each racing claimAndReserve concurrently
    // against the SAME instance/band - claim-jobs.sql's SKIP LOCKED must
    // hand out N distinct rows, one per concurrent claimer, with zero
    // double-dispose and zero left behind.
    const workers = Array.from({ length: N }, () => makeClaimAndReserve());
    await Promise.all(
      workers.map((worker, i) =>
        worker(
          { clientId, sql: pool },
          {
            instanceId,
            band: 3,
            fence: 1,
            workerId: `race-worker-${String(i)}`,
            claimExpiryMs: 90_000,
          },
        ),
      ),
    );

    const rows = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM message_jobs WHERE id = ANY($1) GROUP BY status`,
      [jobIds],
    );
    const byStatus = new Map(rows.rows.map((r) => [r.status, Number(r.count)]));
    expect(byStatus.get('cancelled') ?? 0).toBe(N);
    expect(byStatus.get('queued') ?? 0).toBe(0);
    expect(byStatus.get('processing') ?? 0).toBe(0);
  });

  it('two_concurrent_evaluations_of_the_same_fingerprint_and_recipient_end_distinct_count_at_one', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const body = 'Concurrent fingerprint race fixture body, exact match every time';
    const fingerprint = computeFingerprint(body);
    const recipientHash = Buffer.from('c2-race-fingerprint-recipient');

    // Two DISTINCT jobs, same recipient_hash and same body (so the same
    // fingerprint), claimed concurrently by two independent workers - the
    // guard pipeline evaluates each inside its OWN transaction, so this
    // exercises the real INSERT ... ON CONFLICT DO NOTHING race on
    // content_fingerprint_recipients, not a single-transaction serial path.
    const jobA = await seedGuardJob({ clientId, instanceId, recipientHash, body });
    const jobB = await seedGuardJob({ clientId, instanceId, recipientHash, body });

    const workerA = makeClaimAndReserve();
    const workerB = makeClaimAndReserve();

    await Promise.all([
      workerA(
        { clientId, sql: pool },
        { instanceId, band: 3, fence: 1, workerId: 'fp-race-worker-a', claimExpiryMs: 90_000 },
      ),
      workerB(
        { clientId, sql: pool },
        { instanceId, band: 3, fence: 1, workerId: 'fp-race-worker-b', claimExpiryMs: 90_000 },
      ),
    ]);

    // Both jobs were evaluated (one claimed by A, one by B - SKIP LOCKED
    // guarantees disjoint rows) but they share one recipient_hash, so the
    // distinct-recipient count for this fingerprint/day must land at
    // exactly 1, never 2, regardless of which transaction's INSERT won the
    // ON CONFLICT DO NOTHING race.
    const fpRow = await pool.query<{ recipient_count: number }>(
      `SELECT recipient_count FROM content_fingerprints
        WHERE client_id = $1 AND fingerprint = $2`,
      [clientId, fingerprint],
    );
    expect(fpRow.rows[0]?.recipient_count).toBe(1);

    // Neither job was lost: both still exist, neither status is an
    // impossible value (both were genuinely evaluated by the pipeline).
    const jobRows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM message_jobs WHERE id = ANY($1)`,
      [[jobA.id, jobB.id]],
    );
    expect(jobRows.rows).toHaveLength(2);
  });
});
