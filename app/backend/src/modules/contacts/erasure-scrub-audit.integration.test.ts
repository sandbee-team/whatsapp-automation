import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildContactsApp,
  buildTestConfig,
  makePepperProvider,
  onboardedMfaClient,
  loginAndVerifyMfaViaHttp,
  STRONG_PASSWORD,
  uniqueIp,
} from './__tests__/contacts-routes-test-support.js';
import {
  attachPlan,
  cleanupContactsRoutesRecords,
} from './__tests__/contacts-routes-cleanup-support.js';

/**
 * erasure-scrub-audit.integration.test.ts (P20 Unit U6, step 7) - the
 * PII-scrub/audit-row/tenant-isolation/role-policy half of `erasure.
 * integration.test.ts`, split out purely for that file's own 300-line cap
 * (same "independent beforeAll/afterAll per split file" idiom as
 * `modules/wallet/wallet-edge-cases-p19*.integration.test.ts`).
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
    applicationName: 'contacts-erasure-scrub-it',
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
): Promise<{ statusCode: number; json: () => { data: { id: string } } }> {
  return app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });
}

describe('erasure_scrubs_pii_and_writes_an_audit_row', () => {
  it('erasure_scrubs_pii_and_writes_an_audit_row', async () => {
    const { mfaAccessToken, clientId, email, totpSecret } = await readyMfaClient('scrub');
    await seedPlan(clientId, 100);

    const phone = '+919876500003';
    const created = await createContactHttp(mfaAccessToken, {
      phone,
      defaultCountry: 'IN',
      displayName: 'Alice Example',
      firstName: 'Alice',
      lastName: 'Example',
      attrs: { city: 'Mumbai' },
    });
    const contactId = created.json().data.id;

    const tagRes = await app.inject({
      method: 'POST',
      url: '/v1/contacts/tags',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { name: `Tag One ${randomUUID()}` },
    });
    const tagOneId = tagRes.json().data.id as string;
    const tagTwoRes = await app.inject({
      method: 'POST',
      url: '/v1/contacts/tags',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { name: `Tag Two ${randomUUID()}` },
    });
    const tagTwoId = tagTwoRes.json().data.id as string;

    await app.inject({
      method: 'POST',
      url: `/v1/contacts/${contactId}/tags`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { add: [tagOneId, tagTwoId] },
    });

    const eraseRes = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${contactId}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(eraseRes.statusCode).toBe(200);

    const row = await pool.query(
      `SELECT display_name, first_name, last_name, attrs, lid_jid, phone_e164, phone_hash
         FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(row.rows[0]).toMatchObject({
      display_name: null,
      first_name: null,
      last_name: null,
      attrs: {},
      lid_jid: null,
    });
    expect(row.rows[0]?.phone_e164).toBe(phone);
    expect(row.rows[0]?.phone_hash).not.toBeNull();

    const links = await pool.query('SELECT 1 FROM contact_tag_links WHERE contact_id = $1', [
      contactId,
    ]);
    expect(links.rows.length).toBe(0);

    const tags = await pool.query<{ id: string; contact_count: number }>(
      'SELECT id, contact_count FROM contact_tags WHERE id = ANY($1)',
      [[tagOneId, tagTwoId]],
    );
    for (const tag of tags.rows) {
      expect(tag.contact_count).toBe(0);
    }

    const audit = await pool.query(
      `SELECT actor_user_id FROM audit_logs WHERE client_id = $1 AND action = 'contacts.erase' AND target_id = $2`,
      [clientId, contactId],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]?.actor_user_id).toBeTruthy();

    const getAfter = await app.inject({
      method: 'GET',
      url: `/v1/contacts/${contactId}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(getAfter.statusCode).toBe(404);

    const secondDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${contactId}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(secondDelete.statusCode).toBe(404);

    const { mfaAccessToken: otherMfaToken } = await readyMfaClient('scrub-other');
    const otherClientDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${contactId}`,
      headers: { authorization: `Bearer ${otherMfaToken}` },
    });
    expect(otherClientDelete.statusCode).toBe(404);
    const untouched = await pool.query('SELECT display_name FROM contacts WHERE id = $1', [
      contactId,
    ]);
    expect(untouched.rows[0]?.display_name).toBeNull();

    // Downgrade to viewer, then re-mint a fresh MFA token (a login re-reads
    // `memberships.role`) -> 403.
    await pool.query(`UPDATE memberships SET role = 'viewer' WHERE client_id = $1`, [clientId]);
    const viewerMfaToken = await loginAndVerifyMfaViaHttp(
      app,
      email,
      STRONG_PASSWORD,
      totpSecret,
      uniqueIp,
      // otplib's `epoch` option is SECONDS, and one period is 30 REAL
      // seconds (not ~30ms) - a 500ms offset stayed inside the SAME 30s
      // bucket as the code `onboardedMfaClient`'s own enrol/confirm+verify
      // pair already consumed, so the Redis replay guard rejected it as
      // already-used. 31s crosses into the NEXT bucket (a distinct code)
      // while staying within `TOTP_WINDOW`'s default tolerance (1 step =
      // 30s) of the verifier's real "now" - proven with a standalone otplib
      // probe (offsets 30000-59999ms: distinct code, delta 1, valid; 500ms:
      // same code as "now"; 60000ms: delta exceeds tolerance, invalid).
      // Never a real wall-clock wait (core invariants: "no ambient state").
      31000,
    );
    const viewerDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/contacts/${contactId}`,
      headers: { authorization: `Bearer ${viewerMfaToken}` },
    });
    expect(viewerDelete.statusCode).toBe(403);
  });
});
