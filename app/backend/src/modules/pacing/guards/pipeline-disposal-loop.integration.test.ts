import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { recordOptOut, type OptOutMirrorPort } from '../optout/registry.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });

/**
 * pipeline-disposal-loop.integration.test.ts (P14 Unit U6, phase step 7) -
 * split out of `pipeline.integration.test.ts` purely for that file's own
 * max-lines cap (same established split idiom as
 * `session-worker-discovery-wiring.ts`). The two mandatory cases here are
 * both about the DISPOSAL LOOP itself (`claimAndReserve`'s own claim-again-
 * up-to-25 mechanism): the exact per-pass cap, and the "no observer ever
 * sees 'processing'" invariant for a job that only ever defers.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'guard-pipeline-disposal-loop-test',
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

function makeClaimAndReserve() {
  const tenantDb = createTenantDb(pool);
  return claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
}

interface SeedGuardJobOptions {
  clientId: string;
  instanceId: string;
  recipientHash?: Buffer | null;
  body?: string;
}

async function seedGuardJob(pool: TestPool, options: SeedGuardJobOptions): Promise<{ id: string }> {
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

async function jobRow(id: string) {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM message_jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`jobRow: no message_jobs row with id ${id}`);
  return row;
}

describe('claimAndReserve disposal loop (P14 Unit U6, real Postgres)', () => {
  it('a_terminal_guard_disposes_up_to_twenty_five_jobs_in_one_pass', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('pipeline-25-cap-hash');
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

    for (let i = 0; i < 1000; i += 1) {
      await seedGuardJob(pool, { clientId, instanceId, recipientHash: phoneHash });
    }

    const claimAndReserveFn = makeClaimAndReserve();
    const onePass = await claimAndReserveFn(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'guard-pipeline-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(onePass).toBeUndefined();

    const afterFirstPass = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND instance_id = $2 GROUP BY status`,
      [clientId, instanceId],
    );
    const cancelledAfterFirst = afterFirstPass.rows.find((r) => r.status === 'cancelled');
    expect(cancelledAfterFirst?.count).toBe('25');
    const queuedAfterFirst = afterFirstPass.rows.find((r) => r.status === 'queued');
    expect(queuedAfterFirst?.count).toBe('975');

    await claimAndReserveFn(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'guard-pipeline-test-worker',
        claimExpiryMs: 90_000,
      },
    );

    const afterSecondPass = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM message_jobs
        WHERE client_id = $1 AND instance_id = $2 GROUP BY status`,
      [clientId, instanceId],
    );
    expect(afterSecondPass.rows.find((r) => r.status === 'cancelled')?.count).toBe('50');
    expect(afterSecondPass.rows.find((r) => r.status === 'queued')?.count).toBe('950');
    expect(afterSecondPass.rows.find((r) => r.status === 'failed')).toBeUndefined();
  });

  it('a_deferred_job_settles_back_to_queued_every_pass_never_left_processing', async () => {
    // MINOR 12 FIX (P14 review-fix F2): this test formerly polled
    // message_jobs on a 2ms setInterval racing 20 real claim passes,
    // sampling for a 'processing' status an external observer might catch
    // mid-transaction - a sampled race outcome the ABSOLUTE RULE forbids
    // (a slow CI box could make the poll miss the window even with a real
    // bug present, and a fast box burns cycles proving nothing new). The
    // STRUCTURAL invariant that made the sampled poll pass in the first
    // place - claimOne and deferJob provably share the identical `tx`
    // handle `tenantDb.withTenant` opens, so no external connection can
    // ever observe the intermediate 'processing' state before COMMIT - is
    // now proved directly, without sampling, in the sibling unit test
    // `send-loop-pacing-claim.test.ts`. This integration test instead
    // asserts the OBSERVABLE end state after each real pass: the job is
    // back to 'queued' (never left 'processing') every single time, using
    // three prior buckets (safe_default's per_recipient_24h is 3 as of
    // migration 0040's seed correction) to guarantee every pass denies.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('pipeline-observer-hash');
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, $3, 1)`,
        [clientId, phoneHash, new Date(claimClock.now() - (i + 1) * 60 * 60 * 1000)],
      );
    }
    const job = await seedGuardJob(pool, { clientId, instanceId, recipientHash: phoneHash });

    const claimAndReserveFn = makeClaimAndReserve();
    for (let i = 0; i < 20; i += 1) {
      await pool.query('UPDATE message_jobs SET next_attempt_at = now() WHERE id = $1', [job.id]);
      const result = await claimAndReserveFn(
        { clientId, sql: pool },
        {
          instanceId,
          band: 3,
          fence: 1,
          workerId: 'guard-pipeline-observer-worker',
          claimExpiryMs: 90_000,
        },
      );
      expect(result).toBeUndefined();
      const row = await jobRow(job.id);
      expect(row.status).toBe('queued');
    }
  });
});
