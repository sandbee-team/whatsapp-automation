import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { runOptoutRateCheck } from './optout-rate-check.js';

/**
 * optout-rate-check-payload-pii.c2.integration.test.ts (P25 SESSION-PROTOCOL
 * C2 edge-case pass, hunt item 19(a)) - the opt-out-rate-high notification's
 * `notifications.payload` column, across TWO independently seeded tenants,
 * never carries a phone number in any form (E164, digits-only, JID, or a
 * `tel:`-prefixed form) - only the documented counts
 * (acked_sends/optouts/per_thousand). This is a real-Postgres grep of the
 * actual persisted column this check writes, proving the counts-only
 * contract end-to-end rather than trusting the payload SHAPE assertion
 * alone (optout-rate-check.integration.test.ts's own
 * the_notification_payload_carries_counts_only proves the key set; this
 * proves no sentinel VALUE leaked in either tenant's row).
 */

type TestPool = ReturnType<typeof createPool>;

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'optout-rate-check-pii-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // `runOptoutRateCheck` -> `notify()` (`db/queries/notify-fanout.sql`)
    // writes a `notifications` row PLUS a per-channel `outbox_events`
    // fan-out row in the SAME statement - deleting only `notifications`
    // leaves unpublished outbox_events rows fleet-wide, poisoning any
    // later-running relay test's whole-table claim/count assertions (same
    // bug class as lesson 2026-09-03 "p17-new-emit-paths-leak-rows-into-
    // whole-table-relay-tests-and-seed-clients").
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

interface SentinelPhoneForms {
  e164: string;
  digitsOnly: string;
  jid: string;
  tel: string;
}

function sentinelPhoneForms(seed: string): SentinelPhoneForms {
  const digitsOnly = `91${seed.replace(/-/g, '').slice(0, 9)}`;
  return {
    e164: `+${digitsOnly}`,
    digitsOnly,
    jid: `${digitsOnly}@s.whatsapp.net`,
    tel: `tel:+${digitsOnly}`,
  };
}

async function seedClient(companyName: string): Promise<string> {
  const clientId = randomUUID();
  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    companyName,
    `optout-rate-pii-c2-probe-${clientId}`,
    'active',
  ]);
  probeClientIds.push(clientId);
  return clientId;
}

async function seedInstance(clientId: string): Promise<string> {
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'optout-rate-pii-c2-probe', 'connected', 0)`,
    [instanceId, clientId],
  );
  return instanceId;
}

/** Seeded acked sends carry the sentinel phone as the RECIPIENT (recipient_e164/recipient_jid) - the real column shape a payload leak would have to come from. */
async function seedAckedSends(
  clientId: string,
  instanceId: string,
  count: number,
  phone: SentinelPhoneForms,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at, sent_at)
       VALUES ($1, $2, 0, $3, $4, $5, 'text', 'normal', 10, 'sent', now(), now(), now())`,
      [
        clientId,
        instanceId,
        i === 0 ? phone.jid : `15550002${String(i).padStart(3, '0')}@s.whatsapp.net`,
        i === 0 ? phone.e164 : '+15550000000',
        JSON.stringify({ text: 'hello' }),
      ],
    );
  }
}

async function seedOptOuts(clientId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await pool.query(
      `INSERT INTO opt_outs (id, client_id, scope, scope_key, phone_hash, phone_enc, source)
       VALUES ($1, $2, 'client', $2, $3, $4, 'manual')`,
      [
        randomUUID(),
        clientId,
        Buffer.from(`hash-pii-c2-${clientId}-${i}`),
        Buffer.from('enc-placeholder'),
      ],
    );
  }
}

const FIXED_NOW_MS = Date.parse('2026-06-15T12:00:00.000Z');

describe('notifications.payload never carries a phone sentinel, across two tenants (P25 hunt item 19a)', () => {
  it('E164, digits-only, JID, and tel: forms of the sentinel phone are all absent from every payload', async () => {
    const phoneA = sentinelPhoneForms(randomUUID());
    const phoneB = sentinelPhoneForms(randomUUID());

    const clientA = await seedClient('Optout PII C2 Client A');
    const instanceA = await seedInstance(clientA);
    await seedAckedSends(clientA, instanceA, 200, phoneA);
    await seedOptOuts(clientA, 5);

    const clientB = await seedClient('Optout PII C2 Client B');
    const instanceB = await seedInstance(clientB);
    await seedAckedSends(clientB, instanceB, 200, phoneB);
    await seedOptOuts(clientB, 6);

    const result = await runOptoutRateCheck({ pool, tenantDb, nowMs: FIXED_NOW_MS });
    expect(result.notified).toBe(2);

    const notifRows = await pool.query<{ client_id: string; payload: unknown }>(
      `SELECT client_id, payload FROM notifications WHERE client_id = ANY($1) AND kind = 'optout_rate_high'`,
      [[clientA, clientB]],
    );
    expect(notifRows.rows).toHaveLength(2);

    const payloadText = notifRows.rows.map((r) => JSON.stringify(r.payload)).join('\n');
    for (const phone of [phoneA, phoneB]) {
      expect(payloadText.includes(phone.e164)).toBe(false);
      expect(payloadText.includes(phone.digitsOnly)).toBe(false);
      expect(payloadText.includes(phone.jid)).toBe(false);
      expect(payloadText.includes(phone.tel)).toBe(false);
    }

    // Positive control: the payload DOES carry the documented counts-only
    // keys, proving this is a real check on real rows, not a vacuous pass.
    for (const row of notifRows.rows) {
      const payload = row.payload as { acked_sends: number; optouts: number; per_thousand: number };
      expect(Object.keys(payload).sort()).toEqual(['acked_sends', 'optouts', 'per_thousand']);
    }
  });
});
