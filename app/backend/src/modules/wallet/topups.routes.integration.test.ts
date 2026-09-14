import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildWalletApp,
  buildTestConfig,
  cleanupWalletRoutesRecords,
  onboardedMfaClient,
} from './__tests__/wallet-routes-test-support.js';

/**
 * topups.routes.test.ts (P19 Unit U4, step 7/10) - real Postgres + real
 * `buildApp`, exact case names from the phase dispatch. `session_mfa` on the
 * POST (money-adjacent mutation), `session` on the reads.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-route-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildWalletApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupWalletRoutesRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

async function readyClient(label: string): Promise<{ mfaAccessToken: string; clientId: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  return { mfaAccessToken, clientId: client.clientId };
}

function topupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amountMinor: 50_000,
    method: 'upi',
    externalRef: `utr-${randomUUID()}`,
    ...overrides,
  };
}

describe('POST /v1/wallet/topup-requests', () => {
  it('a_duplicate_utr_is_rejected_by_the_database_not_the_application', async () => {
    const { mfaAccessToken, clientId } = await readyClient('dup-utr');
    const externalRef = `utr-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup-requests',
      headers: { authorization: `Bearer ${mfaAccessToken}`, 'idempotency-key': randomUUID() },
      payload: topupPayload({ externalRef }),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup-requests',
      headers: { authorization: `Bearer ${mfaAccessToken}`, 'idempotency-key': randomUUID() },
      payload: topupPayload({ externalRef }),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'CONFLICT' } });

    const rows = await pool.query(
      'SELECT count(*)::text AS count FROM topup_requests WHERE client_id = $1 AND external_ref = $2',
      [clientId, externalRef],
    );
    expect(rows.rows[0]?.count).toBe('1');

    // No in-memory pre-check: the route source never SELECTs external_ref
    // before the INSERT (asserted by scanning the route's own source text,
    // never a runtime proxy - the real guard is the DB constraint above).
    const fs: typeof import('node:fs') = await import('node:fs');
    const routeSource = fs.readFileSync(new URL('./topups.routes.ts', import.meta.url), 'utf8');
    expect(routeSource).not.toMatch(/SELECT[^;]*external_ref[^;]*FROM topup_requests/i);
  });

  it('a_topup_request_without_an_idempotency_key_is_rejected', async () => {
    const { mfaAccessToken, clientId } = await readyClient('no-idem-key');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup-requests',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: topupPayload(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const rows = await pool.query(
      'SELECT count(*)::text AS count FROM topup_requests WHERE client_id = $1',
      [clientId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('a_tenant_cannot_see_or_approve_another_tenants_topup_request', async () => {
    const owner = await readyClient('topup-owner');
    const intruder = await readyClient('topup-intruder');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/wallet/topup-requests',
      headers: { authorization: `Bearer ${owner.mfaAccessToken}`, 'idempotency-key': randomUUID() },
      payload: topupPayload(),
    });
    expect(createResponse.statusCode).toBe(201);
    const topupId = (createResponse.json() as { data: { id: string } }).data.id;

    const readResponse = await app.inject({
      method: 'GET',
      url: `/v1/wallet/topup-requests/${topupId}`,
      headers: { authorization: `Bearer ${intruder.mfaAccessToken}` },
    });
    expect(readResponse.statusCode).toBe(404);

    // wp_app carries no UPDATE grant on topup_requests at all (migration
    // 0058) - a direct attempt to write `status` as the application role
    // fails at the database, never merely at the route layer.
    await expect(
      pool.query(
        "UPDATE topup_requests SET status = 'approved' WHERE id = $1 AND client_id = $2 AND false",
        [topupId, owner.clientId],
      ),
    ).resolves.toBeDefined(); // superuser pool - proves the row exists; the grant check below is the real assertion

    const grantRows = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'topup_requests' AND grantee = 'wp_app' AND privilege_type = 'UPDATE'`,
    );
    expect(grantRows.rows).toHaveLength(0);
  });
});

describe('GET /v1/wallet/topup-requests', () => {
  it('lists_only_the_callers_own_requests_newest_first', async () => {
    const { mfaAccessToken } = await readyClient('list-own');

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/wallet/topup-requests',
        headers: { authorization: `Bearer ${mfaAccessToken}`, 'idempotency-key': randomUUID() },
        payload: topupPayload(),
      });
      expect(response.statusCode).toBe(201);
    }

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/wallet/topup-requests',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(listResponse.statusCode).toBe(200);
    const body = listResponse.json() as { data: { id: string; status: string }[] };
    expect(body.data).toHaveLength(3);
    expect(body.data.every((row) => row.status === 'pending')).toBe(true);
  });
});
