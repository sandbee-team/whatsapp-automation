import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { verifyWebhookSignature } from './sign.js';
import { runDispatchTick } from './dispatcher.js';
import {
  makeKeyProvider,
  seedClientWithEndpoint,
  seedPendingDelivery,
  cleanupDispatcherRecords,
  fetchFnFor,
  fetchFnByPort,
} from './__tests__/dispatcher-test-support.js';
import {
  startDispatcherFixtureServer,
  type DispatcherFixtureServer,
} from './__tests__/dispatcher-fixture-server.js';

/**
 * dispatcher.integration.test.ts (P15 U5, step 7) - the durable dispatcher's
 * own tick against real Postgres, a real signed HTTPS delivery, and an
 * injected clock/rng for deterministic backoff assertions (never wall-clock,
 * per this repo's own mechanical convention). `fetchFnFor`/`fetchFnByPort`
 * (shared `__tests__/dispatcher-test-support.ts`) wrap the REAL `safeFetch`
 * pinned at a local fixture server - the dispatcher's ACTUAL HTTP path runs
 * end to end. Auto-disable/reset/fairness cases live in the sibling
 * `dispatcher-disable-and-fairness.integration.test.ts` (max-lines split).
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'dispatcher-test',
});

let seededClientIds: string[] = [];
let liveServers: DispatcherFixtureServer[] = [];

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupDispatcherRecords(pool, seededClientIds);
  seededClientIds = [];
  await Promise.all(liveServers.map((s) => s.close()));
  liveServers = [];
});

describe('runDispatchTick - the phase demo', () => {
  it('a_live_endpoint_receives_a_signed_send_event_and_verifies_it', async () => {
    const server = await startDispatcherFixtureServer([200]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const url = `https://safe-fetch.test.local:${String(server.port)}/hooks`;
    const seeded = await seedClientWithEndpoint(pool, keyProvider, url, [
      'message.job.status_changed',
    ]);
    seededClientIds.push(seeded.clientId);

    await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'message.job.status_changed',
      payload: { jobPublicId: 'job-demo', instanceId: seeded.clientId, status: 'sent' },
    });

    const now = new Date('2026-09-02T12:00:00.000Z');
    const claimed = await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => now },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });
    expect(claimed).toBe(1);

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe('POST');
    const sigHeader = request.headers['x-wp-signature'] ?? '';
    const eventIdHeader = request.headers['x-wp-event-id'] ?? '';
    const timestampHeader = request.headers['x-wp-timestamp'] ?? '';
    expect(sigHeader).toMatch(/^v1,t=\d+,s=[0-9a-f]{64}$/);
    expect(eventIdHeader.length).toBeGreaterThan(0);
    expect(timestampHeader).toBe(String(Math.floor(now.getTime() / 1000)));

    const sigMatch = /^v1,t=(\d+),s=([0-9a-f]{64})$/.exec(sigHeader);
    expect(sigMatch).not.toBeNull();
    const [, tRaw, sig] = sigMatch!;
    const verified = verifyWebhookSignature({
      secret: seeded.secret,
      timestamp: Number(tRaw),
      signature: sig!,
      body: request.body,
      now,
    });
    expect(verified).toBe(true);

    const row = await pool.query<{ status: string; status_code: number }>(
      'SELECT status, status_code FROM webhook_deliveries WHERE endpoint_id = $1',
      [seeded.endpointId],
    );
    expect(row.rows[0]?.status).toBe('sent');
    expect(row.rows[0]?.status_code).toBe(200);
  });
});

describe('runDispatchTick - durable-first', () => {
  it('the_delivery_row_is_written_before_the_http_call', async () => {
    const server = await startDispatcherFixtureServer([200]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const url = `https://safe-fetch.test.local:${String(server.port)}/hooks`;
    const seeded = await seedClientWithEndpoint(pool, keyProvider, url, ['job.needs_user_action']);
    seededClientIds.push(seeded.clientId);

    const { deliveryId } = await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-crash', reason: 'unresolved_send' },
    });

    // The row already exists BEFORE the tick even runs (invariant 1,
    // durable-first) - assert that directly, then run the tick and assert
    // the SAME row (never a new one) transitions to 'sent'.
    const before = await pool.query<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE id = $1',
      [deliveryId],
    );
    expect(before.rows[0]?.status).toBe('pending');

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    const after = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM webhook_deliveries WHERE endpoint_id = $1',
      [seeded.endpointId],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.id).toBe(deliveryId);
    expect(after.rows[0]?.status).toBe('sent');
  });
});

describe('runDispatchTick - terminal vs retryable classification', () => {
  it('a_422_is_terminal_and_a_500_retries_with_capped_jittered_backoff', async () => {
    const terminalServer = await startDispatcherFixtureServer([422]);
    const retryServer = await startDispatcherFixtureServer([500]);
    liveServers.push(terminalServer, retryServer);
    const keyProvider = makeKeyProvider();

    const terminalSeed = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(terminalServer.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(terminalSeed.clientId);
    await seedPendingDelivery(pool, {
      clientId: terminalSeed.clientId,
      endpointId: terminalSeed.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-422', reason: 'unresolved_send' },
    });

    const retrySeed = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(retryServer.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(retrySeed.clientId);
    await seedPendingDelivery(pool, {
      clientId: retrySeed.clientId,
      endpointId: retrySeed.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-500', reason: 'unresolved_send' },
      attempt: 3,
    });

    const now = new Date('2026-09-02T12:00:00.000Z');
    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => now },
      rng: () => 1.0,
      fetch: fetchFnByPort(terminalServer.port, retryServer.port),
    });

    const terminalRow = await pool.query<{
      status: string;
      status_code: number;
      attempt: number;
    }>('SELECT status, status_code, attempt FROM webhook_deliveries WHERE endpoint_id = $1', [
      terminalSeed.endpointId,
    ]);
    expect(terminalRow.rows[0]?.status).toBe('failed');
    expect(terminalRow.rows[0]?.status_code).toBe(422);
    expect(terminalRow.rows[0]?.attempt).toBe(1);

    // attempt was 3 before this call -> cap = min(6h, 2s*2^3) = 16_000ms;
    // rng=1.0 -> exactly 16_000ms later, next_attempt_at is EXACT.
    const retryRow = await pool.query<{
      status: string;
      status_code: number;
      attempt: number;
      next_attempt_at: Date;
    }>(
      'SELECT status, status_code, attempt, next_attempt_at FROM webhook_deliveries WHERE endpoint_id = $1',
      [retrySeed.endpointId],
    );
    expect(retryRow.rows[0]?.status).toBe('pending');
    expect(retryRow.rows[0]?.status_code).toBe(500);
    expect(retryRow.rows[0]?.attempt).toBe(4);
    expect(retryRow.rows[0]?.next_attempt_at.getTime()).toBe(now.getTime() + 16_000);
  });
});
