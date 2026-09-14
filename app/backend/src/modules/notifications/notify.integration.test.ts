import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { notify } from './notify.js';
import { drainOnce, type BatchPublisherPort } from '../events/index.js';
import { createWebhookFanoutPort } from '../webhooks/repo.js';
import {
  seedNotifyTenant,
  cleanupNotifyFixtures,
  clearMailpitMessages,
  type TestPool,
} from './__tests__/notifications-test-support.js';

/**
 * notify.integration.test.ts (P17 U3, step 3) - `notify()` against real
 * Postgres, called exactly as a pause caller would (inside `withTenant`),
 * followed by one relay drain tick (`drainOnce`, with the webhook fanout
 * port wired so the webhook leg's durable handoff runs too - the email leg
 * is exercised separately in `dispatch/email.integration.test.ts`, this
 * file's own "one notification, one email row, one webhook row" test only
 * asserts the OUTBOX row shape for the email channel, not an actual SMTP
 * send, since no `emailFanout` port is wired here).
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notify-test',
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

describe('notify (P17 U3, step 3)', () => {
  it('a_pause_produces_exactly_one_notification_one_email_row_and_one_webhook_row', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    await clearMailpitMessages();

    const result = await tenantDb.withTenant(tenant.clientId, (tx) =>
      notify(tx, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        kind: 'instance_paused',
        transitionId: randomUUID(),
        payload: {},
      }),
    );
    expect(result.created).toBe(true);

    const notificationRows = await pool.query<{ id: string }>(
      'SELECT id FROM notifications WHERE client_id = $1',
      [tenant.clientId],
    );
    expect(notificationRows.rows).toHaveLength(1);

    const outboxRows = await pool.query<{ fanout: string[] }>(
      "SELECT fanout FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created'",
      [tenant.clientId],
    );
    expect(outboxRows.rows).toHaveLength(3);
    const channels = outboxRows.rows.map((r) => r.fanout[0]).sort();
    expect(channels).toEqual(['email', 'sse', 'webhook']);

    await drainOnce({
      pool,
      publisher: noOpPublisher(),
      metrics: noOpMetrics(),
      clock: { now: () => new Date() },
      webhookFanout: createWebhookFanoutPort(),
    });

    const published = await pool.query<{ published_at: Date | null }>(
      "SELECT published_at FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created'",
      [tenant.clientId],
    );
    for (const row of published.rows) {
      expect(row.published_at).not.toBeNull();
    }
  });

  it('a_deduped_notify_writes_zero_outbox_rows', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    const transitionId = randomUUID();

    const first = await tenantDb.withTenant(tenant.clientId, (tx) =>
      notify(tx, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        kind: 'instance_paused',
        transitionId,
        payload: {},
      }),
    );
    expect(first.created).toBe(true);

    const second = await tenantDb.withTenant(tenant.clientId, (tx) =>
      notify(tx, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        kind: 'instance_paused',
        transitionId,
        payload: {},
      }),
    );
    expect(second).toEqual({ created: false, reason: 'deduped' });

    const notificationRows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [
      tenant.clientId,
    ]);
    expect(notificationRows.rows).toHaveLength(1);

    const outboxRows = await pool.query(
      "SELECT id FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created'",
      [tenant.clientId],
    );
    expect(outboxRows.rows).toHaveLength(3);
  });

  it('a_rolled_back_business_transaction_leaves_no_notification_and_no_outbox_row', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);

    await expect(
      tenantDb.withTenant(tenant.clientId, async (tx) => {
        await notify(tx, {
          clientId: tenant.clientId,
          instanceId: tenant.instanceId,
          kind: 'instance_paused',
          transitionId: randomUUID(),
          payload: {},
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const notificationRows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [
      tenant.clientId,
    ]);
    expect(notificationRows.rows).toHaveLength(0);

    const outboxRows = await pool.query(
      "SELECT id FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created'",
      [tenant.clientId],
    );
    expect(outboxRows.rows).toHaveLength(0);
  });

  it('a_resolved_then_repeated_pause_notifies_again', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);

    const first = await tenantDb.withTenant(tenant.clientId, (tx) =>
      notify(tx, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        kind: 'instance_paused',
        transitionId: randomUUID(),
        payload: {},
      }),
    );
    expect(first.created).toBe(true);

    const second = await tenantDb.withTenant(tenant.clientId, (tx) =>
      notify(tx, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        kind: 'instance_paused',
        transitionId: randomUUID(),
        payload: {},
      }),
    );
    expect(second.created).toBe(true);
    expect(second).not.toEqual(first);

    const notificationRows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [
      tenant.clientId,
    ]);
    expect(notificationRows.rows).toHaveLength(2);
  });
});
