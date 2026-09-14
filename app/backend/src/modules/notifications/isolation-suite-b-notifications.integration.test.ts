import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { drainOnce, type BatchPublisherPort } from '../events/index.js';
import { createWebhookFanoutPort } from '../webhooks/repo.js';
import {
  applyHardSignalPause,
  type HardSignalPauseInput,
} from '../pacing/health/hard-signal-pause.js';
import { listNotificationsForClient } from './notifications.service.js';
import {
  cleanupNotifyFixtures,
  seedNotifyTenant,
  clearMailpitMessages,
  type TestPool,
} from './__tests__/notifications-test-support.js';

/**
 * isolation-suite-b-notifications.integration.test.ts (P17 U6, step 5/6) -
 * `two_tenants_notifications_never_cross_in_storage_or_list`: the SAME
 * isolation-suite-B placement/idiom as P16's own
 * `two_tenants_do_not_interfere_in_one_evaluation_pass`
 * (`modules/pacing/health/evaluator-loop.integration.test.ts`), applied to
 * the notify()+relay background path plus this unit's own list API. U3's
 * own `notify.integration.test.ts` already proved the EMAIL leg two-tenant
 * case (dispatch/email.integration.test.ts) - this file proves the
 * DIFFERENT half: the `notifications` TABLE storage never leaks a row
 * across tenants, and the list API (`notifications.service.ts`) never
 * returns another tenant's row even when both tenants pause in the same
 * interleaved pass and are drained through the SAME relay tick.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notifications-isolation-suite-b-test',
});
let tenantDb: TenantDb;
let seededClientIds: string[] = [];

beforeEach(() => {
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupNotifyFixtures(pool, seededClientIds);
  seededClientIds = [];
  await clearMailpitMessages();
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

function baseHardSignalInput(clientId: string, instanceId: string): HardSignalPauseInput {
  return {
    clientId,
    instanceId,
    pauseReason: 'health_critical',
    evidence: {},
    effectiveLimits: {},
    warmupTier: 1,
    accountAgeDays: 10,
    sendHistory30d: {},
    band: 'critical',
  };
}

describe('two-tenant notifications isolation (P17 U6, real Postgres)', () => {
  it('two_tenants_notifications_never_cross_in_storage_or_list', async () => {
    const tenantA = await seedNotifyTenant(pool);
    seededClientIds.push(tenantA.clientId);
    const tenantB = await seedNotifyTenant(pool);
    seededClientIds.push(tenantB.clientId);

    // Interleaved: A pauses, B pauses, A drains, B drains - the notify()
    // writer + relay drain both run once per tenant in the SAME overall pass.
    await tenantDb.withTenant(tenantA.clientId, (tx) =>
      applyHardSignalPause(tx, baseHardSignalInput(tenantA.clientId, tenantA.instanceId)),
    );
    await tenantDb.withTenant(tenantB.clientId, (tx) =>
      applyHardSignalPause(tx, baseHardSignalInput(tenantB.clientId, tenantB.instanceId)),
    );

    await drainOnce({
      pool,
      publisher: noOpPublisher(),
      metrics: noOpMetrics(),
      clock: { now: () => new Date() },
      webhookFanout: createWebhookFanoutPort(),
    });

    // STORAGE: each tenant's own notifications row carries ONLY its own
    // client_id/instance_id - never the sibling's.
    const rowsA = await pool.query<{ client_id: string; instance_id: string | null }>(
      'SELECT client_id, instance_id FROM notifications WHERE client_id = $1',
      [tenantA.clientId],
    );
    expect(rowsA.rows).toHaveLength(1);
    expect(rowsA.rows.every((r) => r.client_id === tenantA.clientId)).toBe(true);
    expect(rowsA.rows.every((r) => r.instance_id === tenantA.instanceId)).toBe(true);

    const rowsB = await pool.query<{ client_id: string; instance_id: string | null }>(
      'SELECT client_id, instance_id FROM notifications WHERE client_id = $1',
      [tenantB.clientId],
    );
    expect(rowsB.rows).toHaveLength(1);
    expect(rowsB.rows.every((r) => r.client_id === tenantB.clientId)).toBe(true);
    expect(rowsB.rows.every((r) => r.instance_id === tenantB.instanceId)).toBe(true);

    // LIST API: tenant A's own list call never surfaces tenant B's row, and
    // vice versa.
    const listA = await listNotificationsForClient(tenantDb, {
      clientId: tenantA.clientId,
      limit: 25,
    });
    expect(listA.items).toHaveLength(1);
    expect(listA.items[0]?.instanceId).toBe(tenantA.instanceId);

    const listB = await listNotificationsForClient(tenantDb, {
      clientId: tenantB.clientId,
      limit: 25,
    });
    expect(listB.items).toHaveLength(1);
    expect(listB.items[0]?.instanceId).toBe(tenantB.instanceId);
  });
});
