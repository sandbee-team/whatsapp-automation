import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { notify } from '../notify.js';
import { createEmailDispatchPort, type EmailCapCounter } from './email.js';
import { bindNotificationMetrics } from '../../../platform/metrics/notification-metrics.js';
import type { Mailer } from '../../../platform/mailer.js';
import {
  seedNotifyTenant,
  cleanupNotifyFixtures,
  type TestPool,
} from '../__tests__/notifications-test-support.js';

/**
 * dispatch/email-per-row-isolation.integration.test.ts (P17 fix round F1) -
 * sibling split of dispatch/email.integration.test.ts (max-lines cap,
 * mechanical extraction). Proves the per-row isolation `dispatch()` needs so
 * that ONE row's SMTP throw never stops the REST of the batch, and that a
 * failure increments `wp_notification_email_failures_total{kind}` rather
 * than propagating - this is what lets `relay-loop.ts` call `dispatchEmails`
 * AFTER commit without a single bad send poisoning the whole tick.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notify-email-isolation-test',
});

let seededClientIds: string[] = [];

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupNotifyFixtures(pool, seededClientIds);
  seededClientIds = [];
});

function createFakeCapCounter(): EmailCapCounter {
  const counts = new Map<string, number>();
  return {
    async incrementAndGet(key: string): Promise<number> {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

interface RecordedMail {
  to: string[];
}

/** Throws for the FIRST send only, then records every subsequent one - proves the second row is still attempted after the first row's throw. */
function createFlakyMailer(): Mailer & { sent: RecordedMail[] } {
  const sent: RecordedMail[] = [];
  let callCount = 0;
  return {
    sent,
    async sendVerificationEmail(): Promise<void> {},
    async sendLockoutEmail(): Promise<void> {},
    async sendReuseDetectedEmail(): Promise<void> {},
    async sendPasswordResetEmail(): Promise<void> {},
    async sendNotificationEmail(to: string[]): Promise<void> {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('SMTP exploded for the first row');
      }
      sent.push({ to });
    },
  };
}

describe('email dispatch per-row isolation (P17 fix round F1)', () => {
  it('a_send_that_throws_for_one_row_never_stops_the_rest_of_the_batch_and_increments_the_failure_counter', async () => {
    const tenantA = await seedNotifyTenant(pool, { instanceLabel: 'Isolation Tenant A' });
    const tenantB = await seedNotifyTenant(pool, { instanceLabel: 'Isolation Tenant B' });
    seededClientIds.push(tenantA.clientId, tenantB.clientId);
    const tenantDb: TenantDb = createTenantDb(pool);
    const mailer = createFlakyMailer();
    const capCounter = createFakeCapCounter();
    const dispatchPort = createEmailDispatchPort({ mailer, capCounter, env: 'test' });
    const metrics = bindNotificationMetrics();
    const failuresBefore =
      (await metrics.emailFailuresTotal.get()).values.find(
        (v) => v.labels['kind'] === 'instance_paused',
      )?.value ?? 0;

    const [resultA, resultB] = await Promise.all([
      tenantDb.withTenant(tenantA.clientId, (tx) =>
        notify(tx, {
          clientId: tenantA.clientId,
          instanceId: tenantA.instanceId,
          kind: 'instance_paused',
          transitionId: randomUUID(),
          payload: {},
        }),
      ),
      tenantDb.withTenant(tenantB.clientId, (tx) =>
        notify(tx, {
          clientId: tenantB.clientId,
          instanceId: tenantB.instanceId,
          kind: 'instance_paused',
          transitionId: randomUUID(),
          payload: {},
        }),
      ),
    ]);
    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);

    const emailOutboxRows = await pool.query<{
      id: string;
      client_id: string;
      instance_id: string | null;
      payload: { kind: string };
    }>(
      "SELECT id, client_id, instance_id, payload FROM outbox_events WHERE client_id = ANY($1) AND event_type = 'notification.created' AND fanout = ARRAY['email']::text[] ORDER BY client_id",
      [[tenantA.clientId, tenantB.clientId]],
    );
    expect(emailOutboxRows.rows).toHaveLength(2);

    const resolved = await dispatchPort.resolve(
      pool,
      emailOutboxRows.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        instanceId: row.instance_id,
        kind: row.payload.kind as never,
        payload: {},
      })),
    );
    // Never throws - the per-row isolation swallows the first row's failure.
    await expect(dispatchPort.send(resolved)).resolves.toBeUndefined();

    // Exactly ONE send succeeded (the second row) - the first row's throw
    // never stopped the batch.
    expect(mailer.sent).toHaveLength(1);

    const failuresAfter =
      (await metrics.emailFailuresTotal.get()).values.find(
        (v) => v.labels['kind'] === 'instance_paused',
      )?.value ?? 0;
    expect(failuresAfter).toBe(failuresBefore + 1);
  });
});
