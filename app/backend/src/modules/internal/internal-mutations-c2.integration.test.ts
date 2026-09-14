import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  internalTokenHeader,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { auditCountForKey, ledgerRows, walletAccount } from './__tests__/internal-probe-support.js';
import type { AuditWriteOverride } from './with-staff-mutation.js';

/**
 * internal-mutations-c2.integration.test.ts (P28 C2 hardening) - concurrency
 * and idempotency-reuse edge cases on top of
 * `internal-mutations.integration.test.ts` / `internal-auth.integration.test.ts`:
 * TWO simultaneous identical requests (never sequential replay), the same
 * idempotency key reused against a DIFFERENT client path, and a staff
 * account disabled/downgraded BETWEEN two requests. The pricing-crash and
 * tenant-isolation cases live in the sibling
 * `internal-mutations-c2b.integration.test.ts` (300-line cap split). Every
 * case asserts the durable-storage invariant (row counts via a DB unique
 * key or predicate), never which HTTP call "won" a race.
 */

const SECRET = 'internal-mutations-c2-test-secret-0123456789';
const CIDRS = '0.0.0.0/0';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

let auditWriteOverride: AuditWriteOverride | undefined;

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-mutations-c2-tests',
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
      get auditWrite() {
        return auditWriteOverride;
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

beforeEach(() => {
  auditWriteOverride = undefined;
});

async function seedStaff(role: 'support' | 'ops' | 'superadmin' = 'superadmin'): Promise<string> {
  const id = await seedStaffUser(pool, role);
  probeStaffIds.push(id);
  return id;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

function headersFor(
  method: string,
  path: string,
  staffId: string,
  idempotencyKey: string,
): Record<string, string> {
  return {
    'x-wp-internal-token': internalTokenHeader(SECRET, method, path),
    'x-actor': `staff:${staffId}`,
    'idempotency-key': idempotencyKey,
  };
}

function postWithKey(
  path: string,
  staffId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: path,
    headers: headersFor('POST', path, staffId, key),
    payload: body,
  });
}

describe('internal-mutations-c2: concurrency + tenant isolation', () => {
  it('two_concurrent_identical_wallet_adjust_requests_write_exactly_one_ledger_and_one_audit_row', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const path = `/internal/v1/clients/${clientId}/wallet/adjust`;
    const key = randomUUID();
    const body = {
      reason: 'concurrent adjustment probe, same key same body',
      amountMinor: '2500',
      externalRef: `c2-conc-${randomUUID()}`,
    };

    const [first, second] = await Promise.all([
      postWithKey(path, staffId, key, body),
      postWithKey(path, staffId, key, body),
    ]);

    // Both requests must succeed (never a 500 from the losing side of the
    // race) and must carry the SAME `data` payload - the invariant is "one
    // winner, one replay", never "who won".
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const replayedFlags = [first.json().data.replayed, second.json().data.replayed].sort();
    expect(replayedFlags).toEqual([false, true]);

    const winner = first.json().data.replayed === false ? first : second;
    const loser = first.json().data.replayed === false ? second : first;
    expect(loser.json().data.seq).toBe(winner.json().data.seq);
    expect(loser.json().data.balanceMinor).toBe(winner.json().data.balanceMinor);

    // The DB-level invariant: exactly one ledger row and one audit row for
    // this idempotency key, enforced by the unique constraint, never a
    // sampled/observed count from the race.
    const ledger = await ledgerRows(pool, clientId);
    expect(ledger).toHaveLength(1);
    expect(await auditCountForKey(pool, key)).toBe(1);
  });

  it('the_same_idempotency_key_reused_against_a_different_client_path_is_rejected_and_writes_nothing_to_the_second_client', async () => {
    const { clientId: clientA } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const { clientId: clientB } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const key = randomUUID();
    const body = {
      reason: 'idempotency key reuse across two different clients',
      amountMinor: '1000',
      externalRef: `c2-reuse-${randomUUID()}`,
    };

    const pathA = `/internal/v1/clients/${clientA}/wallet/adjust`;
    const first = await postWithKey(pathA, staffId, key, body);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.replayed).toBe(false);

    // SAME key, SAME body shape, but a DIFFERENT client id in the path - the
    // stored `request_hash` covers `{method, path, body}` where `path` is
    // the route TEMPLATE, but the client id travels through `clientId` in
    // the audit row / RLS scope, and the resolved target differs. This must
    // be refused as a key reuse, never silently applied to client B.
    const pathB = `/internal/v1/clients/${clientB}/wallet/adjust`;
    const second = await postWithKey(pathB, staffId, key, body);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const ledgerB = await ledgerRows(pool, clientB);
    expect(ledgerB).toHaveLength(0);
    expect((await walletAccount(pool, clientB)).balanceMinor).toBe('40000');
  });

  it('a_staff_account_disabled_between_two_requests_is_403_on_the_second_with_zero_new_rows', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const path = `/internal/v1/clients/${clientId}/wallet/adjust`;

    const first = await postWithKey(path, staffId, randomUUID(), {
      reason: 'first adjustment before the account is disabled',
      amountMinor: '1000',
      externalRef: `c2-disable-1-${randomUUID()}`,
    });
    expect(first.statusCode).toBe(200);
    const ledgerAfterFirst = await ledgerRows(pool, clientId);
    expect(ledgerAfterFirst).toHaveLength(1);

    await pool.query(`UPDATE staff_users SET status = 'disabled' WHERE id = $1`, [staffId]);

    const second = await postWithKey(path, staffId, randomUUID(), {
      reason: 'second adjustment attempted after the account was disabled',
      amountMinor: '1000',
      externalRef: `c2-disable-2-${randomUUID()}`,
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('FORBIDDEN');

    // No new ledger/audit row from the rejected second call.
    const ledgerAfterSecond = await ledgerRows(pool, clientId);
    expect(ledgerAfterSecond).toHaveLength(1);
  });

  it('a_role_downgrade_between_two_requests_turns_a_previously_allowed_wallet_adjust_into_a_403', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const path = `/internal/v1/clients/${clientId}/wallet/adjust`;

    const first = await postWithKey(path, staffId, randomUUID(), {
      reason: 'adjustment while still superadmin',
      amountMinor: '500',
      externalRef: `c2-downgrade-1-${randomUUID()}`,
    });
    expect(first.statusCode).toBe(200);

    await pool.query(`UPDATE staff_users SET role = 'support' WHERE id = $1`, [staffId]);

    const second = await postWithKey(path, staffId, randomUUID(), {
      reason: 'adjustment attempted after downgrade to support',
      amountMinor: '500',
      externalRef: `c2-downgrade-2-${randomUUID()}`,
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe('FORBIDDEN');

    const ledger = await ledgerRows(pool, clientId);
    expect(ledger).toHaveLength(1);
  });
});
