import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { hashRecipient } from '../../../platform/crypto/phone-hash.js';
import { cancelOptOutJobs, isOptedOut, recordOptOut } from './registry.js';

/**
 * registry.integration.test.ts (P14 Unit U3, step 7) - the THREE mandatory
 * cases against real Postgres. Group-job-exclusion, idempotency, and health-
 * denominator exclusion are proved here; the "one confirmation ever" half of
 * mandatory test 18 belongs to the confirmation-sender unit (not built yet -
 * this unit only returns the `optedOut` descriptor a post-commit caller
 * resolves into a confirmation send, in `optout-detect.ts`).
 *
 * P14 Unit U4's own three-enforcement-points cases (mandatory test 16,
 * amended) live in the SIBLING `registry-optout-enforcement.integration.
 * test.ts` (max-lines split - this file was already at its own cap; the
 * sibling reuses this file's `makeOptoutPepperRing`/key-provider shape via
 * its own copy, never a cross-file re-export, per this test suite's own
 * convention of self-contained fixture files).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-registry-test',
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

/** Builds a `FileKeyProvider` with a distinct kekId per purpose (avoids the "same kekId, different purpose" schema rejection). */
function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-optout-registry-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0b).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

interface SeedQueuedJobWithHashOptions {
  clientId: string;
  instanceId: string;
  recipientHash: Buffer;
  recipientJid: string;
}

async function seedQueuedJobWithHash(
  testPool: TestPool,
  options: SeedQueuedJobWithHashOptions,
): Promise<string> {
  const result = await testPool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'queued', now(), now(), 0, 5)
     RETURNING id`,
    [
      options.clientId,
      options.instanceId,
      options.recipientJid,
      options.recipientJid.endsWith('@g.us') ? null : '+15550009999',
      options.recipientHash,
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedQueuedJobWithHash: no row returned');
  return row.id;
}

async function getJobStatus(
  testPool: TestPool,
  jobId: string,
): Promise<{ status: string; cancel_reason: string | null; attempts: number }> {
  const result = await testPool.query<{
    status: string;
    cancel_reason: string | null;
    attempts: number;
  }>('SELECT status, cancel_reason, attempts FROM message_jobs WHERE id = $1', [jobId]);
  const row = result.rows[0];
  if (!row) throw new Error(`getJobStatus: no message_jobs row with id ${jobId}`);
  return row;
}

describe('opt-out registry (P14 Unit U3, real Postgres)', () => {
  it('optout_cancels_queued_jobs_and_is_idempotent', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const provider = new FileKeyProvider({
      ringPath: makeOptoutPepperRing(),
      mountedPurposes: ['optout-pepper'],
    });
    const phoneHash = hashRecipient(provider, '+15550001111');

    const jobId = await seedQueuedJobWithHash(pool, {
      clientId,
      instanceId,
      recipientHash: phoneHash,
      recipientJid: `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
    });

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      const first = await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        { mirror: async () => ({ contactsUpdated: 0 }) },
      );
      expect(first.inserted).toBe(true);

      const cancelled = await cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' });
      expect(cancelled).toEqual([jobId]);
    });

    const afterFirst = await getJobStatus(pool, jobId);
    expect(afterFirst.status).toBe('cancelled');
    expect(afterFirst.cancel_reason).toBe('opt_out');
    expect(afterFirst.attempts).toBe(0);

    // Second STOP: exactly one opt_outs row, no new cancellation.
    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      const second = await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        { mirror: async () => ({ contactsUpdated: 0 }) },
      );
      expect(second.inserted).toBe(false);

      const cancelledAgain = await cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' });
      expect(cancelledAgain).toEqual([]);
    });

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);

    const afterSecond = await getJobStatus(pool, jobId);
    expect(afterSecond.status).toBe('cancelled');
    expect(afterSecond.attempts).toBe(0);

    const optedOut = await tenantDb.withTenant(clientId, (tx: TenantQueryable) =>
      isOptedOut(tx, { clientId, instanceId, phoneHash }),
    );
    expect(optedOut).toBe(true);
  });

  it('an_optout_cancel_is_excluded_from_every_health_denominator', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const provider = new FileKeyProvider({
      ringPath: makeOptoutPepperRing(),
      mountedPurposes: ['optout-pepper'],
    });
    const phoneHash = hashRecipient(provider, '+15550002222');

    const jobId = await seedQueuedJobWithHash(pool, {
      clientId,
      instanceId,
      recipientHash: phoneHash,
      recipientJid: `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
    });

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        { mirror: async () => ({ contactsUpdated: 0 }) },
      );
      await cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' });
    });

    const status = await getJobStatus(pool, jobId);
    expect(status.status).toBe('cancelled');
    expect(status.status).not.toBe('failed');

    const sendAttempts = await pool.query(
      'SELECT id FROM send_attempts WHERE message_job_id = $1',
      [jobId],
    );
    expect(sendAttempts.rowCount).toBe(0);

    const failedDeliveryEvents = await pool.query(
      `SELECT id FROM delivery_events WHERE client_id = $1 AND event_type = 'failed'`,
      [clientId],
    );
    expect(failedDeliveryEvents.rowCount).toBe(0);
  });

  it('a_contact_optout_does_not_cancel_a_group_job', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const provider = new FileKeyProvider({
      ringPath: makeOptoutPepperRing(),
      mountedPurposes: ['optout-pepper'],
    });
    const phoneHash = hashRecipient(provider, '+15550003333');

    // Deliberate hash collision: the group job's recipient_hash equals the
    // contact's hash, to prove the exclusion is by recipient_jid shape, not
    // by "the hash never collides in practice".
    const groupJobId = await seedQueuedJobWithHash(pool, {
      clientId,
      instanceId,
      recipientHash: phoneHash,
      recipientJid: `${randomUUID().replaceAll('-', '')}-group@g.us`,
    });

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        { mirror: async () => ({ contactsUpdated: 0 }) },
      );
      const cancelled = await cancelOptOutJobs(tx, { clientId, phoneHash, scope: 'client' });
      expect(cancelled).toEqual([]);
    });

    const status = await getJobStatus(pool, groupJobId);
    expect(status.status).toBe('queued');
  });
});
