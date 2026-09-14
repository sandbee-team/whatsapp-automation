import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  internalTokenHeader,
  makeStaffHeaders,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { auditCountForKey, creditBody, probeCounts } from './__tests__/internal-probe-support.js';
import { signServiceToken } from './service-token.js';

/**
 * internal-auth.integration.test.ts (P28 Unit U3a, step 4) - the
 * `/internal/v1` GATE: service token, mutation headers, staff RBAC, and
 * idempotency replay. Every case asserts the FAIL-CLOSED half explicitly:
 * a rejected request writes ZERO rows (no `staff_audit_log`, no
 * `wallet_ledger`, byte-identical balance) - a 401/403/400 that still left a
 * side effect behind would be the worst failure mode this surface has.
 *
 * The `.integration.test.ts` suffix is MANDATORY: the ROOT `vitest.config.ts`
 * claims every `*.test.ts` under `app/<project>/src`, sets no `WP_*` env and has no
 * database, so a real-Postgres file named `*.test.ts` would be picked up by
 * `test:unit` and fail there. Only `app/backend/vitest.config.ts`
 * (`test:int`) claims this suffix.
 */

const SECRET = 'internal-auth-test-secret-0123456789';
const CIDRS = '0.0.0.0/0';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

const staffHeaders = makeStaffHeaders(SECRET);

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-auth-tests',
  });
  tenantDb = createTenantDb(pool);
  app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: SECRET,
      allowedCidrs: CIDRS,
      publishWake: () => {},
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

async function seedProbe(): Promise<{ clientId: string; instanceId: string }> {
  return seedSendTenant(pool, probeClientIds, { balanceMinor: 100_000, walletState: 'active' });
}

async function seedStaff(
  role: 'support' | 'ops' | 'superadmin',
  options: { status?: 'active' | 'disabled' } = {},
): Promise<string> {
  const id = await seedStaffUser(pool, role, options);
  probeStaffIds.push(id);
  return id;
}

describe('internal-auth', () => {
  it('an_internal_mutation_without_a_valid_service_token_writes_nothing', async () => {
    const { clientId } = await seedProbe();
    const staffId = await seedStaff('superadmin');
    const path = `/internal/v1/clients/${clientId}/wallet/credit`;
    const before = await probeCounts(pool, clientId);

    const baseHeaders = {
      'x-actor': `staff:${staffId}`,
      'idempotency-key': randomUUID(),
    };

    // (1) absent token
    const absent = await app.inject({
      method: 'POST',
      url: path,
      headers: baseHeaders,
      payload: creditBody(),
    });

    // (2) malformed token (not the `t=<ts>,s=<sig>` shape at all)
    const malformed = await app.inject({
      method: 'POST',
      url: path,
      headers: { ...baseHeaders, 'x-wp-internal-token': 'not-a-token' },
      payload: creditBody(),
    });

    // (3) expired - signed at now-301s, one second past the 300s window
    const expiredTs = Math.floor(Date.now() / 1000) - 301;
    const expired = await app.inject({
      method: 'POST',
      url: path,
      headers: {
        ...baseHeaders,
        'x-wp-internal-token': `t=${String(expiredTs)},s=${signServiceToken(SECRET, 'POST', path, expiredTs)}`,
      },
      payload: creditBody(),
    });

    // (4) a VALID, fresh signature - but minted for a DIFFERENT path, then
    // replayed here (the signature covers method.path.timestamp, so a token
    // captured from one route is worthless on another).
    const replayed = await app.inject({
      method: 'POST',
      url: path,
      headers: {
        ...baseHeaders,
        'x-wp-internal-token': internalTokenHeader(
          SECRET,
          'POST',
          `/internal/v1/clients/${clientId}/wallet/adjust`,
        ),
      },
      payload: creditBody(),
    });

    for (const response of [absent, malformed, expired, replayed]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }

    const after = await probeCounts(pool, clientId);
    expect(after.audit).toBe(0);
    expect(after.ledger).toBe(0);
    expect(after.balanceMinor).toBe(before.balanceMinor);
  });

  it('a_mutation_without_idempotency_key_staff_id_or_reason_is_rejected_before_any_write', async () => {
    const { clientId } = await seedProbe();
    const superadminId = await seedStaff('superadmin');
    const supportId = await seedStaff('support');
    const disabledId = await seedStaff('ops', { status: 'disabled' });
    const creditPath = `/internal/v1/clients/${clientId}/wallet/credit`;
    const adjustPath = `/internal/v1/clients/${clientId}/wallet/adjust`;
    const before = await probeCounts(pool, clientId);

    const token = (path: string): string => internalTokenHeader(SECRET, 'POST', path);

    // Each of the three mandatory pieces missing in turn -> 400, never 500.
    const noIdempotencyKey = await app.inject({
      method: 'POST',
      url: creditPath,
      headers: { 'x-wp-internal-token': token(creditPath), 'x-actor': `staff:${superadminId}` },
      payload: creditBody(),
    });
    const noActor = await app.inject({
      method: 'POST',
      url: creditPath,
      headers: { 'x-wp-internal-token': token(creditPath), 'idempotency-key': randomUUID() },
      payload: creditBody(),
    });
    const noReason = await app.inject({
      method: 'POST',
      url: creditPath,
      headers: staffHeaders('POST', creditPath, superadminId),
      payload: { amountMinor: '5000', kind: 'topup_manual', externalRef: `gate-${randomUUID()}` },
    });

    for (const response of [noIdempotencyKey, noActor, noReason]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }

    // A well-formed header carrying a NON-staff actor is an authorization
    // failure (403), not a validation one - `/internal/v1` mutations are
    // always a NAMED staff member, never `system` or an api key.
    for (const actor of ['system', 'api_key:abc123']) {
      const response = await app.inject({
        method: 'POST',
        url: creditPath,
        headers: {
          'x-wp-internal-token': token(creditPath),
          'x-actor': actor,
          'idempotency-key': randomUUID(),
        },
        payload: creditBody(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }

    // Unknown staff id, and a real-but-disabled staff row: both 403, and
    // both indistinguishable from each other in the response.
    for (const staffId of [randomUUID(), disabledId]) {
      const response = await app.inject({
        method: 'POST',
        url: creditPath,
        headers: staffHeaders('POST', creditPath, staffId),
        payload: creditBody(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }

    // Server-side RBAC re-check: `wallet.adjust` is superadmin-only, so a
    // real ACTIVE support account is still refused (the panel greying the
    // button out is never the enforcement point).
    const supportAdjust = await app.inject({
      method: 'POST',
      url: adjustPath,
      headers: staffHeaders('POST', adjustPath, supportId),
      payload: {
        reason: 'support may not adjust',
        amountMinor: '5000',
        externalRef: `gate-${randomUUID()}`,
      },
    });
    expect(supportAdjust.statusCode).toBe(403);
    expect(supportAdjust.json().error.code).toBe('FORBIDDEN');

    const after = await probeCounts(pool, clientId);
    expect(after.audit).toBe(0);
    expect(after.ledger).toBe(0);
    expect(after.balanceMinor).toBe(before.balanceMinor);
  });

  it('a_replayed_idempotency_key_returns_the_first_result_and_writes_one_audit_row', async () => {
    const { clientId } = await seedProbe();
    const staffId = await seedStaff('superadmin');
    const path = `/internal/v1/clients/${clientId}/wallet/credit`;
    const key = randomUUID();
    const body = creditBody({ amountMinor: '7000' });
    const headers = {
      'x-wp-internal-token': internalTokenHeader(SECRET, 'POST', path),
      'x-actor': `staff:${staffId}`,
      'idempotency-key': key,
    };

    const first = await app.inject({ method: 'POST', url: path, headers, payload: body });
    const second = await app.inject({ method: 'POST', url: path, headers, payload: body });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().data.replayed).toBe(false);
    expect(second.json().data.replayed).toBe(true);
    // The replay echoes the FIRST call's own committed result, not a fresh
    // computation: same ledger seq, same balance.
    expect(second.json().data.seq).toBe(first.json().data.seq);
    expect(second.json().data.balanceMinor).toBe(first.json().data.balanceMinor);

    expect(await auditCountForKey(pool, key)).toBe(1);

    const counts = await probeCounts(pool, clientId);
    expect(counts.ledger).toBe(1);
    expect(counts.balanceMinor).toBe('107000');

    // SAME key, DIFFERENT body -> the stored request_hash mismatches, so
    // this is a key REUSE (409), never a silent replay of the other request.
    const reused = await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: creditBody({ amountMinor: '999' }),
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const afterReuse = await probeCounts(pool, clientId);
    expect(afterReuse.ledger).toBe(1);
    expect(afterReuse.balanceMinor).toBe('107000');
    expect((await probeCounts(pool, clientId)).audit).toBe(1);
  });
});
