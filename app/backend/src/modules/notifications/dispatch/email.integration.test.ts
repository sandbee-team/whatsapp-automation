import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { NOTIFICATION_COPY } from '@wp/domain';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { notify } from '../notify.js';
import { createEmailDispatchPort, type EmailCapCounter } from './email.js';
import type { Mailer } from '../../../platform/mailer.js';
import {
  seedNotifyTenant,
  cleanupNotifyFixtures,
  type TestPool,
} from '../__tests__/notifications-test-support.js';

/**
 * dispatch/email.integration.test.ts (P17 U3, step 4) - the email leg's own
 * hourly-cap and copy/PII-boundary proofs against real Postgres (the
 * `wp_notification_email_recipients`/`wp_notification_instance_label`
 * definer functions). The cap counter and mailer are BOTH injected fakes
 * (deterministic, no real Redis/SMTP timing - see this module's own "never
 * assert on ambient state" rule) - `createEmailDispatchPort`'s own real
 * production wiring (`modules/notifications/dispatch/relay-email-fanout.ts`, real Redis + real
 * mailpit SMTP) is proven separately by `notify.integration.test.ts`'s own
 * mailpit-reaching assertion in the phase's full end-to-end test.
 */

const pool: TestPool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'notify-email-test',
});

let seededClientIds: string[] = [];

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupNotifyFixtures(pool, seededClientIds);
  seededClientIds = [];
});

/** Deterministic in-memory hourly-cap counter - a plain per-key increment, no TTL/wall-clock (this file never sleeps or asserts on ambient timing). */
function createFakeCapCounter(): EmailCapCounter & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
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

describe('email dispatch (P17 U3, step 4)', () => {
  it('the_hourly_email_cap_never_suppresses_in_app_or_webhook', async () => {
    const tenant = await seedNotifyTenant(pool);
    seededClientIds.push(tenant.clientId);
    const tenantDb: TenantDb = createTenantDb(pool);
    const mailer = createRecordingMailer();
    const capCounter = createFakeCapCounter();
    const dispatchPort = createEmailDispatchPort({ mailer, capCounter, env: 'test' });

    for (let i = 0; i < 30; i += 1) {
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
    }

    const notificationRows = await pool.query('SELECT id FROM notifications WHERE client_id = $1', [
      tenant.clientId,
    ]);
    expect(notificationRows.rows).toHaveLength(30);

    const webhookOutboxRows = await pool.query(
      "SELECT id FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created' AND fanout = ARRAY['webhook']::text[]",
      [tenant.clientId],
    );
    expect(webhookOutboxRows.rows).toHaveLength(30);

    const emailOutboxRows = await pool.query<{
      id: string;
      client_id: string;
      instance_id: string | null;
      payload: { kind: string };
    }>(
      "SELECT id, client_id, instance_id, payload FROM outbox_events WHERE client_id = $1 AND event_type = 'notification.created' AND fanout = ARRAY['email']::text[]",
      [tenant.clientId],
    );
    expect(emailOutboxRows.rows).toHaveLength(30);

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
    await dispatchPort.send(resolved);

    expect(mailer.sent).toHaveLength(20);
  });

  it('the_pause_email_contains_the_canonical_copy_and_no_recipient_pii', async () => {
    const tenant = await seedNotifyTenant(pool, { instanceLabel: 'My Test Number' });
    seededClientIds.push(tenant.clientId);
    const tenantDb: TenantDb = createTenantDb(pool);
    const mailer = createRecordingMailer();
    const capCounter = createFakeCapCounter();
    const dispatchPort = createEmailDispatchPort({ mailer, capCounter, env: 'test' });

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
        payload: { queued: 5 },
      },
    ]);
    await dispatchPort.send(resolved);

    expect(mailer.sent).toHaveLength(1);
    const sentMail = mailer.sent[0]!;
    const expectedBody = NOTIFICATION_COPY.instance_paused.email.body
      .replace('{instanceLabel}', 'My Test Number')
      .replace('{queued}', '5');
    expect(sentMail.body).toBe(expectedBody);

    // No recipient PII (phone/JID/message body) ever appears in the raw
    // rendered mail - only the canonical pause copy + the panel tail line.
    expect(sentMail.body).not.toMatch(/\+\d{6,}/);
    expect(sentMail.to).toEqual([tenant.ownerEmail]);
  });

  it('two_tenants_pausing_at_once_never_cross_notify', async () => {
    const tenantA = await seedNotifyTenant(pool, { instanceLabel: 'Tenant A Number' });
    const tenantB = await seedNotifyTenant(pool, { instanceLabel: 'Tenant B Number' });
    seededClientIds.push(tenantA.clientId, tenantB.clientId);
    const tenantDb: TenantDb = createTenantDb(pool);
    const mailer = createRecordingMailer();
    const capCounter = createFakeCapCounter();
    const dispatchPort = createEmailDispatchPort({ mailer, capCounter, env: 'test' });

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
      "SELECT id, client_id, instance_id, payload FROM outbox_events WHERE client_id = ANY($1) AND event_type = 'notification.created' AND fanout = ARRAY['email']::text[]",
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
    await dispatchPort.send(resolved);

    expect(mailer.sent).toHaveLength(2);
    const mailToA = mailer.sent.find((m) => m.to.includes(tenantA.ownerEmail));
    const mailToB = mailer.sent.find((m) => m.to.includes(tenantB.ownerEmail));
    expect(mailToA?.to).toEqual([tenantA.ownerEmail]);
    expect(mailToB?.to).toEqual([tenantB.ownerEmail]);
    // Never cross-tenant: tenant A's mail never carries tenant B's recipient
    // and vice versa.
    expect(mailToA?.to).not.toContain(tenantB.ownerEmail);
    expect(mailToB?.to).not.toContain(tenantA.ownerEmail);
  });
});
