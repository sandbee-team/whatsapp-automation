import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import type { createRedis } from '../../../platform/redis.js';

/**
 * list-query-coercion-seeds.ts (P28 U5, item 4; split out of
 * list-query-coercion-app-support.ts for max-lines) - the direct-SQL seed/
 * cleanup helpers `list-query-coercion.integration.test.ts` needs. Pure code
 * motion: no behavior change. NOT itself a test file.
 */

/** Seeds one `whatsapp_instances` row directly - the FK anchor `notifications`/`campaigns`/`wa_groups` rows below all need. */
export async function seedInstance(
  pool: ReturnType<typeof createPool>,
  clientId: string,
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'probe', 'linked', 'connected')
     -- client_id = $2`,
    [instanceId, clientId],
  );
  return instanceId;
}

/** Seeds `count` `notifications` rows, half already read (for the `unread` coercion assertions). */
export async function seedNotifications(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  instanceId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    const readAt = i % 2 === 0 ? null : new Date();
    await pool.query(
      `INSERT INTO notifications
         (id, client_id, instance_id, kind, severity, dedupe_key, payload, requires_user_action, read_at)
       VALUES ($1, $2, $3, 'plan_cap_reached', 'warning', $4, '{}'::jsonb, false, $5)`,
      [id, clientId, instanceId, `list-coercion-dedupe-${id}`, readAt],
    );
  }
}

/** Seeds `count` `topup_requests` rows. */
export async function seedTopupRequests(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  userId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO topup_requests
         (id, client_id, amount_minor, method, external_ref, status, submitted_by_user_id)
       VALUES ($1, $2, 100000, 'bank_transfer', $3, 'pending', $4)`,
      [id, clientId, `list-coercion-ref-${id}`, userId],
    );
  }
}

/** Seeds `count` `campaigns` rows directly (bypassing `createBroadcast`'s own service - only the LIST route's own query coercion is under test here). */
export async function seedCampaigns(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  instanceId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, client_id, instance_id, name, audience, message)
       VALUES ($1, $2, $3, $4, '{"kind":"contacts"}'::jsonb, '{"kind":"text","text":"hi"}'::jsonb)`,
      [id, clientId, instanceId, `List coercion campaign ${String(i)}`],
    );
  }
}

/** Seeds `count` `wa_groups` rows. */
export async function seedGroups(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  instanceId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO wa_groups (id, client_id, instance_id, group_jid, subject)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, clientId, instanceId, `${id}@g.us`, `List coercion group ${String(i)}`],
    );
  }
}

/** Seeds `count` `contacts` rows - `phone_hash`/`wa_jid` are NOT NULL with no DB default; a fixed dummy hash is fine here (only the LIST route's own query coercion is under test, never a real opt-out/dedupe lookup against these rows). */
export async function seedContacts(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    const phoneE164 = `+9199900${String(10000 + i).padStart(5, '0')}`;
    await pool.query(
      `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source, consent_basis)
       VALUES ($1, $2, $3, digest($3, 'sha256'), $4, 'manual', 'user_declared_optin')`,
      [id, clientId, phoneE164, `${phoneE164.slice(1)}@s.whatsapp.net`],
    );
  }
}

/** Deletes every row this fixture (or the routes it exercises) wrote for the given probe ids. */
export async function cleanupListCoercionRecords(
  pool: ReturnType<typeof createPool>,
  redis: ReturnType<typeof createRedis>,
  userIds: string[],
  clientIds: string[],
): Promise<void> {
  if (clientIds.length > 0) {
    await pool.query('DELETE FROM contact_tag_links WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM wa_groups WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM topup_requests WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  }
  if (userIds.length > 0) {
    await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM email_verification_tokens WHERE user_id = ANY($1)', [userIds]);
  }
  if (clientIds.length > 0) {
    await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
  }
  if (userIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
  void redis;
}
