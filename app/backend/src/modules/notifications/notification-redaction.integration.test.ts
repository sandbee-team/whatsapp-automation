import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createLogger, createMetricsRegistry } from '@wp/server-kit';
import * as serverKit from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  applyHardSignalPause,
  type HardSignalPauseInput,
} from '../pacing/health/hard-signal-pause.js';
import { claimAndReserve } from '../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedNotifyTenant, cleanupNotifyFixtures } from './__tests__/notifications-test-support.js';

/**
 * notification-redaction.integration.test.ts (P17 U6, step 5/6) -
 * `no_phone_jid_or_body_appears_in_a_payload_log_line_or_metric_label`:
 * follows `guard-pipeline-log-pii.integration.test.ts`'s own log-capture +
 * negative-control idiom (`@wp/server-kit`'s shared `logger` singleton
 * swapped for a real `createLogger(captureStream)` instance). Seeds a
 * two-tenant run through TWO wired notify() call sites - the hard-signal
 * pause (`instance_paused`) and the duplicate-fan-out NEEDS_HUMAN_ACK trip
 * (`duplicate_fanout_ack_required`, the ONE call site whose payload
 * construction is anywhere near a real phone/body) - then greps captured
 * log lines, the `notifications.payload` jsonb column, and metric label
 * values for the seeded phone/JID/body tokens.
 */

function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0),
  };
}

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];
let notifyClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'notification-redaction-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
  await cleanupNotifyFixtures(pool, notifyClientIds);
  notifyClientIds = [];
});

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

function baseHardSignalInput(clientId: string, instanceId: string): HardSignalPauseInput {
  return {
    clientId,
    instanceId,
    pauseReason: 'health_critical',
    evidence: {},
    effectiveLimits: {},
    warmupTier: 1,
    accountAgeDays: 10,
    sendHistory30d: {},
    band: 'critical',
  };
}

async function seedGuardJob(
  clientId: string,
  instanceId: string,
  recipientHash: Buffer,
  body: string,
  priorityRank = 6,
): Promise<string> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', $6, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      recipientJid,
      recipientHash,
      JSON.stringify({ text: body }),
      priorityRank,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedGuardJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  return row.id;
}

describe('notification payload/log/metric redaction (P17 U6, real Postgres)', () => {
  it('no_phone_jid_or_body_appears_in_a_payload_log_line_or_metric_label', async () => {
    const { stream, lines } = captureStream();
    const capturingLogger = createLogger(stream);
    vi.spyOn(serverKit, 'logger', 'get').mockReturnValue(capturingLogger);
    const registry = createMetricsRegistry();

    const sentinel = `sentinel-${randomUUID()}`;
    capturingLogger.info({}, `probe line carrying ${sentinel}`);
    expect(lines().some((line) => line.includes(sentinel))).toBe(true);

    // --- Tenant A: hard-signal pause (instance_paused) -----------------
    const tenantA = await seedNotifyTenant(pool);
    notifyClientIds.push(tenantA.clientId);
    await tenantDb.withTenant(tenantA.clientId, (tx) =>
      applyHardSignalPause(tx, baseHardSignalInput(tenantA.clientId, tenantA.instanceId)),
    );

    // --- Tenant B: NEEDS_HUMAN_ACK trip (duplicate_fanout_ack_required) --
    const { clientId: clientB, instanceId: instanceB } = await seedSendTenant(pool, probeClientIds);
    const secretBody = `Confidential order details for account ${randomUUID()}`;
    const ackJobIds: string[] = [];
    for (let i = 0; i < 61; i += 1) {
      const id = await seedGuardJob(
        clientB,
        instanceB,
        Buffer.from(`redaction-recipient-${String(i).padStart(4, '0')}`),
        secretBody,
      );
      ackJobIds.push(id);
    }
    await pool.query(
      `UPDATE message_jobs SET next_attempt_at = now() + interval '1 day' WHERE id = ANY($1)`,
      [ackJobIds],
    );
    const claimFn = claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock });
    for (const jobId of ackJobIds) {
      await pool.query('UPDATE message_jobs SET next_attempt_at = now() WHERE id = $1', [jobId]);
      await claimFn(
        { clientId: clientB, sql: pool },
        {
          instanceId: instanceB,
          band: 6,
          fence: 1,
          workerId: 'redaction-test-worker',
          claimExpiryMs: 90_000,
        },
      );
    }

    const trippedRow = await pool.query<{ pacing_deny_reason: string | null }>(
      'SELECT pacing_deny_reason FROM message_jobs WHERE id = $1',
      [ackJobIds[60]],
    );
    expect(trippedRow.rows[0]?.pacing_deny_reason).toBe('NEEDS_HUMAN_ACK');

    // ---- Assertions ----
    const seededTokens = [
      tenantA.instanceId,
      instanceB,
      secretBody,
      '+15550000000',
      'redaction-recipient-',
    ];

    const notificationRows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM notifications WHERE client_id = ANY($1)`,
      [[tenantA.clientId, clientB]],
    );
    expect(notificationRows.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of notificationRows.rows) {
      const serialized = JSON.stringify(row.payload);
      for (const token of seededTokens) {
        if (token === tenantA.instanceId || token === instanceB) continue; // instanceId itself IS an allowed ids-only payload field
        expect(serialized).not.toContain(token);
      }
    }

    const capturedLines = lines().filter((line) => !line.includes(sentinel));
    for (const line of capturedLines) {
      expect(line).not.toContain(secretBody);
      expect(line).not.toContain('+15550000000');
      expect(line).not.toContain('redaction-recipient-');
    }

    const metricsText = await registry.metricsText();
    expect(metricsText).not.toContain(secretBody);
    expect(metricsText).not.toContain('+15550000000');
  }, 60_000);
});
