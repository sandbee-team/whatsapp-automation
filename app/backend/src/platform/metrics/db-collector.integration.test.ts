import { randomUUID } from 'node:crypto';
import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../db/db-url.js';
import { createDbMetricsCollector } from './db-collector.js';
import { bindRollupMetrics } from './rollup-metrics.js';

/**
 * db-collector.integration.test.ts (P25 observability-and-runbook, Unit U3)
 * - real Postgres. Two tenants seeded (invariant 4 - the scrape text must
 * carry neither tenant's ids); asserts EXACT deltas against a baseline
 * counted before seeding (never a raw absolute count, which would be
 * polluted by any other row already in the dev DB).
 */

type TestPool = ReturnType<typeof createPool>;

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'rollup-collector-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedClient(companyName: string): Promise<string> {
  const clientId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    companyName,
    `rollup-probe-${clientId}`,
    'active',
  ]);
  probeClientIds.push(clientId);
  return clientId;
}

async function seedInstance(
  clientId: string,
  options: { label: string; healthState: string; desiredState: string },
): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, session_epoch, desired_state, link_state)
     VALUES ($1, $2, $3, $4, 0, $5, 'linked')`,
    [instanceId, clientId, options.label, options.healthState, options.desiredState],
  );
  return instanceId;
}

async function seedJobWithStatus(
  clientId: string,
  instanceId: string,
  status: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, $5, now(), now())`,
    [clientId, instanceId, '15550000000@s.whatsapp.net', JSON.stringify({ text: 'hello' }), status],
  );
}

async function countFleetRow(): Promise<{
  instances_connected: number;
  instances_desired_online: number;
  jobs_blocked_needs_review: number;
  jobs_needs_reconcile: number;
  messages_out_without_job: number;
}> {
  const result = await pool.query<{
    instances_connected: string;
    instances_desired_online: string;
    jobs_blocked_needs_review: string;
    jobs_needs_reconcile: string;
    messages_out_without_job: string;
  }>(
    `SELECT
       (SELECT count(*)::int FROM whatsapp_instances WHERE desired_state = 'online' AND deleted_at IS NULL AND health_state = 'connected') AS instances_connected,
       (SELECT count(*)::int FROM whatsapp_instances WHERE desired_state = 'online' AND deleted_at IS NULL) AS instances_desired_online,
       (SELECT count(*)::int FROM message_jobs WHERE status = 'blocked_needs_review') AS jobs_blocked_needs_review,
       (SELECT count(*)::int FROM message_jobs WHERE status = 'needs_reconcile') AS jobs_needs_reconcile,
       (SELECT count(*)::int FROM message_wa_ids WHERE direction = 'out' AND message_id IS NULL AND observed_at IS NULL) AS messages_out_without_job`,
  );
  const row = result.rows[0]!;
  return {
    instances_connected: Number(row.instances_connected),
    instances_desired_online: Number(row.instances_desired_online),
    jobs_blocked_needs_review: Number(row.jobs_blocked_needs_review),
    jobs_needs_reconcile: Number(row.jobs_needs_reconcile),
    messages_out_without_job: Number(row.messages_out_without_job),
  };
}

describe('the fleet rollup collector - real Postgres', () => {
  it('fleet_rollups_are_exact_counts', async () => {
    const baseline = await countFleetRow();

    const clientA = await seedClient('Rollup Probe Client A');
    const clientB = await seedClient('Rollup Probe Client B');
    const connectedInstance = await seedInstance(clientA, {
      label: 'connected',
      healthState: 'connected',
      desiredState: 'online',
    });
    await seedInstance(clientA, {
      label: 'degraded',
      healthState: 'degraded',
      desiredState: 'online',
    });
    await seedInstance(clientB, {
      label: 'parked',
      healthState: 'never_linked',
      desiredState: 'offline',
    });
    await seedJobWithStatus(clientA, connectedInstance, 'blocked_needs_review');
    await seedJobWithStatus(clientA, connectedInstance, 'needs_reconcile');

    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const collector = createDbMetricsCollector({ pool, metrics });

    const outcome = await collector.runOnce();
    expect(outcome).toBe('ran');

    const after = await countFleetRow();
    expect(after.instances_connected - baseline.instances_connected).toBe(1);
    expect(after.instances_desired_online - baseline.instances_desired_online).toBe(2);
    expect(after.jobs_blocked_needs_review - baseline.jobs_blocked_needs_review).toBe(1);
    expect(after.jobs_needs_reconcile - baseline.jobs_needs_reconcile).toBe(1);

    const text = await registry.metricsText();
    expect(text).not.toContain(clientA);
    expect(text).not.toContain(clientB);
    expect(text).not.toContain('instance_id=');
    expect(text).not.toContain('client_id=');
  });

  it('echo_evidence_rows_are_not_counted_as_messages_without_job', async () => {
    const clientA = await seedClient('Rollup Probe Client Echo');
    const instanceId = await seedInstance(clientA, {
      label: 'echo-probe',
      healthState: 'connected',
      desiredState: 'online',
    });

    const baseline = await countFleetRow();

    const evidenceWaMsgId = `echo-${randomUUID()}`;
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, observed_at)
       VALUES ($1, $2, 'out', $3, NULL, now())`,
      [clientA, instanceId, evidenceWaMsgId],
    );

    const registry = createMetricsRegistry();
    const metrics = bindRollupMetrics(registry);
    const collector = createDbMetricsCollector({ pool, metrics });
    await collector.runOnce();

    const afterEcho = await countFleetRow();
    expect(afterEcho.messages_out_without_job - baseline.messages_out_without_job).toBe(0);

    const unresolvedWaMsgId = `unresolved-${randomUUID()}`;
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, observed_at)
       VALUES ($1, $2, 'out', $3, NULL, NULL)`,
      [clientA, instanceId, unresolvedWaMsgId],
    );

    await collector.runOnce();
    const afterUnresolved = await countFleetRow();
    expect(afterUnresolved.messages_out_without_job - baseline.messages_out_without_job).toBe(1);

    await pool.query(
      'DELETE FROM message_wa_ids WHERE client_id = $1 AND instance_id = $2 AND wa_msg_id = ANY($3)',
      [clientA, instanceId, [evidenceWaMsgId, unresolvedWaMsgId]],
    );
  });
});
