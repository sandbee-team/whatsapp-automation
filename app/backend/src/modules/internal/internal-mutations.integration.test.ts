import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  makeStaffHeaders,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { attemptClaim, seedPendingTopup } from './__tests__/internal-mutations-support.js';
import {
  auditRows,
  ledgerRows,
  notificationKinds,
  topupStatus,
  walletAccount,
} from './__tests__/internal-probe-support.js';
import type { AuditWriteOverride } from './with-staff-mutation.js';

/**
 * internal-mutations.integration.test.ts (P28 Unit U3a, step 4) - the staff
 * MUTATION behaviour: what actually lands in `wallet_ledger`,
 * `staff_audit_log` and `notifications`, and what does NOT land when
 * anything fails. U3b appends its own cases to this file later, reusing
 * `__tests__/internal-mutations-support.ts` (see that module's own header).
 *
 * `.integration.test.ts` suffix is mandatory (real Postgres) - see
 * `internal-auth.integration.test.ts`'s header for the two-vitest-project
 * reason.
 */

const SECRET = 'internal-mutations-test-secret-0123456789';
const CIDRS = '0.0.0.0/0';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

/** Set by `a_failed_audit_write_rolls_back_the_mutation` only - every other test leaves it undefined so the real audit statements run. */
let auditWriteOverride: AuditWriteOverride | undefined;

const staffHeaders = makeStaffHeaders(SECRET);

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-mutations-tests',
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
      // Wake publishing is asserted by
      // `internal-unfreeze-state.integration.test.ts`; here it only has to
      // not throw (a wake failure is logged after COMMIT, never a 5xx).
      publishWake: () => {},
      // Indirected through a mutable local so a single `buildApp` can serve
      // both the normal cases and the injected-failure case - the deps
      // object is captured once at registration time.
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

async function post(
  path: string,
  staffId: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: path,
    headers: staffHeaders('POST', path, staffId, extraHeaders),
    payload: body,
  });
}

describe('internal-mutations', () => {
  it('staff_wallet_adjustment_writes_one_ledger_row_and_one_audit_row', async () => {
    // PHASE DEMO CASE.
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const before = await walletAccount(pool, clientId);

    const response = await post(`/internal/v1/clients/${clientId}/wallet/adjust`, staffId, {
      reason: 'goodwill adjustment after a billing dispute',
      amountMinor: '2500',
      externalRef: `adj-${randomUUID()}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.replayed).toBe(false);

    const ledger = await ledgerRows(pool, clientId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.kind).toBe('adjustment_credit');
    expect(ledger[0]?.actor_type).toBe('staff');
    expect(ledger[0]?.actor_staff_id).toBe(staffId);
    expect(ledger[0]?.amount_minor).toBe('2500');
    // EXACT derived value, never a bound: previous balance + the amount.
    expect(ledger[0]?.balance_after_minor).toBe(String(BigInt(before.balanceMinor) + 2500n));
    expect((await walletAccount(pool, clientId)).balanceMinor).toBe(
      String(BigInt(before.balanceMinor) + 2500n),
    );

    const audit = await auditRows(pool, clientId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('wallet.adjust');
    expect(audit[0]?.target_kind).toBe('client');
    // The result JSON is filled by the post-`fn` UPDATE - never left as the
    // '{}' placeholder the INSERT wrote.
    expect(audit[0]?.result).not.toBe('{}');
    expect(JSON.parse(audit[0]?.result ?? '{}')).toMatchObject({ clientId });

    expect(await notificationKinds(pool, clientId)).toEqual(['wallet_credited_by_staff']);
  });

  it('a_staff_freeze_is_not_cleared_by_a_tenant_topup', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');

    const freeze = await post(`/internal/v1/clients/${clientId}/wallet/freeze`, staffId, {
      reason: 'suspected fraudulent top-up source',
    });
    expect(freeze.statusCode).toBe(200);
    expect(freeze.json().data.changed).toBe(true);
    expect(freeze.json().data.state).toBe('frozen');
    expect((await walletAccount(pool, clientId)).state).toBe('frozen');

    // A repeat freeze is a no-op, NOT an error (`changed:false`).
    const refreeze = await post(`/internal/v1/clients/${clientId}/wallet/freeze`, staffId, {
      reason: 'suspected fraudulent top-up source',
    });
    expect(refreeze.statusCode).toBe(200);
    expect(refreeze.json().data.changed).toBe(false);

    // A tenant's pending top-up, approved by staff, lands the FUNDS but must
    // never lift the freeze - a freeze is a staff decision, and money
    // arriving is not staff revoking it.
    const topupId = await seedPendingTopup(pool, clientId, 30_000);
    const approve = await post(`/internal/v1/topups/${topupId}/approve`, staffId, {
      reason: 'valid UTR confirmed with the bank',
    });
    expect(approve.statusCode).toBe(200);

    const account = await walletAccount(pool, clientId);
    expect(account.balanceMinor).toBe('70000');
    expect(account.state).toBe('frozen');

    // Frozen wallet grants zero claims (invariant 5 - pause/freeze never
    // loses work, never lets it through). `band: 3` matches `seedQueuedJob`'s
    // default `priorityRank` (`claim-jobs.sql` filters `j.priority_rank =
    // $band` - a mismatched band passes vacuously, not on the freeze gate).
    await seedQueuedJob(pool, { clientId, instanceId });
    const claimed = await attemptClaim(pool, { clientId, instanceId, band: 3, fence: 1 });
    expect(claimed).toBe(0);
  });

  it('a_failed_audit_write_rolls_back_the_mutation', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 40_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const before = await walletAccount(pool, clientId);

    // The INSERT runs for real (so `fn` executes and MOVES MONEY), then the
    // result UPDATE throws - proving the audit row and the business effect
    // share one transaction in BOTH directions, not just the happy path.
    auditWriteOverride = {
      insert: async (db, input) => {
        const result = await db.query<{ id: string }>(
          `INSERT INTO staff_audit_log
             (staff_id, action, client_id, target_kind, target_ref, reason,
              idempotency_key, request_hash, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}')
           RETURNING id`,
          [
            input.staffId,
            input.action,
            input.clientId,
            input.targetKind,
            input.targetRef,
            input.reason,
            input.idempotencyKey,
            input.requestHash,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('injected insert returned no row');
        return row.id;
      },
      update: async () => {
        throw new Error('injected audit result UPDATE failure');
      },
    };

    const response = await post(`/internal/v1/clients/${clientId}/wallet/credit`, staffId, {
      reason: 'credit that must be rolled back by the audit failure',
      amountMinor: '9999',
      kind: 'topup_manual',
      externalRef: `fail-${randomUUID()}`,
    });

    expect(response.statusCode).toBe(500);

    // Nothing survived: not the money, not the audit row, not the notification.
    expect((await walletAccount(pool, clientId)).balanceMinor).toBe(before.balanceMinor);
    expect(await ledgerRows(pool, clientId)).toHaveLength(0);
    expect(await auditRows(pool, clientId)).toHaveLength(0);
    expect(await notificationKinds(pool, clientId)).toEqual([]);
  });

  it('a_topup_approval_and_its_audit_row_commit_together', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 10_000,
      walletState: 'active',
    });
    const staffId = await seedStaff('superadmin');
    const topupId = await seedPendingTopup(pool, clientId, 25_000);
    const path = `/internal/v1/topups/${topupId}/approve`;
    const body = { reason: 'UTR verified against the bank statement' };
    const headers = staffHeaders('POST', path, staffId);

    const first = await app.inject({ method: 'POST', url: path, headers, payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.replayed).toBe(false);
    expect(first.json().data.status).toBe('approved');

    expect(await ledgerRows(pool, clientId)).toHaveLength(1);
    expect((await walletAccount(pool, clientId)).balanceMinor).toBe('35000');
    expect(await auditRows(pool, clientId)).toHaveLength(1);
    expect(await topupStatus(pool, topupId)).toBe('approved');

    // SAME key -> a pure replay: no second ledger row, no second audit row.
    const replay = await app.inject({ method: 'POST', url: path, headers, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.replayed).toBe(true);
    expect(await ledgerRows(pool, clientId)).toHaveLength(1);
    expect(await auditRows(pool, clientId)).toHaveLength(1);
    expect((await walletAccount(pool, clientId)).balanceMinor).toBe('35000');

    // DIFFERENT key, same top-up: a NEW audit row (a second staff action
    // genuinely happened and must be recorded), but the ext-ref uniqueness
    // authority - `topup:<id>` - is what keeps the MONEY single-credited.
    const secondKey = await app.inject({
      method: 'POST',
      url: path,
      headers: staffHeaders('POST', path, staffId),
      payload: body,
    });
    expect(secondKey.statusCode).toBe(200);
    expect(await ledgerRows(pool, clientId)).toHaveLength(1);
    expect((await walletAccount(pool, clientId)).balanceMinor).toBe('35000');
    expect(await auditRows(pool, clientId)).toHaveLength(2);
  });
});
