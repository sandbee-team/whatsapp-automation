import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { TransportSendError } from '../../provider/provider.types.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  resolveAck,
  resolveFailure,
  type ResolveAckInput,
  type ResolveFailureInput,
  type ResultDeps,
} from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { seedWaGroup, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import {
  seedGroupDispatchedAttempt,
  seedDmDispatchedAttempt,
} from './__tests__/forbidden-test-helpers.js';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * forbidden.integration.test.ts (P24 Unit U4b, step 7) - real Postgres proof
 * that a `group_forbidden` terminal send failure never touches instance/
 * pacing health and is terminal (never retried). The sibling-group isolation
 * + dedupe case, the DM-still-pauses regression, and the structural health-
 * writers scan live in `forbidden-edge.integration.test.ts` (max-lines split,
 * same fixture set).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-forbidden-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveFailure - group_forbidden (real Postgres)', () => {
  it('a_group_forbidden_error_never_pauses_the_instance', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
    });

    const before = await pool.query<{ health_state: string; pause_reason: string | null }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    const pacingBefore = await pool.query<{ health_score: number; health_band: string }>(
      'SELECT health_score, health_band FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    const pacingEventsBefore = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pacing_events WHERE client_id = $1',
      [clientId],
    );

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const failureInput: ResolveFailureInput = {
      clientId,
      instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      attempts: 1,
      maxAttempts: 5,
      error: new TransportSendError('group_forbidden', 'not-admin'),
      recipientJid: targetGroup.groupJid,
    };
    await resolveFailure(failureInput, deps);

    const after = await pool.query<{ health_state: string; pause_reason: string | null }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    const pacingAfter = await pool.query<{ health_score: number; health_band: string }>(
      'SELECT health_score, health_band FROM instance_pacing_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(pacingAfter.rows[0]).toEqual(pacingBefore.rows[0]);

    const pacingEventsAfter = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pacing_events WHERE client_id = $1',
      [clientId],
    );
    expect(pacingEventsAfter.rows[0]?.count).toBe(pacingEventsBefore.rows[0]?.count);

    const restrictionAudits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE client_id = $1 AND metadata->>'reason' = 'restriction_signal'`,
      [clientId],
    );
    expect(restrictionAudits.rows[0]?.count).toBe('0');

    // A DM on the SAME instance still sends fine afterward - the instance
    // itself was never touched.
    const dm = await seedDmDispatchedAttempt(pool, clientId, instanceId);
    const ackInput: ResolveAckInput = {
      clientId,
      instanceId,
      jobId: dm.jobId,
      jobCreatedAt: dm.jobCreatedAt,
      leaseId: dm.leaseId,
      attemptNo: 1,
      publicId: dm.publicId,
      outcome: { providerMsgId: 'wamid.dm-1' },
      payloadKind: 'text',
      recipientJid: dm.recipientJid,
    };
    await resolveAck(ackInput, deps);
    const dmRow = await getJobResultRow(pool, dm.jobId);
    expect(dmRow.status).toBe('sent');
  });

  it('a_group_forbidden_error_is_terminal_and_never_retried', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const seeded = await seedGroupDispatchedAttempt(pool, {
      clientId,
      instanceId,
      groupJid: targetGroup.groupJid,
      attempts: 0,
    });

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    await resolveFailure(
      {
        clientId,
        instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        attempts: 1,
        maxAttempts: 5,
        error: new TransportSendError('group_forbidden', 'announce-mode'),
        recipientJid: targetGroup.groupJid,
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('failed');
    expect(jobRow.last_error_class).toBe('group_forbidden');
    expect(jobRow.attempts).toBe(0); // resolveFailure never increments attempts itself.
    expect(jobRow.next_attempt_at === null || jobRow.next_attempt_at.getTime() <= Date.now()).toBe(
      true,
    );

    const attemptRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM send_attempts WHERE message_job_id = $1',
      [seeded.jobId],
    );
    expect(attemptRows.rows[0]?.count).toBe('1');

    const deliveryRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM delivery_events
        WHERE client_id = $1 AND message_job_id = $2 AND event_type = 'failed'`,
      [clientId, seeded.jobId],
    );
    expect(deliveryRows.rows[0]?.count).toBe('1');

    const requeued = await pool.query('SELECT 1 FROM message_jobs WHERE id = $1 AND status = $2', [
      seeded.jobId,
      'queued',
    ]);
    expect(requeued.rows.length).toBe(0);
  });
});
