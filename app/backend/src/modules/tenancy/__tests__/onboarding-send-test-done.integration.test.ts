import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { markLinkedConnected, type InstanceCtx } from '../../instances/repo.js';
import { createMessage } from '../../messages/messages.service.js';

/**
 * onboarding-send-test-done.integration.test.ts (P28 U5, item 2) - proves
 * the two onboarding advances this unit adds are wired into their real call
 * sites: `markLinkedConnected` (the engine's real link-transition write)
 * advances `connect_whatsapp` -> `send_test`, and `createMessage` (the real
 * enqueue service) advances `send_test` -> `done`. Both conditional,
 * monotonic, idempotent - never move a client backwards or advance past its
 * current step.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
const probeClientIds: string[] = [];

const PROBE_WORKER_ID = 'worker-onboarding-send-test-done-probe';

function makeOptoutPepperRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-onboarding-advance-optout-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0d).toString('base64');
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

const keyProvider = new FileKeyProvider({
  ringPath: makeOptoutPepperRing(),
  mountedPurposes: ['optout-pepper'],
});

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
  }
  probeClientIds.length = 0;
});

async function seedClient(step: string): Promise<string> {
  const clientId = randomUUID();
  probeClientIds.push(clientId);
  await pool.query(
    `INSERT INTO clients (id, company_name, slug, status, onboarding_step)
     VALUES ($1, $2, $3, 'active', $4)`,
    [
      clientId,
      `Onboarding Advance Probe ${clientId}`,
      `onboarding-advance-probe-${clientId}`,
      step,
    ],
  );
  return clientId;
}

async function seedInstanceWithLease(clientId: string): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'probe', 'unlinked', 'never_linked')
     -- client_id = $2`,
    [instanceId, clientId],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, 1, $3, now())`,
    [instanceId, clientId, PROBE_WORKER_ID],
  );
  return instanceId;
}

async function currentStep(clientId: string): Promise<string> {
  const result = await pool.query<{ onboarding_step: string }>(
    'SELECT onboarding_step FROM clients WHERE id = $1',
    [clientId],
  );
  return result.rows[0]!.onboarding_step;
}

describe('onboarding send_test/done advances (P28 U5, item 2)', () => {
  it('linking_the_first_number_advances_connect_whatsapp_to_send_test', async () => {
    const clientId = await seedClient('connect_whatsapp');
    const instanceId = await seedInstanceWithLease(clientId);
    const ctx: InstanceCtx = { clientId, sql: pool as unknown as InstanceCtx['sql'] };

    await markLinkedConnected(ctx, {
      instanceId,
      fence: 1n,
      workerId: PROBE_WORKER_ID,
      ownerJid: 'probe@s.whatsapp.net',
      phoneE164: '+15550000000',
    });
    expect(await currentStep(clientId)).toBe('send_test');

    // Idempotent: a second link event for the same client (e.g. a second
    // number) never re-fires or moves it further.
    await markLinkedConnected(ctx, {
      instanceId,
      fence: 1n,
      workerId: PROBE_WORKER_ID,
      ownerJid: 'probe@s.whatsapp.net',
      phoneE164: '+15550000000',
    });
    expect(await currentStep(clientId)).toBe('send_test');
  });

  it('a_done_client_stays_done_when_linking_a_number', async () => {
    const clientId = await seedClient('done');
    const instanceId = await seedInstanceWithLease(clientId);
    const ctx: InstanceCtx = { clientId, sql: pool as unknown as InstanceCtx['sql'] };

    await markLinkedConnected(ctx, {
      instanceId,
      fence: 1n,
      workerId: PROBE_WORKER_ID,
      ownerJid: 'probe@s.whatsapp.net',
      phoneE164: '+15550000000',
    });
    expect(await currentStep(clientId)).toBe('done');
  });

  it('the_first_message_advances_send_test_to_done', async () => {
    const clientId = await seedClient('send_test');
    const instanceId = await seedInstanceWithLease(clientId);
    await pool.query(
      `UPDATE whatsapp_instances SET link_state = 'linked', health_state = 'connected' WHERE id = $1`,
      [instanceId],
    );

    await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey: `onboarding-advance-${randomUUID()}`,
        requestBody: { hello: 'world' },
        recipient: { jid: '15550001111@s.whatsapp.net', e164: '+15550001111' },
        payload: { text: 'hello' },
        payloadKind: 'text',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider },
    );
    expect(await currentStep(clientId)).toBe('done');

    // A second message never re-fires (it stays 'done', never throws).
    await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey: `onboarding-advance-${randomUUID()}`,
        requestBody: { hello: 'again' },
        recipient: { jid: '15550002222@s.whatsapp.net', e164: '+15550002222' },
        payload: { text: 'hello again' },
        payloadKind: 'text',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider },
    );
    expect(await currentStep(clientId)).toBe('done');
  });

  it('a_client_at_attest_consent_is_not_advanced_by_a_message', async () => {
    const clientId = await seedClient('attest_consent');
    const instanceId = await seedInstanceWithLease(clientId);
    await pool.query(
      `UPDATE whatsapp_instances SET link_state = 'linked', health_state = 'connected' WHERE id = $1`,
      [instanceId],
    );

    await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey: `onboarding-advance-${randomUUID()}`,
        requestBody: { hello: 'world' },
        recipient: { jid: '15550003333@s.whatsapp.net', e164: '+15550003333' },
        payload: { text: 'hello' },
        payloadKind: 'text',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider },
    );
    expect(await currentStep(clientId)).toBe('attest_consent');
  });

  it('onboarding_never_moves_backwards', async () => {
    // A 'done' client sending another message stays 'done' (already covered
    // above); this asserts the SAME for a client whose step is somehow ahead
    // of what a stale/replayed link event would expect - markLinkedConnected
    // on a 'done' client (item 2's "a done_client stays done" test above)
    // already proves this for the connect_whatsapp->send_test advance. Here:
    // a client at 'send_test' receiving a link event must NOT be moved
    // further than send_test by the link-event path (only createMessage may
    // advance send_test->done).
    const clientId = await seedClient('send_test');
    const instanceId = await seedInstanceWithLease(clientId);
    const ctx: InstanceCtx = { clientId, sql: pool as unknown as InstanceCtx['sql'] };

    await markLinkedConnected(ctx, {
      instanceId,
      fence: 1n,
      workerId: PROBE_WORKER_ID,
      ownerJid: 'probe@s.whatsapp.net',
      phoneE164: '+15550000000',
    });
    expect(await currentStep(clientId)).toBe('send_test');
  });
});
