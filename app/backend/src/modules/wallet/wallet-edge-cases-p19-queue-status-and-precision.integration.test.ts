import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { creditWalletAndNotify } from './credit.service.js';
import { readQueueStatus } from './queue-status.repo.js';
import { createTopupRequest, readTopupRequest } from './topups.repo.js';
import { readTopupForDecision } from '../internal/internal-access.js';

/**
 * wallet-edge-cases-p19-queue-status-and-precision.integration.test.ts (P19
 * C2 hardening, max-lines split 3/3 of wallet-edge-cases-p19) - real
 * Postgres: queue-status empty-input/tenant-isolation, the bigint
 * amount_minor round-trip through topups.repo.ts / internal-access.ts, and a
 * staff-credit cross-tenant-aim proof.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-cases-p19-queue-status-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function noopWakeDeps(nowMs = Date.parse('2026-09-04T00:00:00.000Z')): {
  publishWake: () => void;
  nowMs: number;
} {
  return { publishWake: () => undefined, nowMs };
}

describe('queue-status - empty and boundary inputs (real Postgres)', () => {
  it('a_client_with_no_wallet_daily_summary_rows_and_zero_queued_jobs_reads_all_zeros', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    const result = await tenantDb.withTenant(seeded.clientId, (tx) =>
      readQueueStatus(tx, seeded.clientId),
    );

    expect(result.workspace).toEqual({
      waiting: 0,
      sentToday: 0,
      failedToday: 0,
      spentTodayMinor: 0n,
    });
    const instanceRow = result.instances.find((row) => row.instanceId === seeded.instanceId);
    expect(instanceRow).toEqual({
      instanceId: seeded.instanceId,
      waiting: 0,
      sentToday: 0,
      failedToday: 0,
      spentTodayMinor: 0n,
    });
  });

  it('tenant_A_flooding_its_queue_never_appears_in_tenant_Bs_queue_status', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    // Tenant A floods its own queue - 25 queued jobs, none for tenant B.
    for (let i = 0; i < 25; i += 1) {
      await seedQueuedJob(pool, { clientId: tenantA.clientId, instanceId: tenantA.instanceId });
    }

    const resultB = await tenantDb.withTenant(tenantB.clientId, (tx) =>
      readQueueStatus(tx, tenantB.clientId),
    );
    expect(resultB.workspace.waiting).toBe(0);
    expect(resultB.instances.find((row) => row.instanceId === tenantA.instanceId)).toBeUndefined();

    const resultA = await tenantDb.withTenant(tenantA.clientId, (tx) =>
      readQueueStatus(tx, tenantA.clientId),
    );
    expect(resultA.workspace.waiting).toBe(25);
  });
});

describe('bigint amount_minor round-trip - topups.repo.ts and internal-access.ts (real Postgres)', () => {
  it('an_amount_minor_beyond_Number_MAX_SAFE_INTEGER_reads_back_EXACT_through_the_repo_read_path', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds);
    // A bigint-range paise value that a real high-value top-up could carry
    // and that Zod's `z.number().int()` cannot even validate exactly (this
    // proves the repo-level round-trip independent of the HTTP contract's
    // own number bound) - inserted directly since amount_minor is a
    // database bigint, not constrained by the TS input type here.
    const hugeAmountMinor = '9007199254740993'; // Number.MAX_SAFE_INTEGER + 2 (odd - Number() would round it to an even value, so any regression is visible)
    const externalRef = `utr-${randomUUID()}`;

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO topup_requests (client_id, amount_minor, method, external_ref)
       VALUES ($1, $2::bigint, 'upi', $3) RETURNING id`,
      [seeded.clientId, hugeAmountMinor, externalRef],
    );
    const id = inserted.rows[0]!.id;

    // The raw column value is exact.
    const raw = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor::text FROM topup_requests WHERE id = $1',
      [id],
    );
    expect(raw.rows[0]?.amount_minor).toBe(hugeAmountMinor);

    // FIXED: topups.repo.ts#readTopupRequest carries amountMinor as a
    // bigint end-to-end (BigInt(row.amount_minor), never Number(...)) - the
    // round-trip is EXACT, never a bound.
    const tenantDb = createTenantDb(pool);
    const viaRepo = await tenantDb.withTenant(seeded.clientId, (tx) =>
      readTopupRequest(tx, seeded.clientId, id),
    );
    expect(viaRepo).toBeDefined();
    expect(typeof viaRepo!.amountMinor).toBe('bigint');
    expect(viaRepo!.amountMinor).toBe(BigInt(hugeAmountMinor));
    expect(String(viaRepo!.amountMinor)).toBe(hugeAmountMinor);

    // Same fix via the internal staff read path (internal-access.ts#readTopupForDecision).
    const viaInternal = await readTopupForDecision(pool, id);
    expect(viaInternal).toBeDefined();
    expect(typeof viaInternal!.amountMinor).toBe('bigint');
    expect(viaInternal!.amountMinor).toBe(BigInt(hugeAmountMinor));
    expect(String(viaInternal!.amountMinor)).toBe(hugeAmountMinor);
  });

  it('createTopupRequest_itself_round_trips_a_bigint_range_amount_EXACTLY_through_its_own_return_value', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const hugeAmountMinor = '9007199254740995'; // Number.MAX_SAFE_INTEGER + 4

    const row = await tenantDb.withTenant(seeded.clientId, (tx) =>
      createTopupRequest(tx, {
        clientId: seeded.clientId,
        // FIXED: the repo's own input type is `bigint` end-to-end - exact
        // going IN, never rounded before the INSERT bind.
        amountMinor: BigInt(hugeAmountMinor),
        method: 'upi',
        externalRef: `utr-${randomUUID()}`,
        submittedByUserId: randomUUID(),
      }),
    );

    expect(typeof row.amountMinor).toBe('bigint');
    expect(row.amountMinor).toBe(BigInt(hugeAmountMinor));

    const stored = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor::text FROM topup_requests WHERE id = $1',
      [row.id],
    );
    expect(stored.rows[0]?.amount_minor).toBe(hugeAmountMinor);
  });
});

describe('internal staff credit - cross-tenant aim (real Postgres)', () => {
  it('a_staff_credit_scoped_to_client_A_never_lands_money_on_client_B', async () => {
    const clientA = await seedSendTenant(pool, probeClientIds, { balanceMinor: 0 });
    const clientB = await seedSendTenant(pool, probeClientIds, { balanceMinor: 0 });
    const tenantDb = createTenantDb(pool);

    await creditWalletAndNotify(
      { tenantDb, ...noopWakeDeps() },
      {
        clientId: clientA.clientId,
        amountMinor: 7500n,
        kind: 'adjustment_credit',
        reason: 'staff aims this at client A only',
        externalRef: `adj-${randomUUID()}`,
        staffId: randomUUID(),
      },
    );

    const balanceA = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [clientA.clientId],
    );
    expect(balanceA.rows[0]?.balance_minor).toBe('7500');

    const balanceB = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [clientB.clientId],
    );
    expect(balanceB.rows[0]?.balance_minor).toBe('0');

    const ledgerB = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [clientB.clientId],
    );
    expect(ledgerB.rows[0]?.count).toBe('0');
  });
});
