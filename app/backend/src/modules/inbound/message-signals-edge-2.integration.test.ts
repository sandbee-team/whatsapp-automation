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
 * message-signals-edge-2.integration.test.ts (P21 E3 hardening) - split out
 * of the sibling `message-signals-edge.integration.test.ts` purely for that
 * file's own max-lines cap (same established split idiom as
 * `optout.integration.test.ts` / `optout-lid-and-body.integration.test.ts`).
 * Real Postgres: a rejecting `onOptedOut` port still leaves the opt-out
 * committed and the handler resolving; two different instances of the same
 * client each get their OWN independent `first_inbound_at` row; and
 * `first_inbound_at` never moves on a second inbound from the same
 * recipient/instance.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'message-signals-edge-2-test',
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

describe('message-signals edge cases part 2 (real Postgres)', () => {
  it('an_onOptedOut_port_that_rejects_still_leaves_the_opt_out_committed_and_the_handler_resolves', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220004';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);
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
        onOptedOut: async () => {
          throw new Error('confirmation port unavailable');
        },
      },
      { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate('STOP') },
    );

    // handleInboundMessageSignals invokes onOptedOut in its OWN try/catch
    // (logs and swallows) strictly AFTER the transaction commits - a
    // rejecting confirmation port must never look like "the opt-out itself
    // was not processed": the function still resolves normally and the
    // committed opt_outs row survives regardless of the port's failure.
    await expect(Promise.resolve(outcome)).resolves.toEqual({
      attribution: 'attributed',
      optedOut: true,
      touched: true,
    });
    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);
  });

  it('the_same_recipient_writing_from_two_different_instances_of_the_same_client_gets_two_independent_first_inbound_at_rows', async () => {
    const { clientId, instanceId: instanceOne } = await seedSendTenant(pool, probeClientIds);
    const { instanceId: instanceTwo } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220005';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);
    const registry = createMetricsRegistry();

    const runFor = (instanceId: string, text: string) =>
      handleInboundMessageSignals(
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
        { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate(text) },
      );

    await runFor(instanceOne, 'hello from instance one');
    await runFor(instanceTwo, 'hello from instance two');

    const rows = await pool.query<{ instance_id: string; first_inbound_at: Date }>(
      `SELECT instance_id, first_inbound_at FROM instance_recipient_contacts
        WHERE client_id = $1 AND recipient_hash = $2 ORDER BY instance_id`,
      [clientId, phoneHash],
    );
    expect(rows.rowCount).toBe(2);
    expect(new Set(rows.rows.map((r) => r.instance_id))).toEqual(
      new Set([instanceOne, instanceTwo]),
    );
    // Both are independently non-null (each instance's own "first" moment).
    for (const row of rows.rows) {
      expect(row.first_inbound_at).not.toBeNull();
    }
  });

  it('first_inbound_at_never_moves_on_a_second_inbound_from_the_same_recipient_same_instance', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220006';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);
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

    await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('first message'),
    });
    const firstRow = await pool.query<{ first_inbound_at: Date }>(
      `SELECT first_inbound_at FROM instance_recipient_contacts
        WHERE client_id = $1 AND instance_id = $2 AND recipient_hash = $3`,
      [clientId, instanceId, phoneHash],
    );
    const firstValue = firstRow.rows[0]!.first_inbound_at;

    await handleInboundMessageSignals(deps, {
      senderJid: waJidFromE164(e164),
      candidate: inboundOptoutCandidate('second message'),
    });
    const secondRow = await pool.query<{ first_inbound_at: Date }>(
      `SELECT first_inbound_at FROM instance_recipient_contacts
        WHERE client_id = $1 AND instance_id = $2 AND recipient_hash = $3`,
      [clientId, instanceId, phoneHash],
    );

    // Exact equality, never just "not null" - a second inbound must not
    // move the timestamp forward OR backward.
    expect(secondRow.rows[0]!.first_inbound_at.getTime()).toBe(firstValue.getTime());
  });
});
