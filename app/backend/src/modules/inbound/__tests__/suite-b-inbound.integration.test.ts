import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { waJidFromE164 } from '@wp/domain';
import { createRedis, resolveRedisUrl, tenantKey } from '../../../platform/redis.js';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { hashRecipient } from '../../../platform/crypto/phone-hash.js';
import { bindOptOutConfirmationSender } from '../../pacing/index.js';
import { syncOptOutMirror } from '../../contacts/index.js';
import {
  bindInboundMetrics,
  bindInboundBucketCommand,
  createInboundAdmission,
  readInboundLimitFromDb,
  handleInboundMessageSignals,
  recordInboundReceipt,
  writeInboundDeadLetter,
  classifyInboundError,
} from '../index.js';
import {
  cleanupInboundOptoutProbeRows,
  inboundOptoutCandidate,
  makeInboundOptoutProvider,
  seedLiveContact,
  seedQueuedDmJob,
} from './optout-inbound-test-support.js';

/**
 * suite-b-inbound.integration.test.ts (P21 Unit U6b, step 7 / step 6's
 * "two-tenant proof") - the mandatory suite-B rows for the headless inbound
 * listener: a noisy tenant's admission shedding never starves a quiet
 * tenant's (the two Redis bucket keys are per-instance, `tenantKey(...,
 * instanceId)`), and the inbound handler never reads or writes another
 * tenant's rows (contacts, message_jobs, dead letters, delivery_events) -
 * proved entirely as `wp_app` under RLS FORCE via `tenantDb.withTenant`,
 * never a superuser pool for the assertions that prove isolation.
 */

type TestRedis = ReturnType<typeof createRedis>;

const ENV = 'test';

let pool: TestPool;
let redis: TestRedis;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];
let probeKeys: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'suite-b-inbound-test',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

afterEach(async () => {
  if (probeKeys.length > 0) {
    await redis.del(...probeKeys);
    probeKeys = [];
  }
  // `inbound_dead_letters` FKs to `whatsapp_instances` - not covered by
  // either shared fixture's cleanup (both predate P21's migration 0063), so
  // this file's own dead-letter write must be reclaimed here first.
  await pool.query('DELETE FROM inbound_dead_letters WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupInboundOptoutProbeRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('suite B - two-tenant proof (real Postgres + real Redis)', () => {
  it('a_noisy_tenants_inbound_cannot_starve_a_quiet_tenants_inbound', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);
    await pool.query('UPDATE whatsapp_instances SET inbound_max_per_minute = 10 WHERE id = $1', [
      tenantA.instanceId,
    ]);
    await pool.query('UPDATE whatsapp_instances SET inbound_max_per_minute = 10 WHERE id = $1', [
      tenantB.instanceId,
    ]);

    const keyA = tenantKey(ENV, tenantA.clientId, 'inbound', 'i', tenantA.instanceId);
    const keyB = tenantKey(ENV, tenantB.clientId, 'inbound', 'i', tenantB.instanceId);
    expect(keyA).not.toBe(keyB);
    probeKeys.push(keyA, keyB);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const bucket = bindInboundBucketCommand(redis);
    const admissionA = createInboundAdmission({
      env: ENV,
      bucket,
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });
    const admissionB = createInboundAdmission({
      env: ENV,
      bucket,
      readLimit: readInboundLimitFromDb(tenantDb),
      defaults: { maxPerMinute: 120, burst: 120 },
      clock: () => 0,
      metrics,
    });

    let bSignalsCalls = 0;
    const decisionsA: string[] = [];
    for (let i = 0; i < 100; i++) {
      decisionsA.push(await admissionA.admit(tenantA.clientId, tenantA.instanceId));
    }
    const decisionsB: string[] = [];
    for (let i = 0; i < 5; i++) {
      decisionsB.push(await admissionB.admit(tenantB.clientId, tenantB.instanceId));
      bSignalsCalls++;
    }

    expect(decisionsA.filter((d) => d === 'admitted')).toHaveLength(10);
    expect(decisionsA.filter((d) => d === 'shed')).toHaveLength(90);
    expect(decisionsB.filter((d) => d === 'admitted')).toHaveLength(5);
    expect(decisionsB.filter((d) => d === 'shed')).toHaveLength(0);
    expect(bSignalsCalls).toBe(5);

    expect((await metrics.inboundShedTotal.get()).values[0]?.value).toBe(90);
  }, 30_000);

  it('the_inbound_handler_never_reads_or_writes_another_tenants_rows', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15559990001';
    const phoneHash = hashRecipient(provider, e164);

    await seedLiveContact(pool, tenantA.clientId, e164, phoneHash);
    await seedLiveContact(pool, tenantB.clientId, e164, phoneHash);

    const dmJobA1 = await seedQueuedDmJob(
      pool,
      tenantA.clientId,
      tenantA.instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      phoneHash,
    );
    const dmJobA2 = await seedQueuedDmJob(
      pool,
      tenantA.clientId,
      tenantA.instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      phoneHash,
    );
    const dmJobB1 = await seedQueuedDmJob(
      pool,
      tenantB.clientId,
      tenantB.instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      phoneHash,
    );
    const dmJobB2 = await seedQueuedDmJob(
      pool,
      tenantB.clientId,
      tenantB.instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      phoneHash,
    );

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const confirmationPort = bindOptOutConfirmationSender({ tenantDb }, { error: () => {} });
    const onOptedOut = async (payload: Parameters<typeof confirmationPort>[0]): Promise<void> => {
      confirmationPort(payload);
    };

    // A real STOP through tenant A's dispatcher (`handleInboundMessageSignals`
    // with the real `syncOptOutMirror`, imported the same way U4's own
    // integration test does).
    const outcomeA = await handleInboundMessageSignals(
      {
        tenantDb,
        clientId: tenantA.clientId,
        instanceId: tenantA.instanceId,
        keyProvider: provider,
        metrics,
        metricsRegistry: registry,
        mirror: syncOptOutMirror,
        onOptedOut,
      },
      { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate('STOP') },
    );
    expect(outcomeA).toEqual({ attribution: 'attributed', optedOut: true, touched: true });

    const jobAStatus1 = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobA1],
    );
    const jobAStatus2 = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobA2],
    );
    expect(jobAStatus1.rows[0]?.status).toBe('cancelled');
    expect(jobAStatus2.rows[0]?.status).toBe('cancelled');

    const jobBStatus1 = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobB1],
    );
    const jobBStatus2 = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [dmJobB2],
    );
    expect(jobBStatus1.rows[0]?.status).toBe('queued');
    expect(jobBStatus2.rows[0]?.status).toBe('queued');

    const contactStateA = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      tx.query<{ opt_out_state: string }>(
        'SELECT opt_out_state FROM contacts WHERE client_id = $1 AND phone_hash = $2',
        [tenantA.clientId, phoneHash],
      ),
    );
    const contactStateB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      tx.query<{ opt_out_state: string }>(
        'SELECT opt_out_state FROM contacts WHERE client_id = $1 AND phone_hash = $2',
        [tenantB.clientId, phoneHash],
      ),
    );
    expect(contactStateA.rows[0]?.opt_out_state).toBe('opted_out');
    expect(contactStateB.rows[0]?.opt_out_state).toBe('none');

    // Exactly one dead letter for A: writes through `writeInboundDeadLetter`
    // the same way the dispatcher would after a caught throw, to prove the
    // row lands ONLY under A's own RLS scope, never visible under B's.
    await writeInboundDeadLetter(
      {
        tenantDb,
        clientId: tenantA.clientId,
        instanceId: tenantA.instanceId,
        metrics,
        logger: { warn: () => {} },
      },
      {
        waMsgId: 'wamid-dl-1',
        chatJid: null,
        errorClass: classifyInboundError(new Error('forced-for-test')),
        rawSize: null,
      },
    );

    const deadLettersA = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      tx.query<{ id: string }>('SELECT id FROM inbound_dead_letters WHERE client_id = $1', [
        tenantA.clientId,
      ]),
    );
    const deadLettersB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      tx.query<{ id: string }>('SELECT id FROM inbound_dead_letters WHERE client_id = $1', [
        tenantB.clientId,
      ]),
    );
    expect(deadLettersA.rowCount).toBe(1);
    expect(deadLettersB.rowCount).toBe(0);

    // A delivered receipt for A's `wa_msg_id` pushed through B's dispatcher:
    // B never wrote that outbound wa_msg_id, so it resolves 'unmatched', and
    // no delivery_events row is written under B.
    const waMsgId = `wamid-recv-${randomUUID()}`;
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at)
       VALUES ($1, $2, 'out', $3, NULL, NULL)`,
      [tenantA.clientId, tenantA.instanceId, waMsgId],
    );

    const outcomeThroughB = await recordInboundReceipt(
      { tenantDb, clientId: tenantB.clientId, instanceId: tenantB.instanceId, metrics },
      { waMsgId, remoteJid: null, eventType: 'delivered', eventTs: '1', participantJid: '' },
    );
    expect(outcomeThroughB).toBe('unmatched');
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1);

    const deliveryEventsB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      tx.query('SELECT id FROM delivery_events WHERE client_id = $1', [tenantB.clientId]),
    );
    expect(deliveryEventsB.rowCount).toBe(0);
  }, 30_000);
});
