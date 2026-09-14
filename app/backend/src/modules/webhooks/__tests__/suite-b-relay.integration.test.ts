import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { drainOnce, type BatchPublisherPort } from '../../events/relay-loop.js';
import { createWebhookFanoutPort } from '../repo.js';
import { runDispatchTick } from '../dispatcher.js';
import {
  makeKeyProvider,
  seedClientWithEndpoint,
  cleanupDispatcherRecords,
  fetchFnByPort,
} from './dispatcher-test-support.js';
import {
  startDispatcherFixtureServer,
  type DispatcherFixtureServer,
} from './dispatcher-fixture-server.js';

/**
 * suite-b-relay.integration.test.ts (P15 U5, step 7) - isolation suite B,
 * extended: two tenants' events run through the FULL background path (raw
 * outbox row -> `drainOnce` claim+fanout -> `webhook_deliveries` ->
 * `runDispatchTick` claim+sign+dispatch) CONCURRENTLY and never cross. Same
 * placement convention as `modules/realtime/__tests__/suite-b-sse.test.ts`
 * (module-local `__tests__/`, not a repo-root `test/isolation/` tree - that
 * directory does not exist in this repo; the analogous existing location is
 * this one) - `.integration.test.ts` because this suite needs real Postgres
 * (drain claim + dispatcher claim), unlike the pure-hub `suite-b-sse.test.ts`.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'suite-b-relay-test',
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

function noOpPublisher(): BatchPublisherPort {
  return { publishBatch: () => undefined };
}

function noOpMetrics() {
  return {
    setOutboxDepth: () => undefined,
    observePublishLagSeconds: () => undefined,
    incrementEventsPublished: () => undefined,
    incrementSseCoalesced: () => undefined,
    incrementDropped: () => undefined,
    incrementPoisoned: () => undefined,
  };
}

describe('isolation suite B - relay + dispatcher as background paths', () => {
  it('two_tenants_events_never_cross_in_relay_or_webhook_output', async () => {
    const serverA = await startDispatcherFixtureServer([200]);
    const serverB = await startDispatcherFixtureServer([200]);
    liveServers.push(serverA, serverB);
    const keyProvider = makeKeyProvider();

    const tenantA = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(serverA.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(tenantA.clientId);
    const tenantB = await seedClientWithEndpoint(
      pool,
      keyProvider,
      `https://safe-fetch.test.local:${String(serverB.port)}/hooks`,
      ['job.needs_user_action'],
    );
    seededClientIds.push(tenantB.clientId);

    // Raw outbox rows (bypassing emit() - this suite proves the RELAY's own
    // isolation, not emit's, matching relay-test-helpers.ts's own
    // precedent) - 10 interleaved events per tenant, webhook-only fanout.
    for (let i = 0; i < 10; i += 1) {
      await pool.query(
        `INSERT INTO outbox_events (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout)
         VALUES ($1, NULL, 'job.needs_user_action', $2, $3, NULL, ARRAY['webhook']::text[])`,
        [
          tenantA.clientId,
          `jobA-${String(i)}`,
          JSON.stringify({ jobPublicId: `jobA-${String(i)}`, reason: 'unresolved_send' }),
        ],
      );
      await pool.query(
        `INSERT INTO outbox_events (client_id, instance_id, event_type, entity_id, payload, coalesce_key, fanout)
         VALUES ($1, NULL, 'job.needs_user_action', $2, $3, NULL, ARRAY['webhook']::text[])`,
        [
          tenantB.clientId,
          `jobB-${String(i)}`,
          JSON.stringify({ jobPublicId: `jobB-${String(i)}`, reason: 'unresolved_send' }),
        ],
      );
    }

    const routedFetch = fetchFnByPort(serverA.port, serverB.port);

    // Drain (claim + fanout to webhook_deliveries) and a first dispatch tick
    // run CONCURRENTLY - the same interleaving a real relay process/
    // dispatcher loop pair produces. A second dispatch tick below picks up
    // whatever the first one raced past (the drain may not have written
    // every delivery row before the first claim ran) - every delivery
    // converges to 'sent' either way, deterministically, no sleep.
    await Promise.all([
      drainOnce({
        pool,
        publisher: noOpPublisher(),
        metrics: noOpMetrics(),
        clock: { now: () => new Date() },
        webhookFanout: createWebhookFanoutPort(),
      }),
      runDispatchTick({
        pool,
        keyProvider,
        clock: { now: () => new Date() },
        rng: () => 0.5,
        fetch: routedFetch,
      }),
    ]);

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date() },
      rng: () => 0.5,
      fetch: routedFetch,
    });

    // Every request the A fixture server received carries only A's job ids;
    // every request B's fixture server received carries only B's job ids -
    // zero cross-tenant delivery.
    const bodiesA = serverA.requests.map((r) => JSON.parse(r.body) as { jobPublicId?: string });
    const bodiesB = serverB.requests.map((r) => JSON.parse(r.body) as { jobPublicId?: string });
    expect(bodiesA.length).toBeGreaterThan(0);
    expect(bodiesB.length).toBeGreaterThan(0);
    for (const body of bodiesA) {
      expect(String(body.jobPublicId ?? '')).toMatch(/^jobA-/);
    }
    for (const body of bodiesB) {
      expect(String(body.jobPublicId ?? '')).toMatch(/^jobB-/);
    }

    // Storage-layer confirmation: every delivery row for tenant A's
    // endpoint carries tenant A's client_id, and likewise for B - the
    // per-row client_id column never crosses (RLS + explicit predicate,
    // core invariant 4).
    const deliveries = await pool.query<{ client_id: string; endpoint_id: string }>(
      'SELECT client_id, endpoint_id FROM webhook_deliveries WHERE client_id = ANY($1)',
      [[tenantA.clientId, tenantB.clientId]],
    );
    for (const row of deliveries.rows) {
      if (row.endpoint_id === tenantA.endpointId) {
        expect(row.client_id).toBe(tenantA.clientId);
      } else if (row.endpoint_id === tenantB.endpointId) {
        expect(row.client_id).toBe(tenantB.clientId);
      }
    }
  }, 15000);
});
