import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import type { createRedis } from '../../../platform/redis.js';

/**
 * contacts-routes-cleanup-support.ts (P20 Unit U6, step 5/7) - `attachPlan`/
 * `cleanupContactsRoutesRecords`, split out of `contacts-routes-test-
 * support.ts` purely for that file's own max-lines cap (same split idiom as
 * `session-worker-discovery-wiring.ts`). NOT itself a test file.
 */

/** Creates one `plans` + `plan_limits` row (max_contacts + the instance caps, all NOT NULL) and assigns it to `clientId`. */
export async function attachPlan(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  limits: { maxContacts: number },
): Promise<string> {
  const planId = randomUUID();
  await pool.query('INSERT INTO plans (id, name) VALUES ($1, $2)', [
    planId,
    `Contacts Test Plan ${planId}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_contacts, max_connected_instances, max_registered_instances)
     VALUES ($1, $2, 5, 5)`,
    [planId, limits.maxContacts],
  );
  await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [planId, clientId]);
  return planId;
}

/** Deletes every row created for the given probe ids, children-first, then defers to the wallet fork's own base-table cleanup order. */
export async function cleanupContactsRoutesRecords(
  pool: ReturnType<typeof createPool>,
  redis: ReturnType<typeof createRedis>,
  userIds: string[],
  clientIds: string[],
  planIds: string[] = [],
): Promise<void> {
  if (clientIds.length > 0) {
    await pool.query('DELETE FROM contact_tag_links WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM contact_tags WHERE client_id = ANY($1)', [clientIds]);
    // P20 Unit U6: import rows carry their own client_id FK to `clients` -
    // deleted BEFORE `contacts`/`clients` themselves, same children-first
    // order as every other table in this block.
    await pool.query('DELETE FROM contact_import_errors WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM contact_imports WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM consent_records WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM client_limit_overrides WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM client_pricing WHERE client_id = ANY($1)', [clientIds]);
    await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [clientIds]);
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
  if (planIds.length > 0) {
    await pool.query('DELETE FROM plan_limits WHERE plan_id = ANY($1)', [planIds]);
    await pool.query('DELETE FROM plans WHERE id = ANY($1)', [planIds]);
  }
  void redis;
}
