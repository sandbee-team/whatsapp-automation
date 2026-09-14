import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, createTenantDb } from '@wp/db';
import { FileKeyProvider, type KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createMessage, type CreateMessageServiceInput } from './messages.service.js';

/**
 * messages.publish-wake.integration.test.ts (P11 Unit U5, step 8) - proves
 * `createMessage` calls its injected `onEnqueued`/wake port EXACTLY ONCE,
 * and only AFTER `tenantDb.withTenant`'s own promise has already resolved
 * (i.e. after the enqueue transaction has committed) - never from inside
 * the transaction callback itself. Real Postgres (not a mocked `TenantDb`):
 * the property under test is specifically about ordering relative to a
 * REAL commit, not just "this callback ran after that other callback" in a
 * fake.
 */

type TestPool = ReturnType<typeof createPool>;

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'publish-wake-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM delivery_event_ids WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM message_job_refs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
  }
  probeClientIds = [];
});

async function seedTenant(): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Publish Wake Probe Client',
    `publish-wake-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    'INSERT INTO wallet_accounts (client_id, balance_minor, state, max_rate_minor) VALUES ($1, $2, $3, $4)',
    [clientId, 100_000, 'active', 100],
  );
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'publish-wake-probe', 'linked', 'connected')`,
    [instanceId, clientId],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

function baseInput(clientId: string, instanceId: string): CreateMessageServiceInput {
  return {
    clientId,
    instanceId,
    idempotencyKey: randomUUID(),
    requestBody: { hello: 'world' },
    recipient: { jid: '15550000000@s.whatsapp.net', e164: '+15550000000' },
    payload: { text: 'hi' },
    payloadKind: 'text',
    priority: 'normal',
    scheduledAt: null,
    sendOrigin: 'api_send',
  };
}

/** Same "distinct kekId per purpose" fixture ring idiom as `optout/registry.integration.test.ts`'s own `makeOptoutPepperRing` - `active` must list all four `KEK_PURPOSES` (see `enqueue-test-support.ts#makeOptoutPepperRing`'s own doc comment for why). */
function makeKeyProvider(): KeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-publish-wake-optout-ring-'));
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
  return new FileKeyProvider({ ringPath: path, mountedPurposes: ['optout-pepper'] });
}

describe('createMessage - publish-after-commit wake', () => {
  it('an_enqueue_publishes_exactly_one_wake_after_the_transaction_commits', async () => {
    const { clientId, instanceId } = await seedTenant();
    const tenantDb = createTenantDb(pool);

    const calls: { clientId: string; instanceId: string; committedRowVisible: boolean }[] = [];
    const keyProvider = makeKeyProvider();

    const result = await createMessage(tenantDb, baseInput(clientId, instanceId), {
      keyProvider,
      onEnqueued: async (event) => {
        // Proves the wake fires AFTER commit: a FRESH connection (never the
        // in-transaction `tx` handle) must already see the row.
        const row = await pool.query('SELECT 1 FROM message_jobs WHERE client_id = $1', [
          event.clientId,
        ]);
        calls.push({
          clientId: event.clientId,
          instanceId: event.instanceId,
          committedRowVisible: (row.rowCount ?? 0) > 0,
        });
      },
    });

    expect(result.status).toBe('queued');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ clientId, instanceId, committedRowVisible: true });
  });

  it('a_replayed_idempotent_enqueue_still_publishes_exactly_one_wake', async () => {
    const { clientId, instanceId } = await seedTenant();
    const tenantDb = createTenantDb(pool);
    const input = baseInput(clientId, instanceId);
    const keyProvider = makeKeyProvider();

    let publishCount = 0;
    const onEnqueued = async (): Promise<void> => {
      publishCount += 1;
    };

    await createMessage(tenantDb, input, { keyProvider, onEnqueued });
    await createMessage(tenantDb, input, { keyProvider, onEnqueued });

    // A replay (same idempotency key + same body) is still a completed
    // enqueue call from the caller's point of view - each call publishes
    // its own wake exactly once (never zero, and the resume/wake path is
    // deliberately idempotent-tolerant downstream: a duplicate wake is
    // only ever a hint, per this module's own invariant).
    expect(publishCount).toBe(2);
  });

  it('onEnqueued_is_never_called_when_the_transaction_throws', async () => {
    const { clientId, instanceId } = await seedTenant();
    const tenantDb = createTenantDb(pool);
    const keyProvider = makeKeyProvider();

    let publishCount = 0;
    const onEnqueued = async (): Promise<void> => {
      publishCount += 1;
    };

    // An unknown instance id throws InstanceNotFoundError before the
    // transaction ever writes a job row - onEnqueued must not fire.
    await expect(
      createMessage(
        tenantDb,
        { ...baseInput(clientId, instanceId), instanceId: randomUUID() },
        { keyProvider, onEnqueued },
      ),
    ).rejects.toThrow();

    expect(publishCount).toBe(0);
  });
});
