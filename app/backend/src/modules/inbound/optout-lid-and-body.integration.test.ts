import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { bindInboundMetrics } from './metrics.js';
import { handleInboundMessageSignals } from './message-signals.js';
import {
  cleanupInboundOptoutProbeRows,
  inboundOptoutCandidate,
  makeInboundOptoutProvider,
  seedLiveContact,
} from './__tests__/optout-inbound-test-support.js';

/**
 * optout-lid-and-body.integration.test.ts (P21 Unit U4, step 5) - the
 * real-Postgres mandatory cases for the `@lid`-unattributable path and the
 * plain-inbound contact-touch path (max-lines split out of the sibling
 * `optout.integration.test.ts`, which owns the STOP-keyword cases; both
 * share `optout-inbound-test-support.ts`'s fixtures).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-inbound-lid-body-test',
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

describe('inbound message signals - lid attribution and body storage (P21 Unit U4, real Postgres)', () => {
  it('a_lid_only_sender_is_recorded_unattributable_not_misattributed', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15551110006';
    const phoneHash = hashRecipient(provider, e164);
    const contactId = await seedLiveContact(pool, clientId, e164, phoneHash);
    const lidJid = '12345678901234@lid';

    const registry = createMetricsRegistry();
    const deps = {
      tenantDb,
      clientId,
      instanceId,
      keyProvider: provider,
      metrics: bindInboundMetrics(registry),
      metricsRegistry: registry,
      mirror: async () => ({ contactsUpdated: 0 }),
      onOptedOut: async () => {},
    };

    const firstOutcome = await handleInboundMessageSignals(deps, {
      senderJid: lidJid,
      candidate: inboundOptoutCandidate('STOP'),
    });
    expect(firstOutcome).toEqual({
      attribution: 'unattributable',
      optedOut: false,
      touched: false,
    });

    const optOutRowsBefore = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [
      clientId,
    ]);
    expect(optOutRowsBefore.rowCount).toBe(0);
    const contactBefore = await pool.query<{ last_inbound_at: Date | null }>(
      'SELECT last_inbound_at FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(contactBefore.rows[0]?.last_inbound_at).toBeNull();

    const snapshotBefore = await registry.metricsText();
    expect(snapshotBefore).toMatch(/wp_optout_unattributable_total 1/);

    await pool.query('UPDATE contacts SET lid_jid = $1 WHERE id = $2', [lidJid, contactId]);

    const secondOutcome = await handleInboundMessageSignals(deps, {
      senderJid: lidJid,
      candidate: inboundOptoutCandidate('STOP'),
    });
    expect(secondOutcome).toEqual({ attribution: 'attributed', optedOut: true, touched: true });

    const optOutRowsAfter = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [
      clientId,
    ]);
    expect(optOutRowsAfter.rowCount).toBe(1);
  });

  it('an_inbound_message_updates_last_inbound_at_and_first_inbound_at_and_stores_no_body', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15551110007';
    const phoneHash = hashRecipient(provider, e164);
    const contactId = await seedLiveContact(pool, clientId, e164, phoneHash);
    const registry = createMetricsRegistry();
    const sentinel = 'secret-body-sentinel';

    const deps = {
      tenantDb,
      clientId,
      instanceId,
      keyProvider: provider,
      metrics: bindInboundMetrics(registry),
      metricsRegistry: registry,
      mirror: async () => ({ contactsUpdated: 0 }),
      onOptedOut: async () => {},
    };

    const firstOutcome = await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate(`hello there +919876543210 ${sentinel}`),
    });
    expect(firstOutcome).toEqual({ attribution: 'attributed', optedOut: false, touched: true });

    const afterFirst = await pool.query<{ last_inbound_at: Date | null }>(
      'SELECT last_inbound_at FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(afterFirst.rows[0]?.last_inbound_at).not.toBeNull();
    const ircAfterFirst = await pool.query<{ first_inbound_at: Date | null }>(
      'SELECT first_inbound_at FROM instance_recipient_contacts WHERE client_id = $1 AND instance_id = $2 AND recipient_hash = $3',
      [clientId, instanceId, phoneHash],
    );
    const firstInboundAt = ircAfterFirst.rows[0]?.first_inbound_at ?? null;
    expect(firstInboundAt).not.toBeNull();

    // Backdate both timestamps by a fixed, deterministic 1 hour (never a
    // real sleep - core-invariants.md's ambient-state rule) so the second
    // call's `now()` is provably later without any wall-clock wait.
    await pool.query(
      "UPDATE contacts SET last_inbound_at = last_inbound_at - interval '1 hour' WHERE id = $1",
      [contactId],
    );
    await pool.query(
      `UPDATE instance_recipient_contacts SET first_inbound_at = first_inbound_at - interval '1 hour'
        WHERE client_id = $1 AND instance_id = $2 AND recipient_hash = $3`,
      [clientId, instanceId, phoneHash],
    );
    const backdatedFirstInboundAt = new Date(firstInboundAt!.getTime() - 60 * 60 * 1000);

    await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('hello again, no keyword here'),
    });

    const afterSecond = await pool.query<{ last_inbound_at: Date }>(
      'SELECT last_inbound_at FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(afterSecond.rows[0]?.last_inbound_at.getTime()).toBeGreaterThan(
      afterFirst.rows[0]!.last_inbound_at!.getTime(),
    );
    const ircAfterSecond = await pool.query<{ first_inbound_at: Date }>(
      'SELECT first_inbound_at FROM instance_recipient_contacts WHERE client_id = $1 AND instance_id = $2 AND recipient_hash = $3',
      [clientId, instanceId, phoneHash],
    );
    expect(ircAfterSecond.rows[0]!.first_inbound_at.getTime()).toBe(
      backdatedFirstInboundAt.getTime(),
    );

    const snapshot = await registry.metricsText();
    const detectedMatches = snapshot.match(/wp_optout_detected_total (\d+)/);
    expect(detectedMatches?.[1]).toBe('0');

    const scanColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND (data_type IN ('text','character varying','json','jsonb') OR data_type = 'ARRAY')`,
      [
        [
          'contacts',
          'instance_recipient_contacts',
          'opt_outs',
          'optout_confirmations',
          'message_jobs',
          'delivery_events',
          'inbound_dead_letters',
          'audit_logs',
        ],
      ],
    );
    for (const { table_name: tableName, column_name: columnName } of scanColumns.rows) {
      const hit = await pool.query(
        `SELECT 1 FROM ${tableName} WHERE client_id = $1 AND ${columnName}::text LIKE $2 LIMIT 1`,
        [clientId, `%${sentinel}%`],
      );
      expect(hit.rowCount, `${tableName}.${columnName} unexpectedly carried the sentinel`).toBe(0);
    }
  });
});
