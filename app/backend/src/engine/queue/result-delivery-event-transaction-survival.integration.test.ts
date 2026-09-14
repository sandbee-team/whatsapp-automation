import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { ClaimLostDuringSend, resolveAck, type ResultDeps } from './result.js';
import { deliveryEventId, writeDeliveryEvent } from './delivery-event.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-delivery-event-transaction-survival.integration.test.ts (P11 C1
 * CRITICAL fix, split from `result.integration.test.ts` at the max-lines
 * cap - topic split only, no behavior change, same idiom as
 * `result-failure.integration.test.ts`) - real Postgres proof that
 * `writeDeliveryEvent`'s dedupe insert (`delivery-event.ts`) never puts an
 * already-open transaction into an aborted (25P02) state on a duplicate
 * `provider_event_id`.
 *
 * Before the fix: a raised-and-caught 23505 inside an open transaction (no
 * savepoint - `db/src/tenant-db.ts`'s `withTenant` never issues one) leaves
 * Postgres in "current transaction is aborted" state; every LATER statement
 * in that same transaction fails 25P02, and COMMIT silently degrades to
 * ROLLBACK while the pg client library reports success. Since
 * `writeDeliveryEvent` is the LAST statement of `resolveAck`'s second
 * transaction (`result.ts`), a duplicate `provider_event_id` there would
 * discard `status='sent'`/`sent_at`/the `message_wa_ids` row while
 * `resolveAck` itself returned normally - a silent double-send.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-delivery-event-tx-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('writeDeliveryEvent - transaction survival on a duplicate (real Postgres)', () => {
  it('a_writeDeliveryEvent_duplicate_inside_an_open_transaction_does_not_abort_it', async () => {
    // Proven by doing a REAL job-state write first, then calling
    // writeDeliveryEvent with an id that already exists, in the SAME
    // transaction, then committing - and asserting the earlier write
    // actually persisted.
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const providerEventId = deliveryEventId(
      seeded.instanceId,
      seeded.publicId,
      'sent',
      seeded.attemptNo,
    );

    // Pre-seed the dedupe row so the SECOND insert below is a genuine
    // duplicate - written in its own transaction, deliberately BEFORE the
    // one under test, so the one under test is the one proving survival.
    await tenantDb.withTenant(seeded.clientId, async (tx) => {
      const result = await writeDeliveryEvent(tx, {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        messageJobId: seeded.jobId,
        messageJobCreatedAt: seeded.jobCreatedAt,
        eventType: 'sent',
        providerEventId,
      });
      expect(result.inserted).toBe(true);
    });

    await tenantDb.withTenant(seeded.clientId, async (tx) => {
      const jobUpdate = await tx.query(
        `UPDATE message_jobs SET status = 'sent', sent_at = now()
          WHERE id = $1 AND lease_id = $2 AND status = 'processing'`,
        [seeded.jobId, seeded.leaseId],
      );
      expect(jobUpdate.rowCount).toBe(1);

      // A genuine duplicate - the dedupe row already exists from the
      // pre-seed above. This must NOT throw and must NOT abort the
      // transaction the job-state UPDATE above is still part of.
      const dup = await writeDeliveryEvent(tx, {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        messageJobId: seeded.jobId,
        messageJobCreatedAt: seeded.jobCreatedAt,
        eventType: 'sent',
        providerEventId,
      });
      expect(dup.inserted).toBe(false);

      // Proves the transaction is still alive (not aborted/25P02): a
      // further statement in the SAME transaction must still succeed.
      const stillAlive = await tx.query('SELECT 1 AS one');
      expect(stillAlive.rows[0]?.one).toBe(1);
    });

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('sent');
    expect(jobRow.sent_at).not.toBeNull();

    const eventRows = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM delivery_events WHERE message_job_id = $1 AND event_type = $2',
      [seeded.jobId, 'sent'],
    );
    expect(eventRows.rows.length).toBe(1);
  });

  it('a_replayed_resolveAck_leaves_status_sent_intact_and_the_job_not_reclaimable', async () => {
    // End-to-end shape: a second, replayed resolveAck call for the same
    // job/attempt (e.g. a duplicate webhook, a reaper re-drive) must never
    // discard the FIRST call's 'sent' outcome, and the job must not become
    // claimable again as a side effect of the replay.
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const input = {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      outcome: { providerMsgId: 'wamid.replay' },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
    };

    await resolveAck(input, deps);

    const firstJobRow = await getJobResultRow(pool, seeded.jobId);
    expect(firstJobRow.status).toBe('sent');
    const firstSentAt = firstJobRow.sent_at;

    // Replay: the job-outcome UPDATE's WHERE (status='processing') already
    // matches zero rows, so this throws ClaimLostDuringSend BEFORE ever
    // reaching writeDeliveryEvent - the real-world shape of "a duplicate
    // webhook after the job already resolved". The sibling test above
    // covers the case where a duplicate DOES reach writeDeliveryEvent
    // inside a still-open transaction; this test proves the outer, more
    // common replay path leaves 'sent' untouched too.
    await expect(resolveAck(input, deps)).rejects.toThrow(ClaimLostDuringSend);

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('sent');
    expect(jobRow.sent_at).toEqual(firstSentAt);

    const eventRows = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM delivery_events WHERE message_job_id = $1 AND event_type = $2',
      [seeded.jobId, 'sent'],
    );
    expect(eventRows.rows.length).toBe(1);
  });
});
