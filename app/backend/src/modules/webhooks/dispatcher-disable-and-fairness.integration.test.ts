import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import type { TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runDispatchTick } from './dispatcher.js';
import { patchWebhookEndpoint } from './service.js';
import { acceptingFetchStub } from './__tests__/webhooks-test-support.js';
import {
  makeKeyProvider,
  seedClientWithEndpoint,
  seedPendingDelivery,
  cleanupDispatcherRecords,
  fetchFnFor,
} from './__tests__/dispatcher-test-support.js';
import {
  startDispatcherFixtureServer,
  startHangingFixtureServer,
  type DispatcherFixtureServer,
} from './__tests__/dispatcher-fixture-server.js';
import type { SafeFetchOptions } from '../../platform/http/safe-fetch.js';
import type { DispatcherDeps } from './dispatcher.js';

/**
 * dispatcher-disable-and-fairness.integration.test.ts (P15 U5, step 7,
 * sibling of dispatcher.integration.test.ts - max-lines split, not a
 * behavioural boundary) - the auto-disable-at-20 path, the one-success-
 * resets-the-counter case, and the per-client in-flight cap (tenant
 * isolation, core invariant 4).
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'dispatcher-fairness-test',
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

describe('runDispatchTick - auto-disable at 20 consecutive failures', () => {
  it('twenty_consecutive_failures_disables_the_endpoint_with_an_audit_row', async () => {
    const server = await startDispatcherFixtureServer([422]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const seeded = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(server.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(seeded.clientId);

    const clock = { now: () => new Date('2026-09-02T12:00:00.000Z') };
    for (let i = 0; i < 19; i += 1) {
      await seedPendingDelivery(pool, {
        clientId: seeded.clientId,
        endpointId: seeded.endpointId,
        eventType: 'job.needs_user_action',
        payload: { jobPublicId: `job-${String(i)}`, reason: 'unresolved_send' },
      });
      await runDispatchTick({
        pool,
        keyProvider,
        clock,
        rng: () => 0.5,
        fetch: fetchFnFor(server.port),
      });
    }

    const beforeTwentieth = await pool.query<{ enabled: boolean; consecutive_failures: number }>(
      'SELECT enabled, consecutive_failures FROM webhook_endpoints WHERE id = $1',
      [seeded.endpointId],
    );
    expect(beforeTwentieth.rows[0]?.consecutive_failures).toBe(19);
    expect(beforeTwentieth.rows[0]?.enabled).toBe(true);

    await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-19', reason: 'unresolved_send' },
    });
    await runDispatchTick({
      pool,
      keyProvider,
      clock,
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    const after = await pool.query<{
      enabled: boolean;
      consecutive_failures: number;
      disabled_reason: string | null;
    }>(
      'SELECT enabled, consecutive_failures, disabled_reason FROM webhook_endpoints WHERE id = $1',
      [seeded.endpointId],
    );
    expect(after.rows[0]?.enabled).toBe(false);
    expect(after.rows[0]?.consecutive_failures).toBe(20);
    expect(after.rows[0]?.disabled_reason).toBe('consecutive_failures');

    const auditRows = await pool.query<{ action: string; target_id: string }>(
      `SELECT action, target_id FROM audit_logs WHERE client_id = $1 AND action = 'webhook.endpoint_disabled'`,
      [seeded.clientId],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]?.target_id).toBe(seeded.endpointId);
  });

  it('one_success_resets_consecutive_failures', async () => {
    const server = await startDispatcherFixtureServer([200]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const seeded = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(server.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(seeded.clientId);

    await pool.query('UPDATE webhook_endpoints SET consecutive_failures = 5 WHERE id = $1', [
      seeded.endpointId,
    ]);

    await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-ok', reason: 'unresolved_send' },
    });

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    const row = await pool.query<{ consecutive_failures: number; last_success_at: Date | null }>(
      'SELECT consecutive_failures, last_success_at FROM webhook_endpoints WHERE id = $1',
      [seeded.endpointId],
    );
    expect(row.rows[0]?.consecutive_failures).toBe(0);
    expect(row.rows[0]?.last_success_at).not.toBeNull();
  });

  it('re_enabling_after_a_disable_resets_the_counter_so_one_terminal_failure_never_instantly_redisables', async () => {
    // BUG FIX (P15 C1 FIX F7 / MAJ-5): PATCH {enabled:true} used to leave
    // `consecutive_failures=20`/`disabled_reason` set on re-enable, so the
    // NEXT single terminal failure instantly crossed the >= 20 threshold
    // again and re-disabled the endpoint - the documented RUNBOOK recovery
    // procedure ("re-enable, then verify with a test send") was broken.
    const server = await startDispatcherFixtureServer([422]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const seeded = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(server.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(seeded.clientId);

    // Disable it at the threshold directly (same end state the real
    // 20-consecutive-failures path reaches - this test is about the
    // RE-ENABLE transition, not re-proving the disable path itself).
    await pool.query(
      `UPDATE webhook_endpoints SET enabled = false, consecutive_failures = 20, disabled_reason = 'consecutive_failures'
        WHERE id = $1`,
      [seeded.endpointId],
    );

    const patched = await patchWebhookEndpoint(pool as unknown as TenantQueryable, {
      clientId: seeded.clientId,
      id: seeded.endpointId,
      enabled: true,
      fetchFn: acceptingFetchStub,
    });
    expect(patched?.enabled).toBe(true);
    expect(patched?.consecutiveFailures).toBe(0);
    expect(patched?.disabledReason).toBeNull();

    const afterReenable = await pool.query<{
      enabled: boolean;
      consecutive_failures: number;
      disabled_reason: string | null;
    }>(
      'SELECT enabled, consecutive_failures, disabled_reason FROM webhook_endpoints WHERE id = $1',
      [seeded.endpointId],
    );
    expect(afterReenable.rows[0]).toEqual({
      enabled: true,
      consecutive_failures: 0,
      disabled_reason: null,
    });

    // One terminal failure post-re-enable - counter goes to exactly 1, the
    // endpoint stays enabled (far below the 20 threshold).
    await seedPendingDelivery(pool, {
      clientId: seeded.clientId,
      endpointId: seeded.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'job-post-reenable', reason: 'unresolved_send' },
    });
    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    const afterOneFailure = await pool.query<{ enabled: boolean; consecutive_failures: number }>(
      'SELECT enabled, consecutive_failures FROM webhook_endpoints WHERE id = $1',
      [seeded.endpointId],
    );
    expect(afterOneFailure.rows[0]?.enabled).toBe(true);
    expect(afterOneFailure.rows[0]?.consecutive_failures).toBe(1);
  });
});

describe('runDispatchTick - per-client in-flight cap', () => {
  it('a_slow_endpoints_client_cannot_starve_another_clients_dispatch', async () => {
    const hangingServer = await startHangingFixtureServer();
    const fastServer = await startDispatcherFixtureServer([200]);
    liveServers.push(hangingServer, fastServer);
    const keyProvider = makeKeyProvider();

    const slowClient = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(hangingServer.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(slowClient.clientId);
    const fastClient = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(fastServer.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(fastClient.clientId);

    // 6 hung deliveries for the slow client (over the per-client cap of 4)
    // plus 1 for the fast client - the fast client's single delivery must
    // still complete within a bounded tick, never blocked behind the slow
    // client's backlog.
    for (let i = 0; i < 6; i += 1) {
      await seedPendingDelivery(pool, {
        clientId: slowClient.clientId,
        endpointId: slowClient.endpointId,
        eventType: 'job.needs_user_action',
        payload: { jobPublicId: `slow-${String(i)}`, reason: 'unresolved_send' },
      });
    }
    await seedPendingDelivery(pool, {
      clientId: fastClient.clientId,
      endpointId: fastClient.endpointId,
      eventType: 'job.needs_user_action',
      payload: { jobPublicId: 'fast-0', reason: 'unresolved_send' },
    });

    const fetchFn: DispatcherDeps['fetch'] = (url: string, options: SafeFetchOptions) => {
      const port = url.includes(`:${String(hangingServer.port)}/`)
        ? hangingServer.port
        : fastServer.port;
      return fetchFnFor(port)(url, options);
    };

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFn,
    });

    const fastRow = await pool.query<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE endpoint_id = $1',
      [fastClient.endpointId],
    );
    expect(fastRow.rows[0]?.status).toBe('sent');
  }, 10000);
});
