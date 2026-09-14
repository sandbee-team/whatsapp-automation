import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runDispatchTick } from './dispatcher.js';
import { MAX_ATTEMPTS } from './backoff.js';
import {
  makeKeyProvider,
  seedClientWithEndpoint,
  seedPendingDelivery,
  cleanupDispatcherRecords,
  fetchFnFor,
} from './__tests__/dispatcher-test-support.js';
import {
  startDispatcherFixtureServer,
  type DispatcherFixtureServer,
} from './__tests__/dispatcher-fixture-server.js';

/**
 * dispatcher-max-attempts-boundary.integration.test.ts (P15 C2 hardening
 * pass, sibling of dispatcher.integration.test.ts - max-lines split) - the
 * exact off-by-one boundary on `row.attempt + 1 >= MAX_ATTEMPTS`
 * (dispatcher.ts's `applyTerminalOutcome` gate). `MAX_ATTEMPTS=8`: the 7th
 * dispatch of a retryable (500) delivery (`attempt=6` going in) must still
 * SCHEDULE a retry; the 8th dispatch (`attempt=7` going in) must be the
 * TERMINAL one - this is the "8th failure FAILED or scheduled again" case
 * from the hunt list, asserted at the exact boundary, never a bound.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'dispatcher-max-attempts-test',
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

describe('runDispatchTick - MAX_ATTEMPTS exhaustion boundary', () => {
  it('the_seventh_dispatch_at_attempt_6_still_retries_a_500', async () => {
    expect(MAX_ATTEMPTS).toBe(8);
    const server = await startDispatcherFixtureServer([500]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const seeded = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(server.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(seeded.clientId);

    await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-attempt-6', reason: 'unresolved_send' },
      attempt: 6,
    });

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    const row = await pool.query<{ status: string; attempt: number }>(
      'SELECT status, attempt FROM webhook_deliveries WHERE endpoint_id = $1',
      [seeded.endpointId],
    );
    // attempt 6 -> 7+1=7 >= 8 is false: still retries. Row moves to
    // attempt=7, stays pending (never failed).
    expect(row.rows[0]?.status).toBe('pending');
    expect(row.rows[0]?.attempt).toBe(7);
  });

  it('the_eighth_dispatch_at_attempt_7_is_terminal_even_for_a_500', async () => {
    const server = await startDispatcherFixtureServer([500]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const seeded = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(server.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(seeded.clientId);

    await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-attempt-7', reason: 'unresolved_send' },
      attempt: 7,
    });

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    const row = await pool.query<{ status: string; attempt: number; error_class: string | null }>(
      'SELECT status, attempt, error_class FROM webhook_deliveries WHERE endpoint_id = $1',
      [seeded.endpointId],
    );
    // attempt 7 -> 7+1=8 >= 8 is true: terminal even though 500 is normally
    // retryable - MAX_ATTEMPTS exhaustion, not status-class terminality,
    // drives this outcome. attempt still increments to 8 (the schema's own
    // CHECK ceiling), status flips to failed, never retried again.
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.attempt).toBe(8);
    expect(row.rows[0]?.error_class).toBe('http_500');
  });
});
