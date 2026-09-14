import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { recordOptOut } from '../pacing/index.js';
import {
  buildContactsApp,
  buildTestConfig,
  cleanupContactsRoutesRecords,
  makePepperProvider,
  onboardedClient,
  attachPlan,
} from './__tests__/contacts-routes-test-support.js';

/**
 * contacts.api.integration.test.ts (P20 Unit U4, step 4) - real Postgres +
 * real `buildApp`, exact case names from the phase dispatch. Split from
 * `contacts-api-limits-and-tags.integration.test.ts` for the 300-line cap
 * (same "independent beforeAll/afterAll per split file" idiom as
 * `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`) - this file
 * holds the list/tenant-isolation/opt-out-mirror cases; the sibling holds
 * max_contacts/tag-count/phone-normalisation.
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
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'contacts-tests' });
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

async function readyClient(label: string): Promise<{ accessToken: string; clientId: string }> {
  const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { accessToken, clientId: client.clientId };
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

describe('GET /v1/contacts', () => {
  it('contacts_list_is_keyset_paginated', async () => {
    const { accessToken, clientId } = await readyClient('list-page');
    await seedPlan(clientId, 100);

    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await createContactHttp(accessToken, {
        phone: `98765${String(10000 + i).slice(0, 5)}`,
        defaultCountry: 'IN',
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().data.id);
    }

    const seenIds = new Set<string>();
    let cursor: string | undefined;
    let firstPage = true;
    let page26InsertedYet = false;
    for (let guard = 0; guard < 10; guard++) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/contacts?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      if (firstPage) {
        expect(body.data.items.length).toBe(10);
        expect(body.meta.nextCursor).toBeTruthy();
        firstPage = false;
        // Insert a 26th contact mid-scroll (newest updated_at) - it must
        // never appear in any later page, since every page is ordered by
        // updated_at DESC and this row is newer than page 1's own head.
        const extra = await createContactHttp(accessToken, {
          phone: '9876599999',
          defaultCountry: 'IN',
        });
        expect(extra.statusCode).toBe(201);
        page26InsertedYet = true;
      }
      for (const item of body.data.items as { id: string }[]) {
        expect(seenIds.has(item.id)).toBe(false);
        seenIds.add(item.id);
      }
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(page26InsertedYet).toBe(true);
    expect(seenIds).toEqual(new Set(ids));

    const garbage = await app.inject({
      method: 'GET',
      url: '/v1/contacts?cursor=not-a-real-cursor',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    // Strips `//`/`/* */`-style comment lines before scanning: the module's
    // own doc comments legitimately mention "OFFSET" as PROSE describing
    // its absence (e.g. "No OFFSET anywhere") - only a real SQL keyword
    // usage outside a comment would be the actual violation.
    function codeOnly(source: string): string {
      return source
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
        })
        .join('\n');
    }
    const fs: typeof import('node:fs') = await import('node:fs');
    const repoSource = fs.readFileSync(new URL('./contacts.repo.ts', import.meta.url), 'utf8');
    const tagsSource = fs.readFileSync(new URL('./tags.repo.ts', import.meta.url), 'utf8');
    expect(codeOnly(repoSource)).not.toMatch(/\bOFFSET\b/i);
    expect(codeOnly(tagsSource)).not.toMatch(/\bOFFSET\b/i);
  });
});

describe('tenant isolation', () => {
  it('a_second_tenant_cannot_read_tag_or_erase_a_contact', async () => {
    const a = await readyClient('tenant-a');
    const b = await readyClient('tenant-b');
    await seedPlan(a.clientId, 10);

    const contactRes = await createContactHttp(a.accessToken, {
      phone: '9876500002',
      defaultCountry: 'IN',
    });
    expect(contactRes.statusCode).toBe(201);
    const idA = contactRes.json().data.id;

    const tagRes = await app.inject({
      method: 'POST',
      url: '/v1/contacts/tags',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: `tag-${randomUUID()}` },
    });
    expect(tagRes.statusCode).toBe(201);
    const tagA = tagRes.json().data.id;

    const readOther = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${idA}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(readOther.statusCode).toBe(404);

    const linkOther = await app.inject({
      method: 'POST',
      url: `/v1/contacts/${idA}/tags`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { add: [tagA] },
    });
    expect(linkOther.statusCode).toBe(404);

    const patchOther = await app.inject({
      method: 'PATCH',
      url: `/v1/contacts/tags/${tagA}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { name: `renamed-${randomUUID()}` },
    });
    expect(patchOther.statusCode).toBe(404);

    const deleteOther = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/tags/${tagA}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(deleteOther.statusCode).toBe(404);

    const tagStillExists = await pool.query('SELECT 1 FROM contact_tags WHERE id = $1', [tagA]);
    expect(tagStillExists.rowCount).toBe(1);

    const crossUpdate = await tenantDb.withTenant(b.clientId, (tx) =>
      tx.query('UPDATE contacts SET deleted_at = now() WHERE client_id = $1 AND id = $2', [
        b.clientId,
        idA,
      ]),
    );
    expect(crossUpdate.rowCount).toBe(0);

    const stillLive = await pool.query('SELECT deleted_at FROM contacts WHERE id = $1', [idA]);
    expect(stillLive.rows[0]?.deleted_at).toBeNull();
  });
});

describe('opt-out mirror on create', () => {
  it('a_new_contact_is_inserted_opted_out_when_opt_outs_already_has_the_number', async () => {
    const { accessToken, clientId } = await readyClient('optout-mirror');
    await seedPlan(clientId, 10);

    const e164 = '+919876500001';
    const phoneHash = hashRecipient(pepperProvider, e164);
    let optOutCreatedAt: string | undefined;
    await tenantDb.withTenant(clientId, async (tx) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'manual',
        },
        { mirror: async () => ({ contactsUpdated: 0 }) },
      );
      const row = await tx.query<{ created_at: Date }>(
        'SELECT created_at FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
        [clientId, phoneHash],
      );
      optOutCreatedAt = row.rows[0]?.created_at.toISOString();
    });

    const optedOutRes = await createContactHttp(accessToken, {
      phone: '98765 00001',
      defaultCountry: 'IN',
    });
    expect(optedOutRes.statusCode).toBe(201);
    expect(optedOutRes.json().data.optOutState).toBe('opted_out');
    expect(optedOutRes.json().data.optedOutAt).toBe(optOutCreatedAt);

    const cleanRes = await createContactHttp(accessToken, {
      phone: '98765 00002',
      defaultCountry: 'IN',
    });
    expect(cleanRes.statusCode).toBe(201);
    expect(cleanRes.json().data.optOutState).toBe('none');
    expect(cleanRes.json().data.optedOutAt).toBeNull();
  });
});
