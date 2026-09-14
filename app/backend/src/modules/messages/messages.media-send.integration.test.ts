import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFsObjectStore } from '../../platform/storage/object-store-fs.js';
import type { ObjectStore } from '../../platform/storage/object-store-types.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { dispatch } from '../../engine/queue/dispatch.js';
import { resolveAck } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { insertOrGetMediaAsset } from '../media/index.js';
import { buildTestKeyProvider } from './enqueue-test-support.js';
import { createMessage } from './messages.service.js';
import { MediaAssetNotFoundError } from './messages.media-resolve.js';

/**
 * messages.media-send.integration.test.ts (P34 Unit B, ADR 0052 accepted
 * scope) - real Postgres, real fs object store, fake transport. Proves the
 * enqueue-vs-dispatch split end to end: an image send with a valid mediaId
 * creates ONE job with payload_kind='media'; a foreign/absent mediaId 404s
 * with no job row; the same idempotency key replays the same job; the
 * wallet is debited at the EXACT media rate; dispatch hands the transport a
 * stream, never a Buffer; last_used_at is stamped.
 */

let pool: TestPool;
let rootDir: string;
let objectStore: ObjectStore;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'media-send-test' });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), 'wp-media-send-'));
  objectStore = createFsObjectStore({ rootDir });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
  await pool.query('DELETE FROM media_assets WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** `seedSendTenant`'s instance defaults `link_state='unlinked'` (it targets dispatch tests, which never run `createMessage`'s link-state gate) - the enqueue tests here need a linked, connected instance. */
async function markInstanceLinked(instanceId: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_instances SET link_state = 'linked', health_state = 'connected' WHERE id = $1`,
    [instanceId],
  );
}

async function seedImageAsset(clientId: string): Promise<string> {
  const tenantDb = createTenantDb(pool);
  const id = randomUUID();
  const stored = await objectStore.put({
    clientId,
    kind: 'media',
    body: Readable.from([Buffer.from('fake-jpeg-bytes')]),
    contentType: 'image/jpeg',
    maxBytes: 5 * 1024 * 1024,
    now: new Date(),
    id,
  });
  await tenantDb.withTenant(clientId, (tx) =>
    insertOrGetMediaAsset(tx, {
      clientId,
      id,
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: stored.bytes,
      fileName: null,
      storageKey: stored.key,
      sha256: Buffer.from(id),
      createdByUserId: null,
    }),
  );
  return id;
}

describe('image/document send - enqueue vs dispatch split (real Postgres)', () => {
  it('an_image_send_with_a_valid_media_id_creates_one_job_with_payload_kind_media', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await markInstanceLinked(instanceId);
    const mediaId = await seedImageAsset(clientId);
    const tenantDb = createTenantDb(pool);

    const result = await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey: `idem-${randomUUID()}`,
        requestBody: { kind: 'image', payload: { mediaId } },
        recipient: { jid: '15550001234@s.whatsapp.net', e164: '+15550001234' },
        payload: { kind: 'image', mediaId },
        payloadKind: 'image',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider: buildTestKeyProvider() },
    );

    expect(result.status).toBe('queued');

    const rows = await pool.query<{ payload_kind: string; payload: Record<string, unknown> }>(
      'SELECT payload_kind, payload FROM message_jobs WHERE client_id = $1',
      [clientId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.payload_kind).toBe('media');
    expect(rows.rows[0]?.payload).toEqual({ kind: 'image', mediaId });
  });

  it('a_foreign_or_absent_media_id_404s_with_no_job_row', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await markInstanceLinked(instanceId);
    const tenantDb = createTenantDb(pool);
    const foreignMediaId = randomUUID();

    await expect(
      createMessage(
        tenantDb,
        {
          clientId,
          instanceId,
          idempotencyKey: `idem-${randomUUID()}`,
          requestBody: { kind: 'image', payload: { mediaId: foreignMediaId } },
          recipient: { jid: '15550001234@s.whatsapp.net', e164: '+15550001234' },
          payload: { kind: 'image', mediaId: foreignMediaId },
          payloadKind: 'image',
          priority: 'normal',
          scheduledAt: null,
          sendOrigin: 'api_send',
        },
        { keyProvider: buildTestKeyProvider() },
      ),
    ).rejects.toBeInstanceOf(MediaAssetNotFoundError);

    const rows = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(rows.rowCount).toBe(0);
  });

  it('the_same_idempotency_key_replays_the_same_job', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await markInstanceLinked(instanceId);
    const mediaId = await seedImageAsset(clientId);
    const tenantDb = createTenantDb(pool);
    const idempotencyKey = `idem-${randomUUID()}`;
    const input = {
      clientId,
      instanceId,
      idempotencyKey,
      requestBody: { kind: 'image', payload: { mediaId } },
      recipient: { jid: '15550001234@s.whatsapp.net', e164: '+15550001234' },
      payload: { kind: 'image', mediaId },
      payloadKind: 'image',
      priority: 'normal' as const,
      scheduledAt: null,
      sendOrigin: 'api_send' as const,
    };
    const deps = { keyProvider: buildTestKeyProvider() };

    const first = await createMessage(tenantDb, input, deps);
    const second = await createMessage(tenantDb, input, deps);

    expect(second.id).toBe(first.id);
    const rows = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(rows.rowCount).toBe(1);
  });

  it('dispatch_hands_the_transport_a_stream_and_the_wallet_is_debited_at_the_media_rate', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await markInstanceLinked(instanceId);
    const mediaId = await seedImageAsset(clientId);
    const tenantDb = createTenantDb(pool);
    const leaseId = randomUUID();
    const publicId = randomUUID();

    const jobInsert = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at)
       VALUES ($1, $2, 0, $3, '+15550009999', $4, 'media', 'normal', 10, 'processing', now(), now(),
               0, 5, 'worker-1', $5, 1, now(), now() + interval '90 seconds')
       RETURNING id, created_at`,
      [
        clientId,
        instanceId,
        '15550009999@s.whatsapp.net',
        JSON.stringify({ kind: 'image', mediaId, caption: 'hi' }),
        leaseId,
      ],
    );
    const job = jobInsert.rows[0];
    if (!job) throw new Error('job insert returned no row');
    await pool.query(
      `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [publicId, clientId, instanceId, job.id, job.created_at],
    );

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.media-1');

    const dispatchResult = await dispatch(
      {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.created_at,
        leaseId,
        attempts: 0,
        recipientJid: '15550009999@s.whatsapp.net',
        recipientHash: null,
        sendOrigin: null,
        payloadKind: 'media',
        payload: { kind: 'image', mediaId, caption: 'hi' },
        publicId,
        fence: 1,
      },
      {
        tenantDb,
        transport,
        clock: { now: () => Date.now() },
        objectStore,
        sendTimeoutMs: 500,
        heartbeatIntervalMs: 200,
      },
    );

    expect(dispatchResult.outcome).toBe('settled');
    expect(transport.calls).toHaveLength(1);
    const sentMsg = transport.calls[0]?.msg as { kind: string; stream: unknown };
    expect(sentMsg.kind).toBe('image');
    expect(sentMsg.stream).toBeInstanceOf(Readable);
    expect(Buffer.isBuffer(sentMsg.stream)).toBe(false);

    await resolveAck(
      {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.created_at,
        leaseId,
        attemptNo: dispatchResult.attemptNo,
        publicId,
        outcome: dispatchResult.sendOutcome!,
        payloadKind: 'media',
        recipientHash: null,
        recipientJid: '15550009999@s.whatsapp.net',
      },
      { tenantDb, rng: { random: () => 0 } },
    );

    const ledger = await pool.query<{ price_key: string; rate_minor: string }>(
      'SELECT price_key, rate_minor FROM wallet_ledger WHERE client_id = $1',
      [clientId],
    );
    expect(ledger.rowCount).toBe(1);
    expect(ledger.rows[0]?.price_key).toBe('media');
    expect(ledger.rows[0]?.rate_minor).toBe('25');

    const assetRow = await pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM media_assets WHERE client_id = $1 AND id = $2',
      [clientId, mediaId],
    );
    expect(assetRow.rows[0]?.last_used_at).not.toBeNull();
  });
});
