import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * db/tests/queue-constraints.test.ts (P03 close, protocol C2) - CHECK/PK
 * boundary probes on this phase's new invariant surface NOT already covered
 * by `claim-plan.test.ts` / `schema-assertions.test.ts` / `isolation-suite-a.
 * test.ts`: `message_jobs`'s `mj_payload_size` and `mj_recipient_shape`
 * CHECK constraints (migration 0007), `delivery_events`'s `de_detail_size`
 * CHECK (migration 0009), and the two-tenant PK-scoping behavior of
 * `message_wa_ids` (client-scoped) vs `delivery_event_ids` (globally-scoped
 * by design - migration 0008's own header comment) - the latter is a
 * confirm-and-record probe, not a bug report: the migration is explicit that
 * `provider_event_id` is a global dedupe authority, "the same
 * globally-unique foreign id as PK shape as message_job_refs.public_id".
 *
 * None of these four tables carry a foreign key (message_jobs' migration
 * says so explicitly; message_wa_ids/delivery_event_ids/delivery_events
 * declare none either), so probe rows use fresh random UUIDs with no need to
 * seed a real `clients` row - cleanup below still scopes by those UUIDs to
 * leave the shared dev DB clean for other suites.
 */
describe('queue_constraints', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM delivery_events WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM delivery_event_ids WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM message_wa_ids WHERE client_id = ANY($1)', [probeClientIds]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  /** JSON-encodes a plain ASCII string scalar; octet_length(result) === n + 2 (the wrapping quotes). */
  function jsonStringOfByteLength(totalBytes: number): string {
    return JSON.stringify('a'.repeat(totalBytes - 2));
  }

  async function insertMessageJob(params: {
    clientId: string;
    instanceId: string;
    payload?: string;
    recipientJid?: string;
    recipientE164?: string | null;
  }): Promise<{ id: string }> {
    const pool = await getMigratedPool();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
       VALUES ($1, $2, 0, $3, $4, $5, 'text', 'normal', 10, 'queued', now(), now())
       RETURNING id`,
      [
        params.clientId,
        params.instanceId,
        params.recipientJid ?? '15550000000@s.whatsapp.net',
        params.recipientE164 === undefined ? '+15550000000' : params.recipientE164,
        params.payload ?? JSON.stringify({ text: 'probe' }),
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('insertMessageJob: no row returned');
    return { id };
  }

  it('mj_payload_size_accepts_exactly_2048_bytes_and_rejects_2049', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const at2048 = jsonStringOfByteLength(2048);
    expect(Buffer.byteLength(at2048, 'utf8')).toBe(2048);
    await expect(
      insertMessageJob({ clientId, instanceId, payload: at2048 }),
    ).resolves.toMatchObject({
      id: expect.any(String) as string,
    });

    const at2049 = jsonStringOfByteLength(2049);
    expect(Buffer.byteLength(at2049, 'utf8')).toBe(2049);
    await expect(insertMessageJob({ clientId, instanceId, payload: at2049 })).rejects.toMatchObject<
      Partial<PgError>
    >({ code: '23514', constraint: 'mj_payload_size' });
  });

  it('mj_recipient_shape_rejects_null_e164_on_an_individual_jid_and_accepts_it_on_a_group_jid', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    await expect(
      insertMessageJob({
        clientId,
        instanceId,
        recipientJid: '15550009999@s.whatsapp.net',
        recipientE164: null,
      }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514', constraint: 'mj_recipient_shape' });

    await expect(
      insertMessageJob({
        clientId,
        instanceId,
        recipientJid: 'probe-group-id@g.us',
        recipientE164: null,
      }),
    ).resolves.toMatchObject({ id: expect.any(String) as string });
  });

  async function insertDeliveryEvent(params: {
    clientId: string;
    instanceId: string;
    detail: string | null;
  }): Promise<{ id: string }> {
    const pool = await getMigratedPool();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO delivery_events (client_id, instance_id, event_type, detail)
       VALUES ($1, $2, 'created', $3)
       RETURNING id`,
      [params.clientId, params.instanceId, params.detail],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('insertDeliveryEvent: no row returned');
    return { id };
  }

  it('de_detail_size_accepts_exactly_250_bytes_and_rejects_251', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const at250 = jsonStringOfByteLength(250);
    expect(Buffer.byteLength(at250, 'utf8')).toBe(250);
    await expect(
      insertDeliveryEvent({ clientId, instanceId, detail: at250 }),
    ).resolves.toMatchObject({ id: expect.any(String) as string });

    const at251 = jsonStringOfByteLength(251);
    expect(Buffer.byteLength(at251, 'utf8')).toBe(251);
    await expect(
      insertDeliveryEvent({ clientId, instanceId, detail: at251 }),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514', constraint: 'de_detail_size' });
  });

  it('message_wa_ids_the_same_wa_msg_id_is_insertable_for_two_different_clients', async () => {
    const clientA = randomUUID();
    const clientB = randomUUID();
    const instanceA = randomUUID();
    const instanceB = randomUUID();
    probeClientIds.push(clientA, clientB);
    const sharedWaMsgId = `wamid-shared-${randomUUID()}`;

    const pool = await getMigratedPool();
    await expect(
      pool.query(
        `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id) VALUES ($1, $2, 'out', $3)`,
        [clientA, instanceA, sharedWaMsgId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    // PK is (client_id, instance_id, direction, wa_msg_id) - the SAME
    // wa_msg_id under a DIFFERENT client_id is a different key entirely, so
    // this must NOT conflict with clientA's row above.
    await expect(
      pool.query(
        `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id) VALUES ($1, $2, 'out', $3)`,
        [clientB, instanceB, sharedWaMsgId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('delivery_event_ids_the_same_provider_event_id_conflicts_globally_across_two_clients', async () => {
    const clientA = randomUUID();
    const clientB = randomUUID();
    probeClientIds.push(clientA, clientB);
    const sharedProviderEventId = `evt-shared-${randomUUID()}`;

    const pool = await getMigratedPool();
    await expect(
      pool.query('INSERT INTO delivery_event_ids (provider_event_id, client_id) VALUES ($1, $2)', [
        sharedProviderEventId,
        clientA,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });

    // RECORDED, not a bug: delivery_event_ids' PK is provider_event_id ALONE
    // (migration 0008's own header comment: "the same globally-unique
    // foreign id as PK shape as message_job_refs.public_id", explicitly NOT
    // the tenant-root shape). A second client using the same provider_event_id
    // therefore hits a PK violation, not a silent cross-tenant merge - the
    // dedupe authority is intentionally global, never per-tenant.
    await expect(
      pool.query('INSERT INTO delivery_event_ids (provider_event_id, client_id) VALUES ($1, $2)', [
        sharedProviderEventId,
        clientB,
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({
      code: '23505',
      constraint: 'delivery_event_ids_pkey',
    });
  });
});
