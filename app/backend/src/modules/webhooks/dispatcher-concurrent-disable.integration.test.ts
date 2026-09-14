import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runDispatchTick } from './dispatcher.js';
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
 * dispatcher-concurrent-disable.integration.test.ts (P15 C2 hardening pass,
 * sibling of dispatcher-disable-and-fairness.integration.test.ts - max-lines
 * split) - proves the disable-at-20 counter is race-safe when TWO
 * `runDispatchTick` calls run truly concurrently (`Promise.all`, mirroring
 * `roles/relay.integration.test.ts`'s own
 * `two_relay_processes_publish_each_event_exactly_once` idiom) against
 * pending deliveries for the SAME endpoint. `incrementEndpointFailures` is a
 * single `UPDATE ... SET consecutive_failures = consecutive_failures + 1
 * RETURNING` (repo.ts) - an atomic row-level increment, never an app-level
 * read-modify-write - so this is the storage-level invariant this test
 * checks: the FINAL count is exactly the number of terminal outcomes
 * (never under-counted by a lost update), and the endpoint is disabled with
 * EXACTLY ONE audit row (never double-disabled) even though both ticks'
 * `applyTerminalOutcome` calls independently read `health.enabled` after
 * their own increment and could otherwise both decide to disable.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'dispatcher-concurrent-disable-test',
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

describe('runDispatchTick - concurrent disable-at-20 is race-safe', () => {
  it('twenty_concurrently_claimed_terminal_failures_disable_the_endpoint_exactly_once', async () => {
    const server = await startDispatcherFixtureServer(Array(20).fill(422) as number[]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const seeded = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(server.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(seeded.clientId);

    // 20 independent pending deliveries, each individually terminal (422) -
    // every one increments consecutive_failures by exactly 1 on its own
    // dispatch. claimDueDeliveries' SKIP LOCKED + next_attempt_at bump
    // (repo.ts) means two concurrent ticks claim disjoint subsets of these
    // 20 rows.
    for (let i = 0; i < 20; i += 1) {
      await seedPendingDelivery(pool, {
        clientId: seeded.clientId,
        endpointId: seeded.endpointId,
        eventType: 'job.needs_user_action',
        payload: { jobPublicId: `job-${String(i)}`, reason: 'unresolved_send' },
      });
    }

    const clock = { now: () => new Date('2026-09-02T12:00:00.000Z') };
    const fetchFn = fetchFnFor(server.port);

    // Two ticks racing over the SAME 20-row backlog, each with a limit
    // large enough to claim everything it can grab via SKIP LOCKED.
    const [claimedA, claimedB] = await Promise.all([
      runDispatchTick({ pool, keyProvider, clock, rng: () => 0.5, fetch: fetchFn, limit: 20 }),
      runDispatchTick({ pool, keyProvider, clock, rng: () => 0.5, fetch: fetchFn, limit: 20 }),
    ]);
    // Claim exclusivity: 20 logical deliveries, claimed exactly once each
    // across the two racing ticks (never the SAME row claimed by both -
    // this is the regression this test proves fixed).
    expect(claimedA + claimedB).toBe(20);
    expect(server.requests).toHaveLength(20);

    const after = await pool.query<{
      enabled: boolean;
      consecutive_failures: number;
      disabled_reason: string | null;
    }>(
      'SELECT enabled, consecutive_failures, disabled_reason FROM webhook_endpoints WHERE id = $1',
      [seeded.endpointId],
    );
    // Exact count - never under-counted by a lost update across the two
    // concurrent transactions.
    expect(after.rows[0]?.consecutive_failures).toBe(20);
    expect(after.rows[0]?.enabled).toBe(false);
    expect(after.rows[0]?.disabled_reason).toBe('consecutive_failures');

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND action = 'webhook.endpoint_disabled'`,
      [seeded.clientId],
    );
    // Never double-disabled: exactly one audit row despite both ticks being
    // able to observe consecutiveFailures >= 20 independently.
    expect(auditRows.rows).toHaveLength(1);

    const deliveryRows = await pool.query<{ status: string; attempt: number }>(
      'SELECT status, attempt FROM webhook_deliveries WHERE endpoint_id = $1',
      [seeded.endpointId],
    );
    expect(deliveryRows.rows).toHaveLength(20);
    for (const row of deliveryRows.rows) {
      expect(row.status).toBe('failed');
      // attempt=1, never 2 - each row was dispatched exactly once, not by
      // both racing ticks.
      expect(row.attempt).toBe(1);
    }
  }, 15000);
});
