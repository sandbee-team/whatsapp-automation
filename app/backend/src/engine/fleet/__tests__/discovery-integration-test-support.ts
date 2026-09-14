import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import { createRedis } from '../../../platform/redis.js';
import type { DiscoveryDeps } from '../discovery.js';

/**
 * discovery-integration-test-support.ts (FIX-P09-B split) - shared
 * pool/redis globals + seed/cleanup/makeDeps helpers for
 * `discovery.integration.test.ts`, mechanically extracted at FIX-P09-B for
 * the max-lines cap (now split into `discovery-lease.integration.test.ts`
 * and `discovery-escalation.integration.test.ts`). No logic change - same
 * helpers, same behavior. Follows `session-worker-scan.integration.test.ts`'s
 * pool/redis setup + cleanup convention (a plain superuser-role `pool` for
 * seeding and for the discovery scan itself).
 *
 * Lives under `__tests__/` (not flat alongside the split test files) so the
 * tenant-scope guard's own test-path exemption
 * (`(^|/)(__tests__|tests?)/|\.(test|spec)\.tsx?$`) covers its seed/cleanup
 * INSERTs - the same convention `modules/**\/__tests__/*-test-support.ts`
 * already uses repo-wide for real-DB test fixtures.
 */

export type Pool = ReturnType<typeof createPool>;

export async function cleanupProbeClients(p: Pool, clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  // P17 U6 (step 5) - markInfraUnavailableIfChanged now also calls notify();
  // notifications.client_id has no ON DELETE CASCADE, so a leaked row would
  // FK-block the DELETE FROM clients below.
  // FIX (P17 close, gate attempt 4): notify() also writes 3 outbox_events
  // rows per notification; outbox_events has no FK to clients either, so it
  // leaked forever and poisoned any later cross-tenant drainOnce/
  // runOneReconcilerSweep-driving test - same mechanism as the P16 lesson.
  await p.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [clientIds]);
  await p.query('DELETE FROM notifications WHERE client_id = ANY($1)', [clientIds]);
  await p.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [clientIds]);
  await p.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [clientIds]);
  await p.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [clientIds]);
  await p.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [clientIds]);
  await p.query('DELETE FROM clients WHERE id = ANY($1)', [clientIds]);
}

export async function seedInstance(
  p: Pool,
  probeClientIds: string[],
  options: { clientCompanyName: string; label: string },
): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await p.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    options.clientCompanyName,
    `discovery-probe-${clientId}`,
    'active',
  ]);
  await p.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, session_epoch, desired_state, link_state)
     VALUES ($1, $2, $3, 'connected', 0, 'online', 'linked')`,
    [instanceId, clientId, options.label],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

export function makeDiscoveryDeps(
  pool: Pool,
  redis: ReturnType<typeof createRedis>,
  overrides: Partial<DiscoveryDeps> = {},
): DiscoveryDeps {
  return {
    pool,
    redis,
    env: 'test',
    workerId: `discovery-test-${randomUUID()}`,
    admission: { canAcceptLease: () => ({ ok: true, state: 'accepting' }) },
    grab: async () => false,
    markInfraUnavailable: async () => false,
    getLagP99Ms: () => 0,
    getCap: () => 100,
    getCurrentSessions: () => 0,
    staleMs: 1_000,
    maxRows: 500,
    onCycleError: (err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
    ...overrides,
  };
}
