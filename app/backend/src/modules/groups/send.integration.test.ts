import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createMessage } from '../messages/messages.service.js';
import { cleanupWaGroups, seedWaGroup } from './__tests__/groups-test-helpers.js';
import {
  buildGroupSendTestKeyProvider,
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  ledgerFor,
  linkInstance,
  resetMinGap,
  runOneIteration,
} from './__tests__/send-test-helpers.js';

/**
 * send.integration.test.ts (P24 groups-messaging, Unit U4a, step 6) - the
 * group send path at enqueue time, driven end-to-end through the REAL
 * `createMessage` enqueue service and the REAL claim -> reserve -> dispatch
 * -> resolveAck/resolveFailure send loop (never a hand-inserted job row -
 * the enqueue branch itself is what mandatory tests 7/8 exercise). Mandatory
 * tests 1 (unit consumption) and 7 (API-time rejection) live here; tests
 * 2-6 and 8 live in the sibling `send-guards.integration.test.ts` (max-lines
 * split, same idiom as `pipeline.integration.test.ts` /
 * `pipeline-disposal-loop.integration.test.ts`).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-send-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildGroupSendTestKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // The guard pipeline's duplicate-fanout check writes these on every
    // real send loop pass - `cleanupSendProbeClients` predates this suite's
    // content-guard traffic and does not know about them.
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group send path at enqueue time (P24 groups-messaging, U4a)', () => {
  it('a_group_send_consumes_one_general_unit_and_one_group_unit', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const group = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 20,
    });

    const before = await ledgerFor(pool, instanceId);

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.group-send-1');
    transport.queueResolve(0, 'wamid.dm-send-1');

    const group1 = await enqueueVia(tenantDb, keyProvider, clientId, instanceId, group.groupJid);
    const dmJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
    const dm1 = await enqueueVia(tenantDb, keyProvider, clientId, instanceId, dmJid);

    const firstClaimed = await runOneIteration(tenantDb, pool, { clientId, instanceId, transport });
    expect(firstClaimed).toBe(true);
    await resetMinGap(pool, instanceId);
    const secondClaimed = await runOneIteration(tenantDb, pool, {
      clientId,
      instanceId,
      transport,
    });
    expect(secondClaimed).toBe(true);

    const after = await ledgerFor(pool, instanceId);
    expect(after.consumed_count - before.consumed_count).toBe(2);
    expect(after.group_sent_count - before.group_sent_count).toBe(1);
    expect(after.new_conv_count - before.new_conv_count).toBe(0);

    const groupJobId = await jobIdForPublicId(pool, clientId, group1.id);
    const dmJobId = await jobIdForPublicId(pool, clientId, dm1.id);
    const groupJob = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [groupJobId],
    );
    const dmJob = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobId],
    );
    expect(groupJob.rows[0]?.status).toBe('sent');
    expect(dmJob.rows[0]?.status).toBe('sent');
  });

  it('a_group_that_is_not_send_enabled_is_rejected_at_the_api_with_no_job_row', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {});
    await linkInstance(pool, instanceId);
    const notEnabled = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: false,
      participantCount: 5,
    });
    const announce = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      isAnnounce: true,
      ourRole: 'member',
      participantCount: 5,
    });
    const unknownJid = '120363999999999999@g.us';
    const tier3Enabled = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });

    const beforeCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1`,
      [clientId],
    );

    const attempt = async (jid: string) => {
      return createMessage(
        tenantDb,
        {
          clientId,
          instanceId,
          idempotencyKey: randomUUID(),
          requestBody: { recipient: jid },
          recipient: { jid, e164: null },
          payload: { text: 'hi' },
          payloadKind: 'text',
          priority: 'normal',
          scheduledAt: null,
          sendOrigin: 'api_send',
        },
        { keyProvider },
      );
    };

    await expect(attempt(notEnabled.groupJid)).rejects.toMatchObject({
      code: 'GROUP_NOT_SENDABLE',
      details: { reason: 'NOT_SEND_ENABLED' },
    });
    await expect(attempt(announce.groupJid)).rejects.toMatchObject({
      code: 'GROUP_NOT_SENDABLE',
      details: { reason: 'ANNOUNCE_MEMBER_ONLY' },
    });
    await expect(attempt(unknownJid)).rejects.toMatchObject({
      code: 'GROUP_NOT_SENDABLE',
      details: { reason: 'NOT_SEND_ENABLED' },
    });

    const okResult = await attempt(tier3Enabled.groupJid);
    expect(okResult.status).toBe('queued');

    const afterCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1`,
      [clientId],
    );
    expect(Number(afterCount.rows[0]?.count) - Number(beforeCount.rows[0]?.count)).toBe(1);
  });
});
