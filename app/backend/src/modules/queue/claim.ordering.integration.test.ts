import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from './index.js';
import {
  DEFAULT_CLAIM_INPUT,
  cleanupProbeClients,
  ctxFor,
  getJobWithLease,
  seedJob,
  seedTenantEdgeProbe,
  type TestPool,
} from './__tests__/claim-test-helpers.js';

/**
 * claim.ordering.integration.test.ts (P03 close, split from
 * `claim.edge-cases.integration.test.ts` for file-size, protocol C2) -
 * boundary and ordering probes for `claimOne` / `db/queries/claim-jobs.sql`:
 * a band with no matching priority_rank, zero-job instances, the exact
 * `next_attempt_at <= now()` clock edge, a 20-job retry-storm drain order
 * (strict next_attempt_at-then-id, no skips/duplicates), the id tiebreak
 * when next_attempt_at ties, session_epoch mismatch (instance ahead of the
 * job), wallet-frozen (distinct from `claim.eligibility.integration.test.ts`'s
 * wallet-empty case), and the reaper-shape proof (a committed claim with
 * zero recorded send_attempts left in exactly the shape the reaper's LEFT
 * JOIN depends on, plus the param-binding-order proof).
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('claimOne boundary and ordering (P03 close, protocol C2)', () => {
  it('claim_against_an_instance_with_zero_jobs_returns_undefined_without_error', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);

    await expect(
      claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT }),
    ).resolves.toBeUndefined();
  });

  it('a_band_value_matching_no_priority_rank_yields_zero_claims_and_preserves_the_job', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId, band: DEFAULT_CLAIM_INPUT.band });

    const claimed = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
      band: 999,
    });

    expect(claimed).toBeUndefined();
    const job = await getJobWithLease(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('next_attempt_at_exactly_equal_to_now_is_claimed', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);

    const client = await pool.connect();
    let jobId: string;
    try {
      await client.query('BEGIN');
      // now() is stable for the whole transaction - inserting with
      // next_attempt_at/scheduled_at bound to the SAME now() the later claim
      // statement will see (same connection, same still-open transaction)
      // proves the `<=` boundary includes exact equality, not just "in the
      // past".
      const nowResult = await client.query<{ n: Date }>('SELECT now() AS n');
      const frozenNow = nowResult.rows[0]?.n;
      if (!frozenNow) throw new Error('SELECT now() returned no row');

      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
            payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
         VALUES ($1, $2, 0, $3, $4, $5, 'text', 'normal', $6, 'queued', $7, $7)
         RETURNING id`,
        [
          clientId,
          instanceId,
          '15550000000@s.whatsapp.net',
          '+15550000000',
          JSON.stringify({ text: 'edge' }),
          DEFAULT_CLAIM_INPUT.band,
          frozenNow,
        ],
      );
      jobId = insertResult.rows[0]?.id ?? '';
      if (!jobId) throw new Error('insert returned no id');

      const claimed = await claimOne(ctxFor(clientId, client), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      expect(claimed?.id).toBe(jobId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const job = await getJobWithLease(pool, jobId);
    expect(job.status).toBe('processing');
  });

  it('twenty_sequential_claims_drain_in_strict_next_attempt_at_then_id_order_with_no_skips_or_duplicates', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const now = Date.now();
    const JOB_COUNT = 20;

    const seededIds: string[] = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      // Distinct, strictly-increasing-into-the-past offsets so
      // next_attempt_at alone fully orders every job (no id-tiebreak
      // ambiguity to worry about here).
      const id = await seedJob(pool, {
        clientId,
        instanceId,
        nextAttemptAt: new Date(now - (JOB_COUNT - i) * 1000),
      });
      seededIds.push(id);
    }
    // seededIds is already in insertion order == oldest-nextAttemptAt-first
    // order, since each successive job got a LARGER offset (further past).
    const expectedOrder = [...seededIds];

    const claimedOrder: string[] = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      const claimed = await claimOne(ctxFor(clientId, pool), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      expect(
        claimed,
        `claim #${String(i + 1)} of ${String(JOB_COUNT)} unexpectedly empty`,
      ).toBeDefined();
      if (claimed) claimedOrder.push(claimed.id);
    }

    expect(claimedOrder).toEqual(expectedOrder);
    expect(new Set(claimedOrder).size).toBe(JOB_COUNT);

    // The queue is now fully drained - a 21st claim must be empty, not a
    // duplicate or a skip resurfacing.
    const overdraw = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });
    expect(overdraw).toBeUndefined();
  });

  it('claim_breaks_a_next_attempt_at_tie_by_lowest_id', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const now = Date.now();
    const tiedNextAttemptAt = new Date(now - 60_000);

    // Insertion order == id order (bigint identity), both rows share the
    // exact same next_attempt_at - the ORDER BY's second key (id) must be
    // the sole tiebreaker.
    const lowerId = await seedJob(pool, { clientId, instanceId, nextAttemptAt: tiedNextAttemptAt });
    const higherId = await seedJob(pool, {
      clientId,
      instanceId,
      nextAttemptAt: tiedNextAttemptAt,
    });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed?.id).toBe(lowerId);
    expect(claimed?.id).not.toBe(higherId);
  });

  it('session_epoch_mismatch_yields_zero_claims_when_the_instance_is_ahead_of_the_job', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds, {
      sessionEpoch: 5,
    });
    const jobId = await seedJob(pool, { clientId, instanceId, sessionEpoch: 0 });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJobWithLease(pool, jobId);
    expect(job.status).toBe('queued');
  });

  it('wallet_frozen_stops_claims_and_leaves_every_job_queued', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds, {
      walletState: 'frozen',
    });
    const jobId = await seedJob(pool, { clientId, instanceId });

    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });

    expect(claimed).toBeUndefined();
    const job = await getJobWithLease(pool, jobId);
    expect(job.status).toBe('queued');

    const instance = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instance.rows[0]?.health_state).toBe('connected');
  });

  it('a_committed_claim_with_no_recorded_attempt_is_shaped_for_the_reaper', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    // Claim via the pool directly (auto-commit) - no manual transaction -
    // proving the row is left in the exact shape the reaper's LEFT JOIN
    // against send_attempts depends on: committed, leased, but with zero
    // recorded attempts.
    const claimed = await claimOne(ctxFor(clientId, pool), { instanceId, ...DEFAULT_CLAIM_INPUT });
    expect(claimed?.id).toBe(jobId);

    const job = await getJobWithLease(pool, jobId);
    expect(job.status).toBe('processing');
    expect(job.lease_owner).toBe(DEFAULT_CLAIM_INPUT.workerId);
    expect(job.owner_fence).toBe(String(DEFAULT_CLAIM_INPUT.fence));
    expect(job.leased_at).not.toBeNull();
    expect(job.lease_expires_at).not.toBeNull();
    expect(job.lease_expires_at && job.lease_expires_at.getTime()).toBeGreaterThan(Date.now());
    // gap 7 (param-binding-order proof): every bound param landed in its
    // intended column, not shifted into a neighbour - lease_id/owner/fence
    // all resolve correctly only if bindQueryParams ordered them right.
    expect(claimed?.leaseId).toBe(job.lease_id);

    const attemptCount = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM send_attempts WHERE message_job_id = $1',
      [jobId],
    );
    expect(attemptCount.rows[0]?.count).toBe(0);
  });
});
