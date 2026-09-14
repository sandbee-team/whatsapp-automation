import { createHash } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { PLATFORM_BLOCKED_WORDS } from '@wp/domain';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { recordOptOut } from '../pacing/optout/registry.js';
import { cleanupWaGroups, seedWaGroup } from './__tests__/groups-test-helpers.js';
import {
  buildGroupSendTestKeyProvider,
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  jobState,
  ledgerFor,
  linkInstance,
  resetMinGap,
  runOneIteration,
} from './__tests__/send-test-helpers.js';

/**
 * send-guards-content.integration.test.ts (P24 groups-messaging, Unit U4a,
 * step 6) - mandatory tests 4 (a group send is never a new conversation)
 * and 5 (a group job skips the opt-out gate and the frequency guard but not
 * the content guards). Max-lines split of `send-guards.integration.test.ts`
 * - see that file's own doc.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let keyProvider: KeyProvider;
let probeClientIds: string[] = [];

const CLOCK_MS = Date.UTC(2026, 8, 6, 10, 0, 0);

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-send-guards-content-test',
  });
  tenantDb = createTenantDb(pool);
  keyProvider = buildGroupSendTestKeyProvider();
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM recipient_send_buckets WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group send content-guard behaviour (P24 groups-messaging, U4a)', () => {
  it('a_group_send_is_never_counted_as_a_new_conversation', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const group = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });
    const before = await ledgerFor(pool, instanceId);

    const enqueued = await enqueueVia(tenantDb, keyProvider, clientId, instanceId, group.groupJid);
    const jobId = await jobIdForPublicId(pool, clientId, enqueued.id);
    const preSend = await jobState(pool, jobId);
    expect(preSend.is_new_conversation).toBe(false);

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.group-newconv-1');
    const claimed = await runOneIteration(tenantDb, pool, { clientId, instanceId, transport });
    expect(claimed).toBe(true);

    const after = await ledgerFor(pool, instanceId);
    expect(after.new_conv_count - before.new_conv_count).toBe(0);
    expect(after.consumed_count - before.consumed_count).toBe(1);
  });

  it('group_jobs_skip_the_optout_gate_and_the_frequency_guard_but_not_the_content_guards', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);

    // (a) an unrelated opt-out + a frequency bucket past the 24h cap for
    // the GROUP's own hash - neither guard applies to a group job.
    const groupA = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });
    const groupAHash = hashRecipient(keyProvider, groupA.groupJid);
    await recordOptOut(
      pool,
      {
        clientId,
        scope: 'client',
        scopeKey: clientId,
        phoneHash: createHash('sha256').update('unrelated-phone').digest(),
        phoneEnc: Buffer.from('unrelated-phone-enc'),
        source: 'manual',
      },
      { mirror: async () => ({ contactsUpdated: 0 }) },
    );
    await pool.query(
      `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
       VALUES ($1, $2, date_trunc('hour', to_timestamp($3 / 1000.0)), 10)`,
      [clientId, groupAHash, CLOCK_MS],
    );

    const enqueuedA = await enqueueVia(
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      groupA.groupJid,
    );
    const transportA = createFakeTransport();
    transportA.queueResolve(0, 'wamid.group-guard-a');
    const claimedA = await runOneIteration(tenantDb, pool, {
      clientId,
      instanceId,
      transport: transportA,
      clockMs: CLOCK_MS,
    });
    expect(claimedA).toBe(true);
    const jobIdA = await jobIdForPublicId(pool, clientId, enqueuedA.id);
    expect((await jobState(pool, jobIdA)).status).toBe('sent');

    // (b) a blocked-word payload still trips the content guard for a group.
    await resetMinGap(pool, instanceId);
    const groupB = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });
    const blockedWord = PLATFORM_BLOCKED_WORDS[0]!.word;
    const enqueuedB = await enqueueVia(
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      groupB.groupJid,
      {
        payload: { text: `please ${blockedWord} now` },
      },
    );
    const claimedB = await runOneIteration(tenantDb, pool, {
      clientId,
      instanceId,
      clockMs: CLOCK_MS,
    });
    expect(claimedB).toBe(false);
    const jobIdB = await jobIdForPublicId(pool, clientId, enqueuedB.id);
    const stateB = await jobState(pool, jobIdB);
    expect(stateB.status).toBe('failed');
    expect(stateB.pacing_deny_reason).toBe('BLOCKED_WORD');

    // (c) an instance window that does not contain the fake clock still
    // defers a group job - the sending window is not bypassed for groups.
    await pool.query(
      `UPDATE instance_pacing_state SET eff_window_start_local = '01:00:00', eff_window_end_local = '02:00:00'
         WHERE instance_id = $1`,
      [instanceId],
    );
    const groupC = await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 5,
    });
    const enqueuedC = await enqueueVia(
      tenantDb,
      keyProvider,
      clientId,
      instanceId,
      groupC.groupJid,
    );
    const claimedC = await runOneIteration(tenantDb, pool, {
      clientId,
      instanceId,
      clockMs: CLOCK_MS,
    });
    expect(claimedC).toBe(false);
    const jobIdC = await jobIdForPublicId(pool, clientId, enqueuedC.id);
    const stateC = await jobState(pool, jobIdC);
    expect(stateC.status).toBe('queued');
    expect(stateC.pacing_deny_reason).toBe('OUTSIDE_WINDOW');
  });
});
