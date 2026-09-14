import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import { computeFingerprint, evaluateDuplicateFanout } from './fingerprint.js';

/**
 * fingerprint.integration.test.ts (P14 Unit U5, phase step 6; P14 Unit U6
 * extension, mandatory test 19) - the duplicate-fanout guard against real
 * Postgres. Mandatory cases: re-evaluating the same recipient never
 * inflates the distinct count [R-27w], the threshold boundary is exact (500
 * ok, 501 denies), and an acked fingerprint is always ok even above
 * threshold. `duplicate_fanout_holds_not_fails` (U6 extension) proves the
 * PIPELINE-LEVEL consequence: 600 identical-body jobs to distinct
 * recipients end up `queued`/`NEEDS_HUMAN_ACK`, never `failed`/deleted - the
 * ack-half of this guard (an actual human ack applying) is a later unit.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'fingerprint-guard-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
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

const WARN_AT = 150;
const ACK_AT = 500;
const NOW = new Date('2026-09-02T10:00:00.000Z');
const LOCAL_DATE = '2026-09-02';

function recipientHashAt(index: number): Buffer {
  // Fixed-width zero-padded index (never a variable-length prefix padded
  // afterward - that shape collides, e.g. "recipient-1" vs "recipient-10"
  // both padEnd to the same 32-byte string once truncated).
  return Buffer.from(`recipient-${String(index).padStart(10, '0')}`, 'utf8');
}

describe('duplicate-fanout content guard (P14 Unit U5, real Postgres)', () => {
  it('re_evaluating_the_same_recipient_does_not_inflate_the_distinct_count', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const fingerprint = computeFingerprint('Big sale today, everything 50% off!');
    const recipientHash = recipientHashAt(0);

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      for (let i = 0; i < 50; i += 1) {
        await evaluateDuplicateFanout(tx, {
          clientId,
          localDate: LOCAL_DATE,
          fingerprint,
          recipientHash,
          warnAt: WARN_AT,
          ackAt: ACK_AT,
          now: NOW,
        });
      }
    });

    const row = await pool.query<{ recipient_count: number }>(
      `SELECT recipient_count FROM content_fingerprints WHERE client_id = $1 AND local_date = $2 AND fingerprint = $3`,
      [clientId, LOCAL_DATE, fingerprint],
    );
    expect(row.rows[0]?.recipient_count).toBe(1);
  });

  it('threshold_boundary_is_exact_at_500_distinct_recipients', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const fingerprint = computeFingerprint('Reminder: appointment tomorrow at 5pm');

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      let lastDecision: Awaited<ReturnType<typeof evaluateDuplicateFanout>> | undefined;
      for (let i = 0; i < 500; i += 1) {
        lastDecision = await evaluateDuplicateFanout(tx, {
          clientId,
          localDate: LOCAL_DATE,
          fingerprint,
          recipientHash: recipientHashAt(i),
          warnAt: WARN_AT,
          ackAt: ACK_AT,
          now: NOW,
        });
      }
      // 500th distinct recipient: recipient_count = 500 = ackAt, still ok.
      expect(lastDecision).toEqual({ ok: true });

      const decision501 = await evaluateDuplicateFanout(tx, {
        clientId,
        localDate: LOCAL_DATE,
        fingerprint,
        recipientHash: recipientHashAt(500),
        warnAt: WARN_AT,
        ackAt: ACK_AT,
        now: NOW,
      });
      // 501st distinct recipient: recipient_count = 501 > ackAt = 500.
      expect(decision501).toEqual({ ok: false, reason: 'NEEDS_HUMAN_ACK', retryAt: null });
    });
  });

  it('an_acked_fingerprint_evaluates_ok_even_above_threshold', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const fingerprint = computeFingerprint('Flash sale, last chance!');
    const staffId = randomUUID();

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      for (let i = 0; i < 501; i += 1) {
        await evaluateDuplicateFanout(tx, {
          clientId,
          localDate: LOCAL_DATE,
          fingerprint,
          recipientHash: recipientHashAt(i),
          warnAt: WARN_AT,
          ackAt: ACK_AT,
          now: NOW,
        });
      }
    });

    await pool.query(
      `UPDATE content_fingerprints SET ack_by = $1, ack_at = $2 WHERE client_id = $3 AND local_date = $4 AND fingerprint = $5`,
      [staffId, NOW, clientId, LOCAL_DATE, fingerprint],
    );

    const decisionAfterAck = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      evaluateDuplicateFanout(tx, {
        clientId,
        localDate: LOCAL_DATE,
        fingerprint,
        recipientHash: recipientHashAt(999),
        warnAt: WARN_AT,
        ackAt: ACK_AT,
        now: NOW,
      }),
    );
    expect(decisionAfterAck).toEqual({ ok: true });
  });
});

describe('duplicate-fanout content guard - pipeline level (P14 Unit U6 extension, mandatory test 19)', () => {
  // Real wall-clock base (never a hardcoded literal date/time): defer-job.
  // sql's NEEDS_HUMAN_ACK retryAt is `claimClock.now() + 300_000`, and
  // claim-jobs.sql's own `next_attempt_at <= now()` predicate reads
  // Postgres's REAL now() - a frozen literal timestamp (e.g. a date stamped
  // at authoring time) silently falls behind real time as the calendar
  // advances, making every deferred job's hold already-expired relative to
  // the DB and collapsing this test's 600-job drive into repeatedly
  // reclaiming the same one or two jobs (see the P14 lesson this fixture's
  // header now points to). `localDate` for the duplicate-fanout bucket is
  // unaffected - it comes from `readGuardPipelineState`'s own
  // `now() AT TIME ZONE pacing_timezone` read against real Postgres time,
  // never from this JS clock.
  const claimClock = { now: () => Date.now() };

  /** Local seed helper - this file's own fixture import (`queue-send-tenant-fixture.js`) has no `seedQueuedJob`; a distinct recipient_hash per job is this test's own requirement, unlike the sibling `queue-send-test-helpers.js` seed. */
  async function seedDupJob(
    pool: TestPool,
    clientId: string,
    instanceId: string,
    recipientHash: Buffer,
    body: string,
    orderIndex: number,
  ): Promise<{ id: string }> {
    const publicId = randomUUID();
    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, is_new_conversation)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(),
               now() + ($6 || ' milliseconds')::interval, 0, 5, false)
       RETURNING id, created_at`,
      [
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        recipientHash,
        JSON.stringify({ text: body }),
        // Distinct, strictly increasing next_attempt_at per job (real-clock
        // microsecond ties can otherwise tie-break claim-jobs.sql's
        // ORDER BY back onto an earlier row - see pipeline.integration.
        // test.ts's own header for the full finding) - the loop's own
        // insertion order, not a hash-derived value.
        String(orderIndex),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('seedDupJob: no row returned');
    await pool.query(
      `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [publicId, clientId, instanceId, row.id, row.created_at],
    );
    return { id: row.id };
  }

  it('duplicate_fanout_holds_not_fails', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const claimAndReserveFn = claimAndReserve({
      tenantDb,
      rng: { random: () => 0.5 },
      clock: claimClock,
    });
    const body = 'Guard pipeline holds-not-fails fixture body, exact match every time';

    const jobIds: string[] = [];
    for (let i = 0; i < 600; i += 1) {
      const job = await seedDupJob(
        pool,
        clientId,
        instanceId,
        Buffer.from(`dup-fanout-holds-${String(i).padStart(4, '0')}`),
        body,
        i,
      );
      jobIds.push(job.id);
    }

    for (let i = 0; i < jobIds.length; i += 1) {
      // Driving 600 sequential real claims is the point: every job must be
      // individually evaluated (never Promise.all - a shared band claim
      // must never race against itself).
      await claimAndReserveFn(
        { clientId, sql: pool },
        {
          instanceId,
          band: 3,
          fence: 1,
          workerId: 'dup-fanout-holds-test-worker',
          claimExpiryMs: 90_000,
        },
      );
    }

    const rows = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM message_jobs
        WHERE id = ANY($1) GROUP BY status`,
      [jobIds],
    );
    const statuses = new Map(rows.rows.map((r) => [r.status, Number(r.count)]));
    expect(statuses.get('failed') ?? 0).toBe(0);
    // 599 stay 'queued' (deferred, never terminal); exactly ONE - the very
    // first claim of this pass, before the fixture's 15s min-gap floor has
    // anything to deny against - is genuinely GRANTED by the pacing reserve
    // (content guards all passed for it too, since it is the first distinct
    // recipient, well under dup_fanout_ack) and sits 'processing' (never
    // dispatched by this test). Zero deleted, zero failed either way.
    expect(statuses.get('queued') ?? 0).toBe(599);
    expect(statuses.get('processing') ?? 0).toBe(1);

    const deniedByAck = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs
        WHERE id = ANY($1) AND pacing_deny_reason = 'NEEDS_HUMAN_ACK'`,
      [jobIds],
    );
    // dup_fanout_ack = 60 for safe_default - every job past the 60th
    // distinct recipient (540 of the 600) holds on NEEDS_HUMAN_ACK.
    expect(Number(deniedByAck.rows[0]?.count)).toBe(540);
  });
});
