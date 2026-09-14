import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { waJidFromE164 } from '@wp/domain';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { bindOptOutConfirmationSender } from '../pacing/index.js';
import { bindInboundMetrics } from './metrics.js';
import { handleInboundMessageSignals } from './message-signals.js';
import {
  cleanupInboundOptoutProbeRows,
  inboundOptoutCandidate,
  makeInboundOptoutProvider,
  seedLiveContact,
  seedQueuedDmJob,
} from './__tests__/optout-inbound-test-support.js';

/**
 * optout.integration.test.ts (P21 Unit U4, step 5) - the real-Postgres
 * mandatory cases for the STOP-keyword half: one inbound STOP writes
 * exactly one `opt_outs` row and cancels only the DM jobs (never the group
 * job, never `failed`), a replayed STOP produces exactly one confirmation,
 * and Hindi/Hinglish keywords are detected end-to-end. The `@lid`-
 * unattributable and plain-inbound-touch halves live in the sibling
 * `optout-lid-and-body.integration.test.ts` (max-lines split, see this
 * file's own fixture support module for the shared helpers).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-inbound-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupInboundOptoutProbeRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('inbound message signals - STOP keyword (P21 Unit U4, real Postgres)', () => {
  it('an_inbound_stop_keyword_writes_one_optout_and_cancels_queued_jobs', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15551110001';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);

    const dmJobIds = await Promise.all([
      seedQueuedDmJob(
        pool,
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        phoneHash,
      ),
      seedQueuedDmJob(
        pool,
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        phoneHash,
      ),
      seedQueuedDmJob(
        pool,
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        phoneHash,
      ),
    ]);
    const groupJobId = await seedQueuedDmJob(
      pool,
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}-group@g.us`,
      phoneHash,
    );

    const registry = createMetricsRegistry();
    const outcome = await handleInboundMessageSignals(
      {
        tenantDb,
        clientId,
        instanceId,
        keyProvider: provider,
        metrics: bindInboundMetrics(registry),
        metricsRegistry: registry,
        mirror: async () => ({ contactsUpdated: 0 }),
        onOptedOut: async () => {},
      },
      { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate('STOP') },
    );

    expect(outcome).toEqual({ attribution: 'attributed', optedOut: true, touched: true });

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);

    for (const jobId of dmJobIds) {
      const status = await pool.query<{ status: string; cancel_reason: string | null }>(
        'SELECT status, cancel_reason FROM message_jobs WHERE id = $1',
        [jobId],
      );
      expect(status.rows[0]?.status).toBe('cancelled');
      expect(status.rows[0]?.cancel_reason).toBe('opt_out');
    }
    const failedCount = await pool.query(
      `SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1 AND status = 'failed'`,
      [clientId],
    );
    expect(failedCount.rows[0]?.n).toBe(0);

    const allJobs = await pool.query(
      'SELECT count(*)::int AS n FROM message_jobs WHERE client_id = $1',
      [clientId],
    );
    expect(allJobs.rows[0]?.n).toBe(4);

    const groupStatus = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [groupJobId],
    );
    expect(groupStatus.rows[0]?.status).toBe('queued');

    const contactState = await pool.query<{ opt_out_state: string }>(
      'SELECT opt_out_state FROM contacts WHERE client_id = $1 AND phone_hash = $2',
      [clientId, phoneHash],
    );
    expect(contactState.rows[0]?.opt_out_state).toBe('none');
  });

  it('a_replayed_stop_message_writes_one_optout_and_one_confirmation', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15551110002';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);

    const registry = createMetricsRegistry();
    // `bindOptOutConfirmationSender` returns a synchronous, fire-and-forget
    // `OnOptedOutPort` (`(input) => void`); `MessageSignalsDeps.onOptedOut`
    // is `Promise<void>` (this module's own contract - U6 wires the same
    // adapter shape at the real composition point).
    const confirmationPort = bindOptOutConfirmationSender({ tenantDb }, { error: () => {} });
    const onOptedOut = async (payload: Parameters<typeof confirmationPort>[0]): Promise<void> => {
      confirmationPort(payload);
    };

    const deps = {
      tenantDb,
      clientId,
      instanceId,
      keyProvider: provider,
      metrics: bindInboundMetrics(registry),
      metricsRegistry: registry,
      mirror: async () => ({ contactsUpdated: 0 }),
      onOptedOut,
    };

    await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('STOP'),
    });
    await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('STOP'),
    });

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);

    // `bindOptOutConfirmationSender`'s port is deliberately fire-and-forget
    // (production semantics - an opt-out CONFIRMATION never blocks or fails
    // the opt-out itself, see that port's own doc); `vi.waitFor` polls the
    // real write it produces rather than asserting on any wall-clock margin
    // (core-invariants.md's ambient-state rule governs timing MARGINS, not
    // waiting for a genuinely async, already-triggered write to land).
    await vi.waitFor(async () => {
      const confirmationRows = await pool.query(
        'SELECT phone_hash FROM optout_confirmations WHERE client_id = $1',
        [clientId],
      );
      expect(confirmationRows.rowCount).toBe(1);
    });

    const confirmationJobs = await pool.query(
      `SELECT id FROM message_jobs WHERE client_id = $1 AND send_origin = 'opt_out_confirmation'`,
      [clientId],
    );
    expect(confirmationJobs.rowCount).toBe(1);

    const inboundMessageWaIds = await pool.query(
      `SELECT wa_msg_id FROM message_wa_ids WHERE client_id = $1 AND direction = 'in'`,
      [clientId],
    );
    expect(inboundMessageWaIds.rowCount).toBe(0);
  });

  it('a_hindi_or_hinglish_stop_is_detected_end_to_end', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const phrases = ['band karo', 'बंद करो', 'रोको'];
    const registry = createMetricsRegistry();

    for (const [index, phrase] of phrases.entries()) {
      const e164 = `+1555111100${String(3 + index)}`;
      const phoneHash = hashRecipient(provider, e164);
      await seedLiveContact(pool, clientId, e164, phoneHash);

      const outcome = await handleInboundMessageSignals(
        {
          tenantDb,
          clientId,
          instanceId,
          keyProvider: provider,
          metrics: bindInboundMetrics(registry),
          metricsRegistry: registry,
          mirror: async () => ({ contactsUpdated: 0 }),
          onOptedOut: async () => {},
        },
        { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate(phrase) },
      );
      expect(outcome.optedOut).toBe(true);
    }

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(3);
  });
});
