import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { OptOutCandidateText, waJidFromE164 } from '@wp/domain';
import type { TestPool } from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';

/**
 * optout-inbound-test-support.ts (P21 Unit U4, step 5) - fixture helpers
 * split out of `optout.integration.test.ts` purely for that file's own
 * max-lines cap (same established split idiom as
 * `guard-pipeline-log-pii-test-support.ts`/`session-worker-discovery-
 * wiring.ts`); shared by the sibling `optout-lid-and-body.integration.
 * test.ts` too, so every fixture here lives in exactly ONE place.
 */

/** Same distinct-kekId-per-purpose fixture ring idiom as `registry.integration.test.ts#makeOptoutPepperRing`. */
function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-inbound-optout-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0c).toString('base64');
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

export function makeInboundOptoutProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: makeOptoutPepperRing(),
    mountedPurposes: ['optout-pepper', 'tenant-secrets'],
  });
}

export async function seedLiveContact(
  testPool: TestPool,
  clientId: string,
  e164: string,
  phoneHash: Buffer,
  lidJid: string | null = null,
): Promise<string> {
  const result = await testPool.query<{ id: string }>(
    `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, addressing_mode, lid_jid, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual')
     RETURNING id`,
    [clientId, e164, phoneHash, waJidFromE164(e164), lidJid === null ? 'pn' : 'lid', lidJid],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedLiveContact: no row returned');
  return row.id;
}

export async function seedQueuedDmJob(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
  recipientJid: string,
  recipientHash: Buffer,
): Promise<string> {
  const result = await testPool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'queued', now(), now(), 0, 5)
     RETURNING id`,
    [
      clientId,
      instanceId,
      recipientJid,
      recipientJid.endsWith('@g.us') ? null : '+15550009999',
      recipientHash,
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedQueuedDmJob: no row returned');
  await seedJobRef(testPool, clientId, instanceId, row.id);
  return row.id;
}

/**
 * Every test job needs its `message_job_refs` row: the enqueue transaction
 * always writes both, and `enqueue.integration.test.ts#no_job_row_ever_exists_
 * without_a_matching_ref` scans the WHOLE table - a bare job insert in any
 * concurrently running file trips it. `message_job_created_at` is bound
 * in-SQL from the job row (never a round-tripped JS Date - pg truncates a
 * timestamptz to ms, which would break the ref's equality join).
 */
export async function seedJobRef(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
  jobId: string,
): Promise<string> {
  const publicId = randomUUID();
  await testPool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     SELECT $1, $2, $3, j.id, j.created_at FROM message_jobs j WHERE j.id = $4 AND j.client_id = $2`,
    [publicId, clientId, instanceId, jobId],
  );
  return publicId;
}

export function inboundOptoutCandidate(text: string): OptOutCandidateText {
  const c = OptOutCandidateText.fromPlainText(text);
  if (c === null) throw new Error('inboundOptoutCandidate: unexpected null');
  return c;
}

export async function cleanupInboundOptoutProbeRows(
  testPool: TestPool,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  await testPool.query('DELETE FROM optout_confirmations WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await testPool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  await testPool.query('DELETE FROM instance_recipient_contacts WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await testPool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [probeClientIds]);
}
