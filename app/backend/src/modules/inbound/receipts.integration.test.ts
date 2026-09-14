import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { deliveryRatioSignal } from '../pacing/health/signals/delivery-ratio.js';
import { readRatioSignal } from '../pacing/health/signals/read-ratio.js';
import { replyRateSignal } from '../pacing/health/signals/reply-rate.js';
import { bindInboundMetrics } from './metrics.js';
import { recordInboundReceipt, type InboundReceipt } from './receipts.js';
import { seedJobRef } from './__tests__/optout-inbound-test-support.js';

/**
 * receipts.integration.test.ts (P21 Unit U3, step 4) - real Postgres proof:
 * the receipt handler resolves `message_wa_ids` -> job, writes exactly one
 * `delivery_events` row per receipt (dedupe authority proof under
 * sequential AND concurrent replay), an unknown wa_msg_id is counted and
 * dropped (never a dead letter), and the P16 health collectors read the
 * real rows this handler writes.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'inbound-receipts-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

interface SeededSentJob {
  jobId: string;
  jobCreatedAt: Date;
  waMsgId: string;
}

async function seedSentJobWithWaId(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
  sentAt: Date,
): Promise<SeededSentJob> {
  const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const jobResult = await testPool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, sent_at)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, $7)
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      '+15550001234',
      Buffer.from('probe-hash'),
      JSON.stringify({ text: 'hello' }),
      sentAt,
    ],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) throw new Error('seedSentJobWithWaId: no message_jobs row returned');
  await seedJobRef(testPool, clientId, instanceId, jobRow.id);

  // `message_created_at` is bound from `message_jobs.created_at` INSIDE this
  // same statement (scalar subquery), never from the already-round-tripped
  // `jobRow.created_at` JS `Date` - the pg driver truncates a `timestamptz`'s
  // microsecond precision to JS `Date`'s millisecond precision, so
  // re-binding `jobRow.created_at` here would silently produce a
  // `message_created_at` that no longer equality-matches `message_jobs.
  // created_at`, and the health-signal-windows join (`mj.id = de.
  // message_job_id AND mj.created_at = de.message_job_created_at`) would
  // match zero rows against the very row that produced it - same bug class
  // `queue-send-test-helpers.ts#seedDispatchedAttempt` documents and fixes
  // the same way.
  await testPool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4`,
    [clientId, instanceId, waMsgId, jobRow.id],
  );

  return { jobId: jobRow.id, jobCreatedAt: jobRow.created_at, waMsgId };
}

function deliveredReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'delivered',
    eventTs: '1000',
    participantJid: '',
  };
}

function readReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'read',
    eventTs: '2000',
    participantJid: '',
  };
}

describe('receipt handler (real Postgres)', () => {
  it('a_delivered_receipt_writes_one_delivery_event_and_is_idempotent_on_replay', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { jobId, waMsgId } = await seedSentJobWithWaId(pool, clientId, instanceId, twoHoursAgo);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const sequentialFirst = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    const sequentialSecond = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));

    const concurrentOutcomes = await Promise.all(
      Array.from({ length: 5 }, () => recordInboundReceipt(deps, deliveredReceipt(waMsgId))),
    );

    const allOutcomes = [sequentialFirst, sequentialSecond, ...concurrentOutcomes];
    expect(allOutcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    expect(allOutcomes.filter((o) => o === 'duplicate')).toHaveLength(6);

    const rows = await pool.query(
      `SELECT id, event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, jobId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.event_type).toBe('delivered');

    expect(
      (await metrics.receiptsTotal.get()).values.find((v) => v.labels.event_type === 'delivered')
        ?.value,
    ).toBe(1);
  });

  it('a_read_receipt_after_delivered_keeps_both_events_in_order', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { jobId, waMsgId } = await seedSentJobWithWaId(pool, clientId, instanceId, twoHoursAgo);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const beforeJob = await pool.query('SELECT status FROM message_jobs WHERE id = $1', [jobId]);
    const beforeWallet = await pool.query(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );

    await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    await recordInboundReceipt(deps, readReceipt(waMsgId));

    const rows = await pool.query<{ id: string; event_type: string; provider_event_id: string }>(
      `SELECT id, event_type, provider_event_id FROM delivery_events
       WHERE client_id = $1 AND message_job_id = $2 ORDER BY id ASC`,
      [clientId, jobId],
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0]?.event_type).toBe('delivered');
    expect(rows.rows[1]?.event_type).toBe('read');
    expect(rows.rows[0]?.provider_event_id).not.toBe(rows.rows[1]?.provider_event_id);

    const afterJob = await pool.query('SELECT status FROM message_jobs WHERE id = $1', [jobId]);
    expect(afterJob.rows[0]?.status).toBe(beforeJob.rows[0]?.status);
    expect(afterJob.rows[0]?.status).toBe('sent');

    const afterWallet = await pool.query(
      'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(afterWallet.rows[0]?.balance_minor).toBe(beforeWallet.rows[0]?.balance_minor);
  });

  it('a_receipt_for_an_unknown_wa_msg_id_is_counted_not_dead_lettered', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const outcome = await recordInboundReceipt(deps, deliveredReceipt('UNKNOWN-WA-MSG-ID'));

    expect(outcome).toBe('unmatched');
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1);

    const deadLetters = await tenantDb.withTenant(clientId, (tx) =>
      tx.query('SELECT count(*) AS n FROM inbound_dead_letters WHERE client_id = $1', [clientId]),
    );
    expect(Number(deadLetters.rows[0]?.n)).toBe(0);

    const events = await pool.query('SELECT id FROM delivery_events WHERE client_id = $1', [
      clientId,
    ]);
    expect(events.rowCount).toBe(0);
  });

  it('the_delivery_ratio_collector_reads_real_receipts_while_reply_rate_stays_unmeasured', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const waMsgIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { waMsgId } = await seedSentJobWithWaId(pool, clientId, instanceId, twoHoursAgo);
      waMsgIds.push(waMsgId);
    }

    for (const waMsgId of waMsgIds) {
      const outcome = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
      expect(outcome).toBe('recorded');
    }

    const evidence = await tenantDb.withTenant(clientId, (tx) =>
      Promise.resolve(
        deliveryRatioSignal.collect({ sql: tx, clientId, instanceId, now: () => new Date() }),
      ),
    );
    expect(evidence).toEqual({ numerator: 30, denominator: 30, value: 1 });

    const readEvidence = await tenantDb.withTenant(clientId, (tx) =>
      Promise.resolve(
        readRatioSignal.collect({ sql: tx, clientId, instanceId, now: () => new Date() }),
      ),
    );
    expect(readEvidence).toBe('unmeasured');

    const replyEvidence = await tenantDb.withTenant(clientId, (tx) =>
      Promise.resolve(
        replyRateSignal.collect({ sql: tx, clientId, instanceId, now: () => new Date() }),
      ),
    );
    expect(replyEvidence).toBe('unmeasured');
    expect(replyEvidence).not.toBe(0);
  }, 30_000);
});
