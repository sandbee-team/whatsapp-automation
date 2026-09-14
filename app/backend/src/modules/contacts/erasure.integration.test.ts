import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { recordOptOut } from '../pacing/index.js';
import { syncOptOutMirror } from './optout-mirror.js';
import {
  buildContactsApp,
  buildTestConfig,
  makePepperProvider,
  onboardedMfaClient,
} from './__tests__/contacts-routes-test-support.js';
import {
  attachPlan,
  cleanupContactsRoutesRecords,
} from './__tests__/contacts-routes-cleanup-support.js';

/**
 * erasure.integration.test.ts (P20 Unit U6, step 7) - proves per-contact
 * erasure against real Postgres: `opt_outs` is left byte-identical, and a
 * re-imported same-phone contact comes back opted-out (the partial unique
 * index proven live). The PII-scrub/audit-row/tenant-isolation/role-policy
 * case (the biggest of the three) is split into the sibling
 * `erasure-scrub-audit.integration.test.ts` purely for this file's own
 * 300-line cap (same "independent beforeAll/afterAll per split file" idiom
 * as `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`).
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
    applicationName: 'contacts-erasure-it',
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

async function readyMfaClient(
  label: string,
): Promise<{ mfaAccessToken: string; clientId: string; email: string; totpSecret: string }> {
  const { client, mfaAccessToken, totpSecret } = await onboardedMfaClient(
    app,
    sentVerificationUrls,
    label,
  );
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { mfaAccessToken, clientId: client.clientId, email: client.email, totpSecret };
}

async function seedPlan(clientId: string, maxContacts: number): Promise<void> {
  const planId = await attachPlan(pool, clientId, { maxContacts });
  createdPlanIds.push(planId);
}

async function createContactHttp(
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<{
  statusCode: number;
  json: () => { data: { id: string; optOutState: string; optedOutAt: string | null } };
}> {
  return app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });
}

describe('erasing_a_contact_leaves_the_opt_out_row_intact', () => {
  it('erasing_a_contact_leaves_the_opt_out_row_intact', async () => {
    const { mfaAccessToken, clientId } = await readyMfaClient('erase-optout');
    await seedPlan(clientId, 100);

    const phone = '+919876500001';
    const created = await createContactHttp(mfaAccessToken, { phone, defaultCountry: 'IN' });
    expect(created.statusCode).toBe(201);
    const contactId = created.json().data.id;

    const phoneHash = hashRecipient(pepperProvider, phone);
    await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('opaque-enc-bytes'),
          source: 'manual',
        },
        { mirror: syncOptOutMirror },
      ),
    );

    const before = await pool.query('SELECT * FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(before.rows.length).toBe(1);
    const beforeSnapshot = JSON.stringify(before.rows[0]);

    const eraseRes = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${contactId}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(eraseRes.statusCode).toBe(200);

    const after = await pool.query('SELECT * FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(after.rows.length).toBe(1);
    expect(JSON.stringify(after.rows[0])).toBe(beforeSnapshot);

    const contactRow = await pool.query('SELECT deleted_at FROM contacts WHERE id = $1', [
      contactId,
    ]);
    expect(contactRow.rows[0]?.deleted_at).not.toBeNull();
  });
});

describe('a_re_imported_erased_contact_comes_back_opted_out', () => {
  it('a_re_imported_erased_contact_comes_back_opted_out', async () => {
    const { mfaAccessToken, clientId } = await readyMfaClient('re-import');
    await seedPlan(clientId, 100);

    const phone = '+919876500002';
    const created = await createContactHttp(mfaAccessToken, { phone, defaultCountry: 'IN' });
    const firstId = created.json().data.id;

    const phoneHash = hashRecipient(pepperProvider, phone);
    const optOutRow = await tenantDb.withTenant(clientId, async (tx) => {
      await recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('opaque-enc-bytes'),
          source: 'manual',
        },
        { mirror: syncOptOutMirror },
      );
      const row = await tx.query<{ created_at: Date }>(
        'SELECT created_at FROM opt_outs WHERE client_id = $1 AND phone_hash = $2',
        [clientId, phoneHash],
      );
      return row.rows[0];
    });

    await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${firstId}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });

    const reCreated = await createContactHttp(mfaAccessToken, { phone, defaultCountry: 'IN' });
    expect(reCreated.statusCode).toBe(201);
    const body = reCreated.json().data;
    expect(body.id).not.toBe(firstId);
    expect(body.optOutState).toBe('opted_out');
    expect(body.optedOutAt).toBe(optOutRow?.created_at.toISOString());

    const tombstone = await pool.query('SELECT deleted_at FROM contacts WHERE id = $1', [firstId]);
    expect(tombstone.rows[0]?.deleted_at).not.toBeNull();
  });
});

// `erasure_scrubs_pii_and_writes_an_audit_row` lives in the sibling
// `erasure-scrub-audit.integration.test.ts` (300-line cap split, see this
// file's own header).
