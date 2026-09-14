import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { sealWebhookSecret } from '../secret-codec.js';
import { WEBHOOK_SECRET_ENC_VERSION } from '../service.js';
import type { DispatcherDeps } from '../dispatcher.js';
import { safeFetch, type SafeFetchOptions } from '../../../platform/http/safe-fetch.js';
import { CA_CERT } from './dispatcher-fixture-server.js';

/**
 * dispatcher-test-support.ts (P15 U5, step 7, test-support only) - shared
 * seed/cleanup helpers for dispatcher.integration.test.ts. NOT itself a
 * test file. Same full-4-purpose-ring shape `webhooks-test-support.ts`
 * already establishes (the key-ring schema's `active` record is exhaustive
 * over `KEK_PURPOSES` - see that file's own doc comment).
 */

export function makeKeyProvider(): FileKeyProvider {
  const dir = mkdtempSync(join(tmpdir(), 'wp-webhooks-dispatcher-ring-'));
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
  return new FileKeyProvider({ ringPath: path, mountedPurposes: ['tenant-secrets'] });
}

interface TestPoolLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface SeededEndpoint {
  clientId: string;
  endpointId: string;
  secret: string;
}

/** Seeds one client (no membership/user needed - the dispatcher never authenticates) plus one enabled webhook endpoint subscribed to `events`. */
export async function seedClientWithEndpoint(
  pool: TestPoolLike,
  keyProvider: FileKeyProvider,
  url: string,
  events: string[],
): Promise<SeededEndpoint> {
  const clientId = randomUUID();
  const endpointId = randomUUID();
  const secret = `whsec_test_${randomUUID().replace(/-/g, '')}`;

  await pool.query(`INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)`, [
    clientId,
    `Dispatcher Test ${clientId}`,
    `dispatcher-test-${clientId}`,
  ]);

  const secretEnc = sealWebhookSecret(keyProvider, {
    clientId,
    endpointId,
    secret,
    encVersion: WEBHOOK_SECRET_ENC_VERSION,
  });

  await pool.query(
    `INSERT INTO webhook_endpoints (id, client_id, url, secret_enc, events, enabled)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [endpointId, clientId, url, secretEnc, events],
  );

  return { clientId, endpointId, secret };
}

/** Inserts one raw, already-`published_at`-set outbox row (bypasses `emit`/the drain loop) plus its `webhook_deliveries` row directly - for tests that only need the DISPATCHER's own behaviour, not the full drain->fanout path. */
export async function seedPendingDelivery(
  pool: TestPoolLike,
  input: {
    clientId: string;
    endpointId: string;
    eventType: string;
    payload: Record<string, unknown>;
    attempt?: number;
    nextAttemptAt?: Date;
  },
): Promise<{ deliveryId: string; outboxEventId: string }> {
  const outboxResult = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout, published_at)
     VALUES ($1, NULL, $2, $3, $4, NULL, ARRAY['webhook']::text[], now())
     RETURNING id`,
    [input.clientId, input.eventType, randomUUID(), JSON.stringify(input.payload)],
  );
  const outboxEventId = outboxResult.rows[0]?.id;
  if (!outboxEventId) throw new Error('seedPendingDelivery: outbox insert returned no id');

  const deliveryResult = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (client_id, outbox_event_id, endpoint_id, event_type, payload_hash, status, attempt, next_attempt_at)
     VALUES ($1, $2, $3, $4, decode('00', 'hex'), 'pending', $5, $6)
     RETURNING id`,
    [
      input.clientId,
      outboxEventId,
      input.endpointId,
      input.eventType,
      input.attempt ?? 0,
      input.nextAttemptAt ?? new Date(),
    ],
  );
  const deliveryId = deliveryResult.rows[0]?.id;
  if (!deliveryId) throw new Error('seedPendingDelivery: delivery insert returned no id');

  return { deliveryId, outboxEventId };
}

export async function cleanupDispatcherRecords(
  pool: TestPoolLike,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM webhook_deliveries WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM webhook_endpoints WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}

export type { TenantDb };

/** A `DispatcherDeps['fetch']` wrapping the REAL `safeFetch`, pinned via `devAllowedTargets`/`ca` at the local fixture server's `port` - the dispatcher's actual HTTP path runs end to end, only the network target is local. */
export function fetchFnFor(port: number): DispatcherDeps['fetch'] {
  return (url: string, options: SafeFetchOptions) =>
    safeFetch(url, {
      ...options,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      devAllowedTargets: [`safe-fetch.test.local:${String(port)}`, 'safe-fetch.test.local'],
      ca: CA_CERT,
      connectTimeoutMs: 1000,
      totalTimeoutMs: 1500,
    });
}

/** Routes to whichever of two fixture servers a URL's port matches - the two-endpoint tests' own dispatch fan-out shape. */
export function fetchFnByPort(portA: number, portB: number): DispatcherDeps['fetch'] {
  return (url: string, options: SafeFetchOptions) => {
    const port = url.includes(`:${String(portA)}/`) ? portA : portB;
    return fetchFnFor(port)(url, options);
  };
}
