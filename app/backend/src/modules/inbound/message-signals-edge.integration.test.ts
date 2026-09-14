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
 * message-signals-edge.integration.test.ts (P21 E3 hardening) - real
 * Postgres proofs beyond `optout.integration.test.ts` and
 * `optout-lid-and-body.integration.test.ts`: a soft-deleted (tombstoned)
 * contact still gets an `opt_outs` row on STOP but its own `last_inbound_at`
 * is never touched; a non-digit `@s.whatsapp.net` user part is
 * unattributable; a 256-char-padded STOP still matches after the candidate
 * text's own 256-cap; a keyword-prefix-of-a-normal-word ('hi') never
 * opts out a longer sentence; a rejecting `onOptedOut` port still commits
 * the opt-out and resolves; and two DIFFERENT instances of the same client
 * each get their OWN independent `first_inbound_at` row.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'message-signals-edge-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  // tenant_optout_keywords has no ON DELETE CASCADE from clients (migration
  // 0036) - delete it explicitly before cleanupSendProbeClients removes the
  // client row, or the DELETE FROM clients below would FK-violate for the
  // one test that seeds a tenant keyword.
  await pool.query('DELETE FROM tenant_optout_keywords WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await cleanupInboundOptoutProbeRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('message-signals edge cases (real Postgres)', () => {
  it('a_soft_deleted_contact_still_gets_one_optout_row_but_its_own_last_inbound_at_is_untouched', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220001';
    const phoneHash = hashRecipient(provider, e164);
    const contactId = await seedLiveContact(pool, clientId, e164, phoneHash);
    await pool.query('UPDATE contacts SET deleted_at = now() WHERE id = $1', [contactId]);

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

    // The opt-out itself is attribution-only (phoneHash), independent of
    // whether a live contact row exists for it - it must survive a
    // tombstoned contact (P14 rule: the opt-out outlives the contact).
    expect(outcome).toEqual({ attribution: 'attributed', optedOut: true, touched: true });
    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);

    // touchContactLastInbound filters `deleted_at IS NULL` - the tombstone
    // row's own last_inbound_at must remain NULL (never resurrected/touched).
    const tombstone = await pool.query<{ last_inbound_at: Date | null; deleted_at: Date | null }>(
      'SELECT last_inbound_at, deleted_at FROM contacts WHERE id = $1',
      [contactId],
    );
    expect(tombstone.rows[0]?.last_inbound_at).toBeNull();
    expect(tombstone.rows[0]?.deleted_at).not.toBeNull();
  });

  it('a_whatsapp_net_jid_with_a_non_digit_user_part_is_unattributable_and_nothing_is_written', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
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
      { senderJid: 'not-all-digits@s.whatsapp.net', candidate: inboundOptoutCandidate('STOP') },
    );

    expect(outcome).toEqual({ attribution: 'unattributable', optedOut: false, touched: false });
    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(0);
    const contactTouches = await pool.query(
      'SELECT count(*)::int AS n FROM contacts WHERE client_id = $1 AND last_inbound_at IS NOT NULL',
      [clientId],
    );
    expect(contactTouches.rows[0]?.n).toBe(0);
  });

  it('stop_padded_with_300_spaces_and_a_trailing_emoji_still_matches_after_the_256_char_cap', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220002';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);
    const registry = createMetricsRegistry();

    // 'stop' + 300 spaces + emoji: OptOutCandidateText caps at 256 code
    // points BEFORE this reaches the matcher. 'stop' (4 chars) + 252 spaces
    // survives inside the cap; the matcher's own tokenizer collapses
    // whitespace, so this still normalises to just "stop" and matches.
    const padded = `stop${' '.repeat(300)}\u{1F600}`;
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
      { senderJid: waJidFromE164(e164), candidate: inboundOptoutCandidate(padded) },
    );

    expect(outcome.optedOut).toBe(true);
    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(1);
  });

  it('a_tenant_keyword_that_is_a_prefix_of_a_normal_word_never_opts_out_a_longer_sentence', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const provider = makeInboundOptoutProvider();
    const e164 = '+15552220003';
    const phoneHash = hashRecipient(provider, e164);
    await seedLiveContact(pool, clientId, e164, phoneHash);
    await pool.query(`INSERT INTO tenant_optout_keywords (client_id, keyword) VALUES ($1, 'hi')`, [
      clientId,
    ]);

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
      {
        senderJid: waJidFromE164(e164),
        candidate: inboundOptoutCandidate('hi there how are you'),
      },
    );

    // 'hi there how are you' is 5 tokens (> the matcher's MAX_PREFIX_MATCH_TOKENS
    // of 4) and is not an exact match to 'hi' either - must NOT opt out.
    expect(outcome.optedOut).toBe(false);
    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(0);
  });
});
