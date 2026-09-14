import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { claimOne } from './index.js';
import {
  DEFAULT_CLAIM_INPUT,
  cleanupProbeClients,
  ctxFor,
  getJob,
  getJobWithLease,
  seedJob,
  seedTenant,
  seedTenantEdgeProbe,
  type TestPool,
} from './__tests__/claim-test-helpers.js';

/**
 * claim.race.integration.test.ts (P03 close, split from
 * `claim.integration.test.ts` + `claim.edge-cases.integration.test.ts` for
 * file-size, protocol C2) - real-Postgres proofs for `claimOne`'s
 * concurrency behavior: two workers racing (sequential and true-concurrent
 * transactions), `SKIP LOCKED` against a row held `FOR UPDATE` by another
 * session, and crash/replay idempotency (a rolled-back claim leaves zero
 * lease residue and stays genuinely reclaimable; a replayed claim call never
 * returns the same now-processing job twice).
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

describe('claimOne concurrency, crash, and replay behavior', () => {
  it('two_workers_cannot_double_claim_one_job', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const claimA = await claimOne(ctxFor(clientId, clientA), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      const claimB = await claimOne(ctxFor(clientId, clientB), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });

      expect(claimA?.id).toBe(jobId);
      expect(claimB).toBeUndefined();

      // The loser's whole transaction rolls back.
      await clientB.query('ROLLBACK');
      await clientA.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }

    const job = await getJob(pool, jobId);
    expect(job.status).toBe('processing');
  });

  it('two_workers_firing_simultaneously_claim_exactly_one_job_between_them', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      // Fire both claims WITHOUT awaiting the first - a true race on separate
      // connections/transactions, not the sequential BEGIN/BEGIN pattern used
      // by 'two_workers_cannot_double_claim_one_job' above.
      const [resultA, resultB] = await Promise.allSettled([
        (async () => {
          await clientA.query('BEGIN');
          const claimed = await claimOne(ctxFor(clientId, clientA), {
            instanceId,
            ...DEFAULT_CLAIM_INPUT,
          });
          await clientA.query('COMMIT');
          return claimed;
        })(),
        (async () => {
          await clientB.query('BEGIN');
          const claimed = await claimOne(ctxFor(clientId, clientB), {
            instanceId,
            ...DEFAULT_CLAIM_INPUT,
          });
          await clientB.query('COMMIT');
          return claimed;
        })(),
      ]);

      const claims = [resultA, resultB].map((r) =>
        r.status === 'fulfilled' ? r.value : undefined,
      );
      const winners = claims.filter((c) => c?.id === jobId);
      const losers = claims.filter((c) => c === undefined);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
    } finally {
      clientA.release();
      clientB.release();
    }

    const job = await getJob(pool, jobId);
    expect(job.status).toBe('processing');
  });

  it('a_concurrent_wallet_debit_is_not_blocked_by_a_claim', async () => {
    const { clientId, instanceId } = await seedTenant(pool, probeClientIds);
    await seedJob(pool, { clientId, instanceId });

    const claimClient = await pool.connect();
    const debitClient = await pool.connect();
    try {
      await claimClient.query('BEGIN');
      const claimed = await claimOne(ctxFor(clientId, claimClient), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      expect(claimed).toBeDefined();

      await debitClient.query('BEGIN');
      await debitClient.query("SET LOCAL statement_timeout = '2s'");
      await expect(
        debitClient.query(
          'UPDATE wallet_accounts SET balance_minor = balance_minor - 1 WHERE client_id = $1',
          [clientId],
        ),
      ).resolves.toBeDefined();
      await debitClient.query('ROLLBACK');
      await claimClient.query('ROLLBACK');
    } finally {
      claimClient.release();
      debitClient.release();
    }
  });

  it('crash_mid_transaction_rollback_leaves_the_job_queued_with_no_lease_residue', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const jobId = await seedJob(pool, { clientId, instanceId });

    const crashingClient = await pool.connect();
    try {
      await crashingClient.query('BEGIN');
      const claimed = await claimOne(ctxFor(clientId, crashingClient), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      expect(claimed?.id).toBe(jobId);
      // Simulate the worker crashing/disconnecting before COMMIT: the
      // transaction never commits, so its whole write set - status AND every
      // lease column set by the RETURNING clause - must revert.
      await crashingClient.query('ROLLBACK');
    } finally {
      crashingClient.release();
    }

    const afterRollback = await getJobWithLease(pool, jobId);
    expect(afterRollback.status).toBe('queued');
    expect(afterRollback.lease_owner).toBeNull();
    expect(afterRollback.lease_id).toBeNull();
    expect(afterRollback.owner_fence).toBeNull();
    expect(afterRollback.leased_at).toBeNull();
    expect(afterRollback.lease_expires_at).toBeNull();

    // The job must still be genuinely claimable afterward, not stuck.
    const reclaimed = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(reclaimed?.id).toBe(jobId);
  });

  it('replay_of_claim_after_a_committed_claim_returns_the_next_job_never_the_same_one', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const now = Date.now();
    const firstJobId = await seedJob(pool, {
      clientId,
      instanceId,
      nextAttemptAt: new Date(now - 90_000),
    });
    const secondJobId = await seedJob(pool, {
      clientId,
      instanceId,
      nextAttemptAt: new Date(now - 30_000),
    });

    const firstClaim = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(firstClaim?.id).toBe(firstJobId);

    // "Replay" = calling claimOne again for the same instance/band, exactly
    // as a retried worker request would. status='queued' no longer matches
    // the first job (it is 'processing'), so this must fall through to the
    // next eligible row, never return the same job twice.
    const secondClaim = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(secondClaim?.id).toBe(secondJobId);
    expect(secondClaim?.id).not.toBe(firstClaim?.id);

    const firstJob = await getJobWithLease(pool, firstJobId);
    expect(firstJob.status).toBe('processing');
  });

  it('a_row_held_by_another_sessions_for_update_is_skipped_not_waited_on', async () => {
    const { clientId, instanceId } = await seedTenantEdgeProbe(pool, probeClientIds);
    const now = Date.now();
    const lockedJobId = await seedJob(pool, {
      clientId,
      instanceId,
      nextAttemptAt: new Date(now - 90_000),
    });
    const freeJobId = await seedJob(pool, {
      clientId,
      instanceId,
      nextAttemptAt: new Date(now - 30_000),
    });

    const lockingClient = await pool.connect();
    try {
      await lockingClient.query('BEGIN');
      // Holds a row lock on the OLDER (would-be-first-claimed) job without
      // committing/releasing - simulating a slow concurrent dependency.
      await lockingClient.query('SELECT id FROM message_jobs WHERE id = $1 FOR UPDATE', [
        lockedJobId,
      ]);

      // SKIP LOCKED must not block on the held row; it should resolve
      // promptly with the NEXT eligible (unlocked) job instead.
      const claimed = await claimOne(ctxFor(clientId, pool), {
        instanceId,
        ...DEFAULT_CLAIM_INPUT,
      });
      expect(claimed?.id).toBe(freeJobId);
      expect(claimed?.id).not.toBe(lockedJobId);

      await lockingClient.query('ROLLBACK');
    } finally {
      lockingClient.release();
    }

    // Once released, the previously-locked job is claimable too.
    const claimedAfterRelease = await claimOne(ctxFor(clientId, pool), {
      instanceId,
      ...DEFAULT_CLAIM_INPUT,
    });
    expect(claimedAfterRelease?.id).toBe(lockedJobId);
  });
});
