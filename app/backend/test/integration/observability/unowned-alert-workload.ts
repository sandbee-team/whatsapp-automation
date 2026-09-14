import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * unowned-alert-workload.ts (P25 U7 Part C) - shared seed/cleanup helpers
 * for `unowned-alert.integration.test.ts`. Direct INSERTs (same shortcut
 * `modules/queue/__tests__/claim-test-helpers.ts#seedTenant` and
 * `engine/fleet/__tests__/fleet-recovery-test-support.ts#seedLinkedInstance`
 * take) rather than a full pairing/lease-manager walk, since this suite only
 * needs an exact `desired_state`/`instance_lease_state.lease_seen_at`
 * combination to drive `fleet-gauges.sql`'s own 45s staleness predicate.
 * NOT itself a test file (no `.test.ts` suffix).
 */

export type TestPool = ReturnType<typeof createPool>;

export interface SeededOwnedInstance {
  clientId: string;
  instanceId: string;
  jobIds: string[];
}

/**
 * Seeds ONE client + ONE `desired_state = 'online'` instance with a
 * currently-live lease (`lease_seen_at = now()`) + THREE queued
 * `message_jobs` rows. "Owned" per `fleet-gauges.sql`'s own predicate:
 * `lease_seen_at` fresher than 45 seconds.
 */
export async function seedOwnedOnlineInstance(pool: TestPool): Promise<SeededOwnedInstance> {
  const clientId = randomUUID();
  const instanceId = randomUUID();
  const workerId = `worker-unowned-alert-seed-${randomUUID()}`;

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Unowned Alert Probe',
    `unowned-alert-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, link_state, desired_state, session_epoch)
     VALUES ($1, $2, 'probe', 'connected', 'linked', 'online', 0)`,
    [instanceId, clientId],
  );
  await pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, 1, $3, now())`,
    [instanceId, clientId, workerId],
  );

  const jobIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'queued', now(), now())
       RETURNING id`,
      [
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        JSON.stringify({ text: `unowned-alert-probe-${String(i)}` }),
      ],
    );
    const row = result.rows[0];
    if (row) jobIds.push(row.id);
  }

  return { clientId, instanceId, jobIds };
}

/** Simulates "the worker died": its lease stops being renewed - never deletes the row (invariant 5 is about jobs, but this mirrors the same never-delete discipline). */
export async function markLeaseStale(pool: TestPool, instanceId: string): Promise<void> {
  await pool.query(
    `UPDATE instance_lease_state SET lease_seen_at = now() - interval '60 seconds' WHERE instance_id = $1`,
    [instanceId],
  );
}

/**
 * Instance-scoped read of `fleet-gauges.sql`'s own `unowned_count`
 * predicate, filtered to ONE seeded instance (Finding 3, P25 C1 fix round):
 * the fleet-wide gauge differences the shared integration DB (an ambient-
 * state assertion, banned for new integration tests) - this reads only the
 * seeded instance's own owned/unowned state, byte-identical predicate to
 * `fleet-gauges.sql`'s `unowned_count` subquery, scoped by `i.id = $1`.
 */
export async function isInstanceUnowned(pool: TestPool, instanceId: string): Promise<boolean> {
  const result = await pool.query<{ unowned: boolean }>(
    `SELECT count(*) > 0 AS unowned
       FROM whatsapp_instances i
       LEFT JOIN instance_lease_state ls
         ON ls.instance_id = i.id AND ls.client_id = i.client_id
      WHERE i.id = $1
        AND i.desired_state = 'online'
        AND i.deleted_at IS NULL
        AND (ls.instance_id IS NULL
             OR ls.lease_seen_at IS NULL
             OR ls.lease_seen_at < now() - interval '45 seconds')`,
    [instanceId],
  );
  return result.rows[0]?.unowned ?? false;
}

export async function cleanupUnownedAlertProbes(
  pool: TestPool,
  clientIds: string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}
