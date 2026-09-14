import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyProvider, type KeyProvider } from '@wp/server-kit/crypto';
import type { TestPool } from '../../../../engine/queue/__tests__/queue-send-tenant-fixture.js';

/**
 * guard-pipeline-log-pii-test-support.ts (P14 Unit U7) - fixture helpers
 * split out of `guard-pipeline-log-pii.integration.test.ts` purely for that
 * file's own max-lines cap (same established split idiom as
 * `session-worker-discovery-wiring.ts`).
 */

export function captureStream(): { stream: Writable; lines: () => string[] } {
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

/** Same distinct-kekId-per-purpose fixture ring idiom as every other P14 test's own key-provider helper. */
export function makeGuardPiiKeyProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-guard-pii-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0f).toString('base64');
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
  return new FileKeyProvider({
    ringPath: path,
    mountedPurposes: ['optout-pepper', 'tenant-secrets'],
  });
}

export async function seedGuardPiiQueuedJob(
  pool: TestPool,
  clientId: string,
  instanceId: string,
  e164: string,
  recipientHash: Buffer,
  body: string,
): Promise<string> {
  const publicId = randomUUID();
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      `${e164.replace(/^\+/u, '')}@s.whatsapp.net`,
      e164,
      recipientHash,
      JSON.stringify({ text: body }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedGuardPiiQueuedJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, clientId, instanceId, row.id, row.created_at],
  );
  return row.id;
}
