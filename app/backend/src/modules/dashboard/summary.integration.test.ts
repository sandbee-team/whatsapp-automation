import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { readDashboardSummary } from './summary.service.js';

/**
 * summary.integration.test.ts (P17 carried item) - `readDashboardSummary`
 * against real Postgres: the shape matches the `@wp/contracts` dashboard
 * contract exactly, and one tenant's numbers never leak into another
 * tenant's summary (tenant isolation, core invariant 4).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'dashboard-test' });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedQueuedJob(clientId: string, instanceId: string): Promise<void> {
  const recipientJid = `${crypto.randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  await pool.query(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(), 0, 5, false)`,
    [
      clientId,
      instanceId,
      recipientJid,
      Buffer.from(`dashboard-recipient-${crypto.randomUUID()}`),
      JSON.stringify({ text: 'hello' }),
    ],
  );
}

describe('readDashboardSummary (P17 carried item, real Postgres)', () => {
  it('shape_matches_the_contract_exactly', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await pool.query(
      `UPDATE whatsapp_instances SET health_state = 'connected' WHERE id = $1 AND client_id = $2`,
      [instanceId, clientId],
    );
    await seedQueuedJob(clientId, instanceId);

    const summary = await readDashboardSummary(tenantDb, { clientId });

    expect(Object.keys(summary).sort()).toEqual(['connectedNumbers', 'queued', 'sent'].sort());
    expect(summary.connectedNumbers).toBe(1);
    expect(summary.queued).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it('tenant_bs_numbers_never_leak_into_tenant_as_summary', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);
    await pool.query(
      `UPDATE whatsapp_instances SET health_state = 'connected' WHERE id = $1 AND client_id = $2`,
      [tenantA.instanceId, tenantA.clientId],
    );
    await pool.query(
      `UPDATE whatsapp_instances SET health_state = 'connected' WHERE id = $1 AND client_id = $2`,
      [tenantB.instanceId, tenantB.clientId],
    );
    await seedQueuedJob(tenantA.clientId, tenantA.instanceId);
    await seedQueuedJob(tenantB.clientId, tenantB.instanceId);
    await seedQueuedJob(tenantB.clientId, tenantB.instanceId);

    const summaryA = await readDashboardSummary(tenantDb, { clientId: tenantA.clientId });
    const summaryB = await readDashboardSummary(tenantDb, { clientId: tenantB.clientId });

    expect(summaryA.connectedNumbers).toBe(1);
    expect(summaryA.queued).toBe(1);
    expect(summaryB.connectedNumbers).toBe(1);
    expect(summaryB.queued).toBe(2);
  });
});
