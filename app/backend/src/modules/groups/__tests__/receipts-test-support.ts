import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { InboundReceipt } from '../../inbound/receipts.js';
import { seedJobRef } from '../../inbound/__tests__/optout-inbound-test-support.js';
import type { TestPool } from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';

/**
 * modules/groups/__tests__/receipts-test-support.ts (P24 Unit U4b) - shared
 * fixtures for `receipts.integration.test.ts`/`receipts-edge.integration.
 * test.ts` (max-lines split, same suite). Lives under `__tests__/` for the
 * same tenant-scope-guard seed/cleanup exemption `groups-test-helpers.ts`'s
 * own header explains.
 */

function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-groups-receipts-ring-'));
  const ringPath = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0d).toString('base64');
  writeFileSync(
    ringPath,
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
  return ringPath;
}

export function makeProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: makeOptoutPepperRing(),
    mountedPurposes: ['optout-pepper', 'tenant-secrets'],
  });
}

export async function seedSentJobWithWaId(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
  waMsgId: string,
): Promise<{ jobId: string; jobCreatedAt: Date }> {
  const jobResult = await testPool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, sent_at)
     VALUES ($1, $2, 0, $3, $4, $5, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, now())
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      '+15550001234',
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) throw new Error('seedSentJobWithWaId: no message_jobs row returned');
  await seedJobRef(testPool, clientId, instanceId, jobRow.id);
  await testPool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4`,
    [clientId, instanceId, waMsgId, jobRow.id],
  );
  return { jobId: jobRow.id, jobCreatedAt: jobRow.created_at };
}

export async function seedGroupSentJobWithWaId(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
  groupJid: string,
  waMsgId: string,
): Promise<{ jobId: string; jobCreatedAt: Date; publicId: string }> {
  const jobResult = await testPool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, sent_at)
     VALUES ($1, $2, 0, $3, NULL, $4, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, now())
     RETURNING id, created_at`,
    [clientId, instanceId, groupJid, JSON.stringify({ text: 'hello group' })],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) throw new Error('seedGroupSentJobWithWaId: no message_jobs row returned');
  const publicId = await seedJobRef(testPool, clientId, instanceId, jobRow.id);
  await testPool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4`,
    [clientId, instanceId, waMsgId, jobRow.id],
  );
  return { jobId: jobRow.id, jobCreatedAt: jobRow.created_at, publicId };
}

export function groupDeliveredReceipt(
  waMsgId: string,
  remoteJid: string,
  participantJid: string,
): InboundReceipt {
  return { waMsgId, remoteJid, eventType: 'delivered', eventTs: '1000', participantJid };
}

export function dmDeliveredReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'delivered',
    eventTs: '1000',
    participantJid: '',
  };
}

/** Cleans up the DM-attributed contact-touch rows a couple of these tests write - FK-blocks `cleanupSendProbeClients`'s own instance delete unless cleared first. */
export async function cleanupReceiptsContactRows(
  testPool: TestPool,
  probeClientIds: readonly string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  await testPool.query('DELETE FROM instance_recipient_contacts WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await testPool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [probeClientIds]);
}
