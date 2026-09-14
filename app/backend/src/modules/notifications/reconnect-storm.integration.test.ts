import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { BatchFrame } from '@wp/contracts';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { onConnectionUpdate, type FastLaneCtx } from '../pacing/health/fast-lane.js';
import { notify } from './notify.js';
import { bindNotificationMetrics } from '../../platform/metrics/notification-metrics.js';
import { drainOnce, type BatchPublisherPort } from '../events/index.js';
import { createWebhookFanoutPort } from '../webhooks/repo.js';
import { runDispatchTick } from '../webhooks/dispatcher.js';
import { createRelayEmailFanoutPort } from './dispatch/relay-email-fanout.js';
import { sealWebhookSecret } from '../webhooks/secret-codec.js';
import { WEBHOOK_SECRET_ENC_VERSION } from '../webhooks/service.js';
import {
  makeKeyProvider,
  cleanupDispatcherRecords,
  fetchFnFor,
} from '../webhooks/__tests__/dispatcher-test-support.js';
import {
  startDispatcherFixtureServer,
  type DispatcherFixtureServer,
} from '../webhooks/__tests__/dispatcher-fixture-server.js';
import {
  seedNotifyTenant,
  cleanupNotifyFixtures,
  listMailpitMessages,
  clearMailpitMessages,
  type TestPool,
} from './__tests__/notifications-test-support.js';

/**
 * reconnect-storm.integration.test.ts (P17 U7, amended) - the phase demo
 * through the REAL wired path: a 40x hard-restriction disconnect storm is
 * absorbed by `hard-signal-pause.ts`'s own conditional-UPDATE pause
 * idempotency BEFORE `notify()` ever runs (calls 2-40 return
 * `{paused:false}`, `fast-lane.ts#onConnectionUpdate`), so `notify()`'s own
 * `ON CONFLICT` dedupe never fires for a same-reason pause storm - the
 * acceptance criteria are amended accordingly (plan/v1/P17 test table); this
 * file does not "fix" production, production is correct as landed.
 *
 * CASE 1 drives the real wired path end to end (fast-lane -> hard-signal-
 * pause -> notify -> outbox -> relay drain -> real mailpit email + real
 * local-HTTPS webhook receiver + captured SSE batch). CASE 2 proves the
 * OTHER half of the same idempotency claim: `notify()`'s own DB-level dedupe
 * constraint is the authority under true concurrency (40 concurrent calls,
 * one transitionId, one connection each) - exact conservation from this
 * run's own 40 calls, not an ambient sample (allowed under the flaky-class
 * rule).
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'reconnect-storm-test',
});
let tenantDb: TenantDb;

let seededClientIds: string[] = [];
let liveServers: DispatcherFixtureServer[] = [];

beforeEach(() => {
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (seededClientIds.length > 0) {
    // fast-lane's onConnectionUpdate requires an instance_pacing_state row -
    // not covered by cleanupNotifyFixtures (that helper's own scope predates
    // this file's pacing-state seed) and has no ON DELETE CASCADE from
    // whatsapp_instances, so it must be cleared before that helper's own
    // DELETE FROM whatsapp_instances runs.
    await pool.query('DELETE FROM pacing_events WHERE client_id = ANY($1)', [seededClientIds]);
    await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [
      seededClientIds,
    ]);
  }
  await cleanupNotifyFixtures(pool, seededClientIds);
  await cleanupDispatcherRecords(pool, seededClientIds);
  // `forty_reconnects...` drives the REAL Redis-backed hourly email cap
  // counter (`createRelayEmailFanoutPort`), INCR+EXPIRE on
  // `tenantKey(env, clientId, 'notify', 'email', 'hourly')`, 1h TTL - no
  // cleanup helper here knew about this store (P16 lesson). Scoped delete.
  if (seededClientIds.length > 0) {
    const redis = createRedis(resolveRedisUrl());
    try {
      const capKeys = seededClientIds.map((clientId) =>
        tenantKey('test', clientId, 'notify', 'email', 'hourly'),
      );
      await redis.del(...capKeys);
    } finally {
      await redis.quit();
    }
  }
  seededClientIds = [];
  await Promise.all(liveServers.map((s) => s.close()));
  liveServers = [];
  await clearMailpitMessages();
});

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

function capturingPublisher(): BatchPublisherPort & { frames: BatchFrame[] } {
  const frames: BatchFrame[] = [];
  return {
    frames,
    publishBatch: (_clientId, _instanceId, frame) => {
      frames.push(frame);
    },
  };
}

async function readDedupedCount(): Promise<number> {
  const snapshot = await bindNotificationMetrics().notifyDedupedTotal.get();
  return snapshot.values.find((v) => v.labels['kind'] === 'instance_paused')?.value ?? 0;
}

const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

describe('reconnect storm (P17 U7, amended, real Postgres/Redis/mailpit)', () => {
  it('forty_reconnects_and_one_pause_still_send_exactly_one_email', async () => {
    const server = await startDispatcherFixtureServer([200]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const receiverUrl = `https://safe-fetch.test.local:${String(server.port)}/hooks`;

    const tenant = await seedNotifyTenant(pool, { instanceLabel: 'Storm Test Number' });
    seededClientIds.push(tenant.clientId);
    await pool.query(
      `INSERT INTO instance_pacing_state (
         instance_id, client_id, pacing_timezone, warmup_tier, health_band,
         eff_daily_cap, eff_hourly_cap, eff_new_conv_cap,
         eff_gap_min_ms, eff_gap_max_ms, eff_cold_ratio_max, eff_cold_ratio_floor,
         eff_window_start_local, eff_window_end_local, eff_group_daily_cap
       ) VALUES ($1, $2, 'Asia/Kolkata', 1, 'healthy', 20, 6, 8, 15000, 180000, 0.4, 5, '00:00:00', '23:59:59', 0)`,
      [tenant.instanceId, tenant.clientId],
    );

    const endpointId = randomUUID();
    const secretEnc = sealWebhookSecret(keyProvider, {
      clientId: tenant.clientId,
      endpointId,
      secret: `whsec_test_${randomUUID().replace(/-/g, '')}`,
      encVersion: WEBHOOK_SECRET_ENC_VERSION,
    });
    await pool.query(
      `INSERT INTO webhook_endpoints (id, client_id, url, secret_enc, events, enabled)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [endpointId, tenant.clientId, receiverUrl, secretEnc, ['notification.created']],
    );

    const before = await readDedupedCount();

    const results: boolean[] = [];
    for (let i = 0; i < 40; i += 1) {
      const outcome = await tenantDb.withTenant(tenant.clientId, (tx) => {
        const ctx: FastLaneCtx = {
          sql: tx,
          clientId: tenant.clientId,
          clock: { now: () => NOW_MS },
        };
        return onConnectionUpdate(ctx, { instanceId: tenant.instanceId, disconnectCode: 403 });
      });
      results.push(outcome.paused);
    }

    expect(results).toEqual([true, ...Array(39).fill(false)]);

    const notificationRows = await pool.query<{ id: string }>(
      "SELECT id FROM notifications WHERE client_id = $1 AND kind = 'instance_paused'",
      [tenant.clientId],
    );
    expect(notificationRows.rows).toHaveLength(1);
    const notificationId = notificationRows.rows[0]?.id;

    const outboxRows = await pool.query<{ fanout: string[] }>(
      "SELECT fanout FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created'",
      [tenant.clientId],
    );
    expect(outboxRows.rows).toHaveLength(3);
    expect(outboxRows.rows.map((r) => r.fanout[0]).sort()).toEqual(['email', 'sse', 'webhook']);

    // The storm dedupes entirely at the pause layer (fast-lane's own
    // conditional-UPDATE idempotency) - notify() is only ever called ONCE,
    // on the single real transition, so notifyDedupedTotal never moves.
    const after = await readDedupedCount();
    expect(after - before).toBe(0);

    const redis = createRedis(resolveRedisUrl());
    try {
      const publisher = capturingPublisher();
      await drainOnce({
        pool,
        publisher,
        metrics: noOpMetrics(),
        clock: { now: () => new Date() },
        webhookFanout: createWebhookFanoutPort(),
        emailFanout: createRelayEmailFanoutPort(redis, 'test'),
      });

      await runDispatchTick({
        pool,
        keyProvider,
        clock: { now: () => new Date() },
        rng: () => 0.5,
        fetch: fetchFnFor(server.port),
      });

      const mailboxMessages = await listMailpitMessages();
      const mine = mailboxMessages.filter((m) =>
        m.To.some((to) => to.Address === tenant.ownerEmail),
      );
      expect(mine).toHaveLength(1);
      for (const message of mine) {
        await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`, { method: 'DELETE' });
      }

      const deliveries = await pool.query<{ id: string }>(
        `SELECT id FROM webhook_deliveries WHERE client_id = $1 AND status = 'sent'`,
        [tenant.clientId],
      );
      expect(deliveries.rows).toHaveLength(1);
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.headers['x-wp-event-id']).toBeTruthy();
      const body = JSON.parse(request.body) as { notificationId?: string };
      expect(body.notificationId).toBe(notificationId);

      // Scoped to THIS fixture's own notificationId - drainOnce claims the
      // whole outbox table each tick, so a captured frame could in principle
      // also carry an unrelated concurrent notification (the vitest project
      // runs fileParallelism:false, but this stays exact/scoped rather than
      // assuming no other activity, per the no-ambient-state rule).
      const myEvents = publisher.frames
        .flatMap((frame) => frame.events)
        .filter((e) => e.type === 'notification.created' && e.notificationId === notificationId);
      expect(myEvents).toHaveLength(1);
    } finally {
      await redis.quit();
    }
  });

  it('a_notify_race_with_one_transition_id_inserts_once_and_dedupes_the_rest', async () => {
    const tenant = await seedNotifyTenant(pool, { instanceLabel: 'Race Test Number' });
    seededClientIds.push(tenant.clientId);
    const transitionId = randomUUID();

    const before = await readDedupedCount();

    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        tenantDb.withTenant(tenant.clientId, (tx) =>
          notify(tx, {
            clientId: tenant.clientId,
            instanceId: tenant.instanceId,
            kind: 'instance_paused',
            transitionId,
            payload: {},
            requiresUserAction: true,
          }),
        ),
      ),
    );

    const created = results.filter((r) => r.created === true);
    const deduped = results.filter((r) => r.created === false);
    expect(created).toHaveLength(1);
    expect(deduped).toHaveLength(39);
    expect(deduped.every((r) => 'reason' in r && r.reason === 'deduped')).toBe(true);
    expect(created.length + deduped.length).toBe(40);

    const notificationRows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [
      tenant.clientId,
    ]);
    expect(notificationRows.rows).toHaveLength(1);

    const outboxRows = await pool.query(
      "SELECT id FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created'",
      [tenant.clientId],
    );
    expect(outboxRows.rows).toHaveLength(3);

    const after = await readDedupedCount();
    expect(after - before).toBe(39);
  });
});
