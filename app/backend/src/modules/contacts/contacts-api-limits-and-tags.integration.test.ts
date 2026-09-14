import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import {
  buildContactsApp,
  buildTestConfig,
  cleanupContactsRoutesRecords,
  makePepperProvider,
  onboardedClient,
  attachPlan,
} from './__tests__/contacts-routes-test-support.js';

/**
 * contacts-api-limits-and-tags.integration.test.ts (P20 Unit U4, step 4) -
 * real Postgres + real `buildApp`, exact case names from the phase
 * dispatch. Split from `contacts.api.integration.test.ts` for the 300-line
 * cap (same "independent beforeAll/afterAll per split file" idiom as
 * `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`) - this file
 * holds max_contacts/tag-count/phone-normalisation.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();
const pepperProvider = makePepperProvider();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];
const createdPlanIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'contacts-limits-tags-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildContactsApp({
    pool,
    tenantDb,
    redis,
    config,
    sentVerificationUrls,
    keyProvider: pepperProvider,
  });
});

afterAll(async () => {
  await app.close();
  await cleanupContactsRoutesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

async function readyClient(
  label: string,
): Promise<{ accessToken: string; clientId: string; email: string }> {
  const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { accessToken, clientId: client.clientId, email: client.email };
}

async function seedPlan(clientId: string, maxContacts: number): Promise<void> {
  const planId = await attachPlan(pool, clientId, { maxContacts });
  createdPlanIds.push(planId);
}

async function createContactHttp(
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });
}

describe('max_contacts admission guard', () => {
  it('max_contacts_is_enforced_before_insert_with_a_named_error', async () => {
    const capped = await readyClient('max-contacts-capped');
    await seedPlan(capped.clientId, 2);

    const first = await createContactHttp(capped.accessToken, {
      phone: '9876511111',
      defaultCountry: 'IN',
    });
    expect(first.statusCode).toBe(201);
    const second = await createContactHttp(capped.accessToken, {
      phone: '9876522222',
      defaultCountry: 'IN',
    });
    expect(second.statusCode).toBe(201);

    const third = await createContactHttp(capped.accessToken, {
      phone: '9876533333',
      defaultCountry: 'IN',
    });
    expect(third.statusCode).toBe(409);
    expect(third.json()).toMatchObject({
      error: { code: 'CONTACT_LIMIT_REACHED', details: { limit: 2, current: 2 } },
    });

    const countRow = await pool.query(
      'SELECT count(*)::text AS count FROM contacts WHERE client_id = $1 AND deleted_at IS NULL',
      [capped.clientId],
    );
    expect(countRow.rows[0]?.count).toBe('2');

    const noPlan = await readyClient('max-contacts-no-plan');
    // P28 U5 (item 3): signup now assigns the default plan to every new
    // client - the "no plan" defense-in-depth path (contacts-limits.ts's
    // own `no_plan` reason) is exercised here by explicitly nulling it out
    // post-signup, same idiom preflight-c1fix.integration.test.ts/
    // snapshot.integration.test.ts already use for their own "no plan"
    // fixtures.
    await pool.query('UPDATE clients SET plan_id = NULL WHERE id = $1', [noPlan.clientId]);
    const noPlanRes = await createContactHttp(noPlan.accessToken, {
      phone: '9876544444',
      defaultCountry: 'IN',
    });
    expect(noPlanRes.statusCode).toBe(409);
    expect(noPlanRes.json()).toMatchObject({
      error: { code: 'CONTACT_LIMIT_REACHED', details: { reason: 'no_plan' } },
    });

    await pool.query(
      `INSERT INTO client_limit_overrides (client_id, limit_key, limit_value)
       VALUES ($1, 'max_contacts', 3)`,
      [capped.clientId],
    );
    const fourth = await createContactHttp(capped.accessToken, {
      phone: '9876555555',
      defaultCountry: 'IN',
    });
    expect(fourth.statusCode).toBe(201);
  });
});

describe('tag contact_count maintenance', () => {
  it('tag_contact_count_is_maintained_in_the_same_transaction_as_the_link', async () => {
    const { accessToken, clientId } = await readyClient('tag-count');
    await seedPlan(clientId, 10);

    const contact1 = await createContactHttp(accessToken, {
      phone: '9876566661',
      defaultCountry: 'IN',
    });
    const contact2 = await createContactHttp(accessToken, {
      phone: '9876566662',
      defaultCountry: 'IN',
    });
    const id1 = contact1.json().data.id;
    const id2 = contact2.json().data.id;

    const tagRes = await app.inject({
      method: 'POST',
      url: '/v1/contacts/tags',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: `count-tag-${randomUUID()}` },
    });
    const tagId = tagRes.json().data.id;

    async function readTagCount(): Promise<number> {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/contacts/tags',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const item = (res.json().data.items as { id: string; contactCount: number }[]).find(
        (t) => t.id === tagId,
      );
      return item!.contactCount;
    }

    for (const id of [id1, id2]) {
      const link = await app.inject({
        method: 'POST',
        url: `/v1/contacts/${id}/tags`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { add: [tagId] },
      });
      expect(link.statusCode).toBe(200);
    }
    expect(await readTagCount()).toBe(2);

    const relink = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${id1}/tags`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { add: [tagId] },
    });
    expect(relink.statusCode).toBe(200);
    expect(await readTagCount()).toBe(2);

    const unlink = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${id1}/tags`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { remove: [tagId] },
    });
    expect(unlink.statusCode).toBe(200);
    expect(await readTagCount()).toBe(1);

    const removeAgain = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${id1}/tags`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { remove: [tagId] },
    });
    expect(removeAgain.statusCode).toBe(200);
    expect(await readTagCount()).toBe(1);

    const deleteTag = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/tags/${tagId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleteTag.statusCode).toBe(200);

    const contact2Read = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${id2}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(contact2Read.json().data.tags).toEqual([]);
  });
});

describe('phone normalisation and hashing', () => {
  it('phone_is_normalised_and_hashed_on_every_write', async () => {
    const { accessToken, clientId, email } = await readyClient('phone-normalise');
    await seedPlan(clientId, 10);

    const first = await createContactHttp(accessToken, {
      phone: '98765 43210',
      defaultCountry: 'IN',
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.phoneE164).toBe('+919876543210');
    expect(first.json().data.waJid).toBe('919876543210@s.whatsapp.net');
    const firstId = first.json().data.id;

    const storedHash = await pool.query<{ phone_hash: Buffer }>(
      'SELECT phone_hash FROM contacts WHERE id = $1',
      [firstId],
    );
    const expectedHash = hashRecipient(pepperProvider, '+919876543210');
    expect(Buffer.from(storedHash.rows[0]?.phone_hash ?? []).equals(expectedHash)).toBe(true);

    const dup = await createContactHttp(accessToken, {
      phone: '+91-98765-43210',
      defaultCountry: 'IN',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { contactId: firstId } },
    });

    const invalid = await createContactHttp(accessToken, { phone: '12345', defaultCountry: 'IN' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toMatch(/unparsable/);

    await pool.query(`UPDATE memberships SET role = 'viewer' WHERE client_id = $1`, [clientId]);
    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': '10.5.5.5' },
      payload: { email, password: 'Correct-Horse-Battery-Staple-9!' },
    });
    const viewerToken = viewerLogin.json().data.accessToken as string;
    const viewerCreate = await createContactHttp(viewerToken, {
      phone: '9876577777',
      defaultCountry: 'IN',
    });
    expect(viewerCreate.statusCode).toBe(403);
  });
});
