import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { recordOptOut, type OptOutMirrorPort } from '../optout/registry.js';
import { evaluateOptOutGate } from './optout-gate.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });

/**
 * optout-gate.integration.test.ts (P14 Unit U4, step 3) - real Postgres.
 * Mandatory test 16 amendment (phase file, verbatim): "'system_reply' is
 * exempt from pacing but NOT from the opt-out gate" - proved directly
 * against a real `opt_outs` row via `recordOptOut`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-gate-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('evaluateOptOutGate (P14 Unit U4, real Postgres)', () => {
  it('blocks_api_send_and_system_reply_for_an_opted_out_contact_but_passes_opt_out_confirmation_and_a_group', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const phoneHash = Buffer.from('optout-gate-phone-hash-fixture-01');

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        { mirror: noopMirror },
      );
    });

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      const apiSend = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'api_send',
      });
      expect(apiSend).toEqual({ ok: false, reason: 'OPT_OUT', retryAt: null });

      // Mandatory test 16 amendment: system_reply is pacing-exempt but NOT
      // opt-out-exempt.
      const systemReply = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'system_reply',
      });
      expect(systemReply).toEqual({ ok: false, reason: 'OPT_OUT', retryAt: null });

      // The ONE origin that passes even for an opted-out contact.
      const confirmation = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'opt_out_confirmation',
      });
      expect(confirmation).toEqual({ ok: true });

      // A group job with the SAME hash still passes - groups are excluded
      // by shape, not by hash equality.
      const groupJob = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: phoneHash,
        isGroup: true,
        sendOrigin: 'api_send',
      });
      expect(groupJob).toEqual({ ok: true });
    });
  });

  it('passes_a_recipient_with_no_opt_out_row_and_a_null_recipient_hash', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    await tenantDb.withTenant(clientId, async (tx: TenantQueryable) => {
      const neverOptedOut = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: Buffer.from('never-opted-out-hash'),
        isGroup: false,
        sendOrigin: 'api_send',
      });
      expect(neverOptedOut).toEqual({ ok: true });

      const nullHash = await evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: null,
        isGroup: false,
        sendOrigin: 'api_send',
      });
      expect(nullHash).toEqual({ ok: true });
    });
  });

  it('is_scoped_to_the_recipients_own_client_never_another_tenants_opt_out', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const phoneHash = Buffer.from('cross-tenant-optout-hash-fixture');

    await tenantDb.withTenant(tenantA.clientId, async (tx: TenantQueryable) => {
      await recordOptOut(
        tx,
        {
          clientId: tenantA.clientId,
          scope: 'client',
          scopeKey: tenantA.clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'inbound_keyword',
        },
        { mirror: noopMirror },
      );
    });

    await tenantDb.withTenant(tenantB.clientId, async (tx: TenantQueryable) => {
      const decision = await evaluateOptOutGate(tx, {
        clientId: tenantB.clientId,
        instanceId: tenantB.instanceId,
        recipientHash: phoneHash,
        isGroup: false,
        sendOrigin: 'api_send',
      });
      expect(decision).toEqual({ ok: true });
    });
  });
});
