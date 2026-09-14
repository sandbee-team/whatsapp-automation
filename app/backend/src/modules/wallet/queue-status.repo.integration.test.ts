import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { readQueueStatus } from './queue-status.repo.js';

/**
 * queue-status.repo.test.ts (P19 Unit U5, step 9) - real Postgres, exact
 * case names from the phase dispatch.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
const probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'queue-status-repo-tests',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('readQueueStatus', () => {
  it('queue_status_counts_waiting_sent_and_failed_per_instance_and_is_tenant_scoped', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);

    await seedQueuedJob(pool, { clientId: tenantA.clientId, instanceId: tenantA.instanceId });
    await seedQueuedJob(pool, { clientId: tenantA.clientId, instanceId: tenantA.instanceId });
    await seedQueuedJob(pool, { clientId: tenantB.clientId, instanceId: tenantB.instanceId });

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO wallet_daily_summary (client_id, day, instance_id, sent_count, debit_minor, credit_minor, refund_minor)
       VALUES ($1, $2, $3, 3, 900, 0, 100)`,
      [tenantA.clientId, today, tenantA.instanceId],
    );
    // Seed one distinct failed job directly (seedQueuedJob only creates
    // 'queued' rows - a failed row needs its own insert). `id` is
    // `bigint GENERATED ALWAYS AS IDENTITY` (migration 0007) - never
    // supplied explicitly.
    await pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, terminal_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 3, 'failed', now(), now(), 1, 5, now())`,
      [
        tenantA.clientId,
        tenantA.instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        JSON.stringify({ text: 'hi' }),
      ],
    );

    const resultA = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      readQueueStatus(tx, tenantA.clientId),
    );

    expect(resultA.workspace.waiting).toBe(2);
    expect(resultA.workspace.sentToday).toBe(3);
    expect(resultA.workspace.failedToday).toBe(1);
    expect(resultA.workspace.spentTodayMinor).toBe(800n); // 900 debit - 100 refund

    const instanceRow = resultA.instances.find((row) => row.instanceId === tenantA.instanceId);
    expect(instanceRow).toBeDefined();
    expect(instanceRow?.waiting).toBe(2);
    expect(instanceRow?.sentToday).toBe(3);
    expect(instanceRow?.failedToday).toBe(1);
    expect(instanceRow?.spentTodayMinor).toBe(800n);

    // Tenant isolation: tenant B's own read must never see tenant A's rows.
    const resultB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      readQueueStatus(tx, tenantB.clientId),
    );
    expect(resultB.workspace.waiting).toBe(1);
    expect(resultB.workspace.sentToday).toBe(0);
    expect(resultB.workspace.spentTodayMinor).toBe(0n);

    // A foreign instanceId (belonging to tenant A) returns nothing for
    // tenant B's own per-instance rows.
    const foreignRow = resultB.instances.find((row) => row.instanceId === tenantA.instanceId);
    expect(foreignRow).toBeUndefined();
  });

  it('queue_status_uses_no_offset_pagination', async () => {
    const { loadNamedQuery } = await import('@wp/db');
    const perInstance = await loadNamedQuery('queue-status', 'queue-status-per-instance');
    const totals = await loadNamedQuery('queue-status', 'queue-status-workspace-totals');
    expect(perInstance.text.toUpperCase()).not.toContain('OFFSET');
    expect(totals.text.toUpperCase()).not.toContain('OFFSET');
  });
});
