import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * notifications-test-support.ts (P17 U3) - shared seed/cleanup fixtures for
 * `notify.integration.test.ts`/`dispatch/email.integration.test.ts`. NOT
 * itself a test file (does not match the `*.test.ts` glob). Extends the
 * cleanup helper to cover `notifications` + this module's own `outbox_events`/
 * `webhook_deliveries` rows AND mailpit's mailbox (P16 lesson: a cleanup
 * helper that omits a table a new write path touches poisons later suites) -
 * always scoped to the fixture's own client ids, never a whole-table DELETE
 * (known flaky-class rule).
 */

export type TestPool = ReturnType<typeof createPool>;

export interface SeedNotifyTenantOptions {
  instanceLabel?: string;
}

export interface SeededNotifyTenant {
  clientId: string;
  instanceId: string;
  ownerUserId: string;
  ownerEmail: string;
}

/** Seeds one client + one verified-email owner membership + one instance - enough for a full notify()-through-email-recipient-resolution run. */
export async function seedNotifyTenant(
  pool: TestPool,
  options: SeedNotifyTenantOptions = {},
): Promise<SeededNotifyTenant> {
  const clientId = randomUUID();
  const instanceId = randomUUID();
  const ownerUserId = randomUUID();
  const ownerEmail = `notify-owner-${clientId}@wp-test.local`;

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Notify Test Client',
    `notify-test-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO users (id, full_name, email, email_verified_at) VALUES ($1, $2, $3, now())`,
    [ownerUserId, 'Notify Owner', ownerEmail],
  );
  await pool.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
    clientId,
    ownerUserId,
    'owner',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, link_state, desired_state, session_epoch)
     VALUES ($1, $2, $3, 'paused', 'linked', 'online', 0)`,
    [instanceId, clientId, options.instanceLabel ?? 'Notify Test Instance'],
  );

  return { clientId, instanceId, ownerUserId, ownerEmail };
}

/** Directly seeds one `notifications` row with a caller-controlled `created_at`/`read_at` - used by suites that need exact timestamp control (keyset/tie-break/read-all races) rather than going through `notify()`'s own `now()`-driven insert. Not itself a dedupe-authority proof (that is `notify.integration.test.ts`'s own job) - this helper exists purely to seed fixture rows fast. */
export async function seedNotification(
  pool: TestPool,
  input: {
    clientId: string;
    instanceId: string;
    kind?: string;
    createdAt: Date;
    readAt?: Date | null;
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO notifications
       (id, client_id, instance_id, kind, severity, dedupe_key, payload, requires_user_action, created_at, read_at)
     VALUES ($1, $2, $3, $4, 'warning', $5, '{}'::jsonb, false, $6, $7)`,
    [
      id,
      input.clientId,
      input.instanceId,
      input.kind ?? 'plan_cap_reached',
      `dedupe-${id}`,
      input.createdAt,
      input.readAt ?? null,
    ],
  );
  return id;
}

/** Deletes every row this module's own write paths could have touched, scoped to `clientIds` - never a whole-table DELETE. */
export async function cleanupNotifyFixtures(pool: TestPool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM webhook_deliveries WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM webhook_endpoints WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  // P17 U6 (step 5) - isolation-suite-b-notifications.integration.test.ts
  // drives applyHardSignalPause, which writes pacing_events and updates
  // instance_pacing_state; neither is covered by this helper's original
  // (U3-era) table list.
  await pool.query('DELETE FROM pacing_events WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM instance_pacing_state WHERE client_id = ANY($1)', [clientIds]);
  const memberships = await pool.query<{ user_id: string }>(
    'DELETE FROM memberships WHERE client_id = ANY($1) RETURNING user_id',
    [clientIds],
  );
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  const userIds = memberships.rows.map((r) => r.user_id);
  if (userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}

const MAILPIT_BASE_URL = 'http://127.0.0.1:8025';

export interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/** Lists every message currently in mailpit's mailbox (dev/test-only fixed port - no prior test in this repo queries mailpit's HTTP API, so this is a fresh, minimal helper). */
export async function listMailpitMessages(): Promise<MailpitMessage[]> {
  const response = await fetch(`${MAILPIT_BASE_URL}/api/v1/messages`);
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

/** Fetches one message's full source text (for asserting body content/no-PII). */
export async function fetchMailpitMessageText(id: string): Promise<string> {
  const response = await fetch(`${MAILPIT_BASE_URL}/api/v1/message/${id}/raw`);
  return response.text();
}

/** Deletes every message currently in mailpit - test isolation (P16 lesson: never leave mailbox state for the next suite). */
export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${MAILPIT_BASE_URL}/api/v1/messages`, { method: 'DELETE' });
}
