import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import type { InstanceCtx, InstanceQueryable } from '../repo.js';

/**
 * instances-test-helpers.ts (P08 Unit U4) - shared, non-test fixture
 * machinery for the `modules/instances` integration test suite. Mirrors
 * `modules/queue/__tests__/claim-test-helpers.ts`'s own shape (a plain
 * superuser-pool seed layer, callers own their own `probeClientIds`
 * cleanup list). Deliberately does NOT match the `*.test.ts` glob so it is
 * never picked up as its own suite.
 */

export type TestPool = ReturnType<typeof createPool>;

export const PROBE_WORKER_ID = 'worker-instances-probe';

export interface SeedTenantOptions {
  healthState?: string;
  linkState?: string;
  desiredState?: string;
  sessionEpoch?: number;
}

/** Seeds `clients` + `whatsapp_instances` rows for a fresh probe tenant. */
export async function seedTenant(
  pool: TestPool,
  options: SeedTenantOptions = {},
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Instances Probe Client',
    `instances-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, link_state, desired_state, session_epoch)
     VALUES ($1, $2, 'probe', $3, $4, $5, $6)`,
    [
      instanceId,
      clientId,
      options.healthState ?? 'connected',
      options.linkState ?? 'linked',
      options.desiredState ?? 'online',
      options.sessionEpoch ?? 0,
    ],
  );

  return { clientId, instanceId };
}

/** Seeds an `instance_lease_state` row owned by `workerId` at `fence`. */
export async function seedLease(
  pool: TestPool,
  input: { clientId: string; instanceId: string; fence: bigint | number; workerId?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, $3, $4, now())`,
    [input.instanceId, input.clientId, input.fence.toString(), input.workerId ?? PROBE_WORKER_ID],
  );
}

export interface SeedJobOptions {
  clientId: string;
  instanceId: string;
  recipientJid?: string;
}

/** Inserts one 'queued' message_jobs row, returns its bigint id (as a string). */
export async function seedJob(pool: TestPool, options: SeedJobOptions): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'queued', now(), now())
     RETURNING id`,
    [
      options.clientId,
      options.instanceId,
      options.recipientJid ?? `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedJob: INSERT ... RETURNING returned no row');
  return row.id;
}

export interface JobSnapshot {
  id: string;
  status: string;
  updatedAtIso: string | null;
}

/** Reads back every message_jobs row for one instance, ordered by id, for byte-identical before/after comparisons. */
export async function readJobsForInstance(
  pool: TestPool,
  instanceId: string,
): Promise<JobSnapshot[]> {
  const result = await pool.query<{ id: string; status: string; updated_at: Date | null }>(
    `SELECT id, status, updated_at FROM message_jobs WHERE instance_id = $1 ORDER BY id`,
    [instanceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    updatedAtIso: row.updated_at ? row.updated_at.toISOString() : null,
  }));
}

export async function cleanupProbeClients(pool: TestPool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  // P17 U6 (step 5) - notifications.client_id has no ON DELETE CASCADE (an
  // append-only inbox table, migration 0048); a leaked row here would FK-
  // block the DELETE FROM clients below for any caller whose write path now
  // also calls notify() (e.g. runLoggedOutFlow/applyEngineTransition).
  // FIX (P17 close, gate attempt 4): notify() also writes 3 outbox_events
  // rows per notification (sse/webhook/email fanout); outbox_events has no
  // FK to clients either, so it leaked forever and poisoned any later
  // cross-tenant drainOnce/runOneReconcilerSweep-driving test - same
  // mechanism as the P16 lesson, same missed table as this helper's sibling
  // fixtures (queue-send-tenant-fixture.ts, pacing-test-helpers.ts).
  await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_session_keys WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_session_credentials WHERE client_id = ANY($1)', [
    clientIds,
  ]);
  await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}

/** Builds a plain `InstanceCtx` bound to `pool` (no role switch - see `wp-app-role.integration.test.ts` for the role-scoped proof). */
export function ctxFor(pool: TestPool, clientId: string): InstanceCtx {
  return { clientId, sql: pool as unknown as InstanceQueryable };
}
