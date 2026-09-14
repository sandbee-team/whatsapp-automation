import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import { streamContactsCsv } from './export.js';
import {
  buildContactsApp,
  buildTestConfig,
  loginAndVerifyMfaViaHttp,
  makePepperProvider,
  onboardedClient,
  onboardedMfaClient,
  STRONG_PASSWORD,
  uniqueIp,
} from './__tests__/contacts-routes-test-support.js';
import {
  attachPlan,
  cleanupContactsRoutesRecords,
} from './__tests__/contacts-routes-cleanup-support.js';

/**
 * export.integration.test.ts (P20 Unit U6, step 7) - proves the CSV export
 * streams a large tenant's contacts with bounded, EXACT `withTenant` call
 * counts (never a full materialisation, never `OFFSET`), and that the HTTP
 * route escapes formula injection, leaks nothing cross-tenant, and writes
 * exactly one audit row - all against real Postgres.
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
    applicationName: 'contacts-export-it',
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

async function readyClient(label: string): Promise<{ accessToken: string; clientId: string }> {
  const { client, accessToken } = await onboardedClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { accessToken, clientId: client.clientId };
}

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

/** Bulk-inserts `count` live contacts for `clientId` via a single `unnest` statement - never a loop of single inserts. `startIndex` keeps two tenants' phone ranges disjoint in the same test. */
async function seedManyContacts(
  clientId: string,
  count: number,
  opts?: { startIndex?: number; displayNameForIndex?: (i: number) => string },
): Promise<void> {
  const start = opts?.startIndex ?? 0;
  const phones = Array.from(
    { length: count },
    (_, i) => `+9198${String(start + i).padStart(8, '0')}`,
  );
  const names = Array.from(
    { length: count },
    (_, i) => opts?.displayNameForIndex?.(i) ?? `Contact ${start + i}`,
  );
  const waJids = phones.map((p) => `${p.slice(1)}@s.whatsapp.net`);
  const hashes = phones.map((p) => hashRecipient(pepperProvider, p));

  await pool.query(
    `INSERT INTO contacts (client_id, phone_e164, phone_hash, wa_jid, display_name, source, updated_at)
     SELECT $1, p, h, j, n, 'manual', now()
       FROM unnest($2::text[], $3::bytea[], $4::text[], $5::text[]) AS t(p, h, j, n)`,
    [clientId, phones, hashes, waJids, names],
  );
}

/** Wraps `tenantDb` to count every `withTenant` call - an injected exact bound, never an ambient assertion. */
function countingTenantDb(inner: TenantDb): { tenantDb: TenantDb; calls: () => number } {
  let calls = 0;
  return {
    tenantDb: {
      withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        calls += 1;
        return inner.withTenant(clientId, fn);
      },
    },
    calls: () => calls,
  };
}

describe('export_streams_without_offset_pagination', () => {
  it('export_streams_without_offset_pagination', async () => {
    const { clientId } = await readyClient('bulk');
    await seedPlan(clientId, 25000);
    await seedManyContacts(clientId, 10_000);

    const { tenantDb: wrapped, calls } = countingTenantDb(tenantDb);

    const lines: string[] = [];
    for await (const line of streamContactsCsv(
      { tenantDb: wrapped },
      { clientId, pageSize: 1000 },
    )) {
      lines.push(line);
    }

    expect(lines.length).toBe(10_001);
    const phones = new Set(lines.slice(1).map((line) => line.split(',')[0]));
    expect(phones.size).toBe(10_000);
    expect(calls()).toBe(11);

    // Strips `/* ... */` block comments (this source's own doc comments
    // mention the word "OFFSET" as a negative statement, e.g. "NEVER
    // `OFFSET`") before scanning - the assertion is about the SQL this file
    // actually issues, not its prose.
    const source = await readFile(new URL('./export.ts', import.meta.url), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\bOFFSET\b/i.test(codeOnly)).toBe(false);
  }, 30_000);
});

describe('export_escapes_formula_injection_and_leaks_no_other_tenant', () => {
  it('export_escapes_formula_injection_and_leaks_no_other_tenant', async () => {
    const {
      mfaAccessToken,
      clientId: clientA,
      email,
      totpSecret,
    } = await readyMfaClient('formula-a');
    await seedPlan(clientA, 100);
    const { clientId: clientB } = await readyClient('formula-b');
    await seedPlan(clientB, 100);

    await seedManyContacts(clientA, 1, {
      startIndex: 0,
      displayNameForIndex: () => `=cmd|' /C calc'!A0`,
    });
    await seedManyContacts(clientB, 1, { startIndex: 1 });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/contacts/export.csv',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(res.body).not.toContain('+919800000001');

    const auditCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE client_id = $1 AND action = 'contacts.export'`,
      [clientA],
    );
    expect(Number(auditCount.rows[0]?.count)).toBe(1);

    // Downgrade to viewer, then re-mint a fresh MFA token (a login re-reads
    // `memberships.role` - the already-issued token's `role` claim would not
    // reflect this change) -> 403.
    await pool.query(`UPDATE memberships SET role = 'viewer' WHERE client_id = $1`, [clientA]);
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
    const viewerRes = await app.inject({
      method: 'GET',
      url: '/v1/contacts/export.csv',
      headers: { authorization: `Bearer ${viewerMfaToken}` },
    });
    expect(viewerRes.statusCode).toBe(403);

    // `readyClient` signs up a brand-new client - its first user is always
    // `owner` (signupClientViaHttp/onboardedClient). Per route-policy.ts's
    // own canon ("An owner with no TOTP enrolled -> 403
    // MFA_ENROLL_REQUIRED"), an owner-role token with no TOTP enrolled hits
    // the `MfaEnrollRequiredError` branch, not the plain `MfaRequiredError`
    // (401) branch that a non-owner role with no TOTP would hit instead.
    const { accessToken: nonMfaToken } = await readyClient('formula-nonmfa');
    const nonMfaRes = await app.inject({
      method: 'GET',
      url: '/v1/contacts/export.csv',
      headers: { authorization: `Bearer ${nonMfaToken}` },
    });
    expect(nonMfaRes.statusCode).toBe(403);
    expect(nonMfaRes.json().error.code).toBe('MFA_ENROLL_REQUIRED');
  });
});
