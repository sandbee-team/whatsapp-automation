import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { runDispatchTick } from '../dispatcher.js';
import {
  makeKeyProvider,
  seedClientWithEndpoint,
  seedPendingDelivery,
  cleanupDispatcherRecords,
  fetchFnFor,
} from './dispatcher-test-support.js';
import {
  startDispatcherFixtureServer,
  type DispatcherFixtureServer,
} from './dispatcher-fixture-server.js';
import { assertNoLeak } from '../../realtime/__tests__/sse-log-redaction-test-support.js';

/**
 * webhook-payload-redaction.integration.test.ts (P15 U5, step 7/8) - a
 * seeded two-tenant dispatcher run scanned for a phone number, WhatsApp JID,
 * or message body anywhere in the dispatched request body or headers.
 * Reuses `sse-log-redaction-test-support.ts`'s own `assertNoLeak` (same
 * forbidden-pattern set the SSE side already established - one leak
 * definition, not two). Same placement note as `suite-b-relay.integration.
 * test.ts`: module-local `__tests__/`, the analogous existing location to
 * the phase task's suggested `test/security/` (which does not exist in this
 * repo).
 *
 * BUG FIX (P15 C1 FIX F9 / MAJ-7): the previous version of this suite seeded
 * ONLY clean, allow-listed payload shapes ("deliberately writes payload
 * fields that LOOK like the forbidden shapes are absent") and could
 * therefore never fail even if `dispatcher.ts` spread the stored payload
 * verbatim into the outbound body - the assertion was vacuous. This version
 * seeds a HOSTILE payload directly via raw SQL (`seedPendingDelivery`,
 * bypassing `emit()`'s `assertIdsOnly` gate entirely - the storage-layer
 * shape a bug or a future non-`emit()` writer could still produce) carrying
 * a phone number, a WhatsApp JID, and a body-shaped string, and asserts the
 * DISPATCHED body/headers do NOT contain them - proving `dispatcher.ts`'s
 * own allow-list projection (`REALTIME_PAYLOAD_KEYS[eventType]`) is what
 * keeps the wire clean, not merely `emit()`'s write-time gate.
 */

const pool = createPool({
  connectionString: resolveDatabaseUrl(),
  applicationName: 'webhook-redaction-test',
});

let seededClientIds: string[] = [];
let liveServers: DispatcherFixtureServer[] = [];

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupDispatcherRecords(pool, seededClientIds);
  seededClientIds = [];
  await Promise.all(liveServers.map((s) => s.close()));
  liveServers = [];
});

const HOSTILE_PHONE = '+919812345678';
const HOSTILE_JID = '1234567890@s.whatsapp.net';
const HOSTILE_BODY = 'Hi there, this is your order confirmation body text.';

describe('no webhook body, header, or delivery row carries a phone, JID, or message body', () => {
  it('no_webhook_body_header_or_log_line_carries_a_phone_jid_or_message_body', async () => {
    const server = await startDispatcherFixtureServer([200]);
    liveServers.push(server);
    const keyProvider = makeKeyProvider();
    const url = `https://safe-fetch.test.local:${String(server.port)}/hooks`;

    const tenantA = await seedClientWithEndpoint(pool, keyProvider, url, [
      'message.job.status_changed',
      'job.needs_user_action',
    ]);
    seededClientIds.push(tenantA.clientId);
    const tenantB = await seedClientWithEndpoint(pool, keyProvider, url, ['campaign.progress']);
    seededClientIds.push(tenantB.clientId);

    // A HOSTILE payload, seeded directly via raw SQL (seedPendingDelivery
    // bypasses emit()'s assertIdsOnly gate entirely) - the storage-layer
    // shape a bug or a future non-emit() writer could still produce. Every
    // hostile field is an EXTRA key beyond the event type's own allow-list
    // (REALTIME_PAYLOAD_KEYS), proving dispatcher.ts's OWN projection - not
    // merely emit()'s write-time gate - is what keeps the wire clean.
    await seedPendingDelivery(pool, {
      clientId: tenantA.clientId,
      endpointId: tenantA.endpointId,
      eventType: 'message.job.status_changed',
      payload: {
        jobPublicId: 'job-redact-1',
        instanceId: tenantA.clientId,
        status: 'sent',
        phone: HOSTILE_PHONE,
        jid: HOSTILE_JID,
        body: HOSTILE_BODY,
      },
    });
    await seedPendingDelivery(pool, {
      clientId: tenantA.clientId,
      endpointId: tenantA.endpointId,
      eventType: 'job.needs_user_action',
      payload: {
        jobPublicId: 'job-redact-2',
        reason: 'unresolved_send',
        phone: HOSTILE_PHONE,
        jid: HOSTILE_JID,
      },
    });
    await seedPendingDelivery(pool, {
      clientId: tenantB.clientId,
      endpointId: tenantB.endpointId,
      eventType: 'campaign.progress',
      payload: {
        campaignId: tenantB.clientId,
        sent: 1,
        queued: 0,
        failed: 0,
        body: HOSTILE_BODY,
      },
    });

    await runDispatchTick({
      pool,
      keyProvider,
      clock: { now: () => new Date('2026-09-02T12:00:00.000Z') },
      rng: () => 0.5,
      fetch: fetchFnFor(server.port),
    });

    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      assertNoLeak(request.body);
      assertNoLeak(JSON.stringify(request.headers));
      expect(request.body).not.toContain(HOSTILE_PHONE);
      expect(request.body).not.toContain(HOSTILE_JID);
      expect(request.body).not.toContain(HOSTILE_BODY);
    }

    const deliveryRows = await pool.query<{
      event_type: string;
      status: string;
      error_class: string | null;
    }>('SELECT event_type, status, error_class FROM webhook_deliveries WHERE client_id = ANY($1)', [
      [tenantA.clientId, tenantB.clientId],
    ]);
    assertNoLeak(JSON.stringify(deliveryRows.rows));
  });
});
