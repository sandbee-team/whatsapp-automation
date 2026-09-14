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
 * dispatch/email-zero-recipients.integration.test.ts (P17 C2 hardening,
 * 2026-09-03) - sibling split of dispatch/email.integration.test.ts
 * (max-lines cap; mechanical extraction, not a behavioural boundary).
 * Targets hunt seam 8: the recipient-resolution definer fn
 * (`wp_notification_email_recipients`) returning ZERO rows (no verified
 * owner/admin) must be a clean skip - no throw (a throw here would poison
 * the whole relay drain tick, same class of bug as seams 1/2), no mailer
 * call, and NOT counted as `wp_notification_emails_suppressed_total` (it was
 * never cap-suppressed - there was nobody to suppress a send to).
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notify-email-zero-recipients-test',
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
  subject: string;
  body: string;
}

function createRecordingMailer(): Mailer & { sent: RecordedMail[] } {
  const sent: RecordedMail[] = [];
  return {
    sent,
    async sendVerificationEmail(): Promise<void> {},
    async sendLockoutEmail(): Promise<void> {},
    async sendReuseDetectedEmail(): Promise<void> {},
    async sendPasswordResetEmail(): Promise<void> {},
    async sendNotificationEmail(to: string[], subject: string, body: string): Promise<void> {
      sent.push({ to, subject, body });
    },
  };
}

describe('email dispatch zero recipients (P17 C2 hardening)', () => {
  it('zero_verified_recipients_skips_cleanly_without_throwing_or_incrementing_the_suppressed_metric', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    // Flip the seeded owner's email back to unverified - the definer fn's
    // own WHERE clause requires email_verified_at IS NOT NULL.
    await pool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [
      tenant.ownerUserId,
    ]);

    const tenantDb: TenantDb = createTenantDb(pool);
    const mailer = createRecordingMailer();
    const capCounter = createFakeCapCounter();
    const dispatchPort = createEmailDispatchPort({ mailer, capCounter, env: 'test' });
    const metrics = bindNotificationMetrics();
    const suppressedBefore =
      (await metrics.emailsSuppressedTotal.get()).values.find(
        (v) => v.labels['kind'] === 'instance_paused',
      )?.value ?? 0;

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

    const emailOutboxRow = await pool.query<{
      id: string;
      client_id: string;
      instance_id: string | null;
      payload: { kind: string };
    }>(
      "SELECT id, client_id, instance_id, payload FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created' AND fanout = ARRAY['email']::text[]",
      [tenant.clientId],
    );
    expect(emailOutboxRow.rows).toHaveLength(1);
    const row = emailOutboxRow.rows[0]!;

    const resolved = await dispatchPort.resolve(pool, [
      {
        id: row.id,
        clientId: row.client_id,
        instanceId: row.instance_id,
        kind: row.payload.kind as never,
        payload: {},
      },
    ]);
    await expect(dispatchPort.send(resolved)).resolves.toBeUndefined();

    expect(mailer.sent).toHaveLength(0);

    const suppressedAfter =
      (await metrics.emailsSuppressedTotal.get()).values.find(
        (v) => v.labels['kind'] === 'instance_paused',
      )?.value ?? 0;
    expect(suppressedAfter).toBe(suppressedBefore);
  });
});
