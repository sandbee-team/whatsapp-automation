import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedWaGroup, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import { buildGroupSendTestKeyProvider, linkInstance } from './__tests__/send-test-helpers.js';
import { createMessage } from '../messages/messages.service.js';
import { GroupSendRejectedError } from './send-lookup.public.js';

/**
 * enqueue-group-jid-c2.integration.test.ts (P24 C2 test-engineer) - enqueue-
 * time edge cases beyond `send.integration.test.ts`'s own coverage: an
 * upper-case and device-suffixed spelling of the SAME group jid resolves to
 * one canonical row (matches the already-synced group, not a fresh
 * NOT_SEND_ENABLED), and idempotency-key replay for a group send after the
 * group was disabled between the original call and the replay.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'enqueue-group-jid-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('enqueue - group jid canonicalisation', () => {
  it('an_upper_case_device_suffixed_jid_resolves_to_the_same_canonical_row_as_the_lower_case_bare_jid', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const canonicalJid = '120363900000000001@g.us';
    await seedWaGroup(pool, { clientId, instanceId, groupJid: canonicalJid, sendEnabled: true });

    const keyProvider = buildGroupSendTestKeyProvider();
    // Upper-cased server + a `:5` device/agent suffix on the user part - the
    // domain's own `normalizeJidUser`/`lowerCaseServerOnly` must fold this
    // back to the exact stored canonical jid.
    const spelling = '120363900000000001:5@G.US';

    const result = await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey: randomUUID(),
        requestBody: { recipient: spelling },
        recipient: { jid: spelling, e164: null },
        payload: { text: 'hello canonical group' },
        payloadKind: 'text',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider },
    );

    expect(result.status).toBe('queued');

    const jobRow = await pool.query<{ recipient_jid: string }>(
      `SELECT recipient_jid FROM message_jobs mj
         JOIN message_job_refs r ON r.message_job_id = mj.id
        WHERE r.public_id = $1`,
      [result.id],
    );
    expect(jobRow.rows[0]?.recipient_jid).toBe(canonicalJid);
  });

  it('a_group_jid_with_a_leading_plus_is_rejected_as_not_send_enabled_not_silently_stripped', async () => {
    // `isGroupJid`/`groupRecipientHashInput` key off the `@g.us` suffix only
    // (never digits) - a leading `+` in the user part is preserved through
    // normalisation, so a `+`-prefixed spelling of an OTHERWISE-synced group
    // jid does not match the stored bare-digits row and is correctly treated
    // as never-synced (NOT_SEND_ENABLED), never silently normalised away.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const canonicalJid = '120363900000000002@g.us';
    await seedWaGroup(pool, { clientId, instanceId, groupJid: canonicalJid, sendEnabled: true });

    const keyProvider = buildGroupSendTestKeyProvider();
    const plusSpelling = '+120363900000000002@g.us';

    await expect(
      createMessage(
        tenantDb,
        {
          clientId,
          instanceId,
          idempotencyKey: randomUUID(),
          requestBody: { recipient: plusSpelling },
          recipient: { jid: plusSpelling, e164: null },
          payload: { text: 'hello plus group' },
          payloadKind: 'text',
          priority: 'normal',
          scheduledAt: null,
          sendOrigin: 'api_send',
        },
        { keyProvider },
      ),
    ).rejects.toThrow(GroupSendRejectedError);

    const jobRows = await pool.query(
      `SELECT 1 FROM message_jobs WHERE client_id = $1 AND instance_id = $2 AND recipient_jid LIKE '+%'`,
      [clientId, instanceId],
    );
    expect(jobRows.rows).toHaveLength(0);
  });
});

describe('enqueue - idempotency replay after the group was disabled', () => {
  it('replaying_the_same_idempotency_key_after_the_group_is_disabled_returns_the_original_job_not_a_fresh_422', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await linkInstance(pool, instanceId);
    const canonicalJid = '120363900000000003@g.us';
    const group = await seedWaGroup(pool, {
      clientId,
      instanceId,
      groupJid: canonicalJid,
      sendEnabled: true,
    });
    const keyProvider = buildGroupSendTestKeyProvider();
    const idempotencyKey = randomUUID();
    const requestBody = { recipient: canonicalJid };

    const first = await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey,
        requestBody,
        recipient: { jid: canonicalJid, e164: null },
        payload: { text: 'hello group replay' },
        payloadKind: 'text',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider },
    );
    expect(first.status).toBe('queued');

    // The group is disabled AFTER the original enqueue succeeded.
    await pool.query(`UPDATE wa_groups SET send_enabled = false WHERE id = $1`, [group.id]);

    // FIXED (P24 C2 fix round, Fix 2): api.md rule 2 requires "duplicates
    // return the original resource" for an idempotency-key replay.
    // `messages.service.ts#createMessage` now resolves the idempotency
    // replay (`findExistingJobRef`) BEFORE the group-eligibility lookup, so
    // a replay after the group was disabled in between returns the SAME
    // original job, never a fresh `GroupSendRejectedError`.
    const replay = await createMessage(
      tenantDb,
      {
        clientId,
        instanceId,
        idempotencyKey,
        requestBody,
        recipient: { jid: canonicalJid, e164: null },
        payload: { text: 'hello group replay' },
        payloadKind: 'text',
        priority: 'normal',
        scheduledAt: null,
        sendOrigin: 'api_send',
      },
      { keyProvider },
    );

    expect(replay.status).toBe('queued');
    expect(replay.id).toBe(first.id);

    // No new message_jobs row: the replay short-circuited before any
    // eligibility lookup or write, exactly one durable job exists.
    const jobRows = await pool.query(
      `SELECT count(*)::text AS count FROM message_jobs WHERE client_id = $1 AND instance_id = $2`,
      [clientId, instanceId],
    );
    expect(jobRows.rows[0]?.count).toBe('1');
  });
});
