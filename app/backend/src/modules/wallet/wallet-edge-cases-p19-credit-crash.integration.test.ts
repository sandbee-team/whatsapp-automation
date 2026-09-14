import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { creditWallet } from './credit.repo.js';

/**
 * wallet-edge-cases-p19-credit-crash.integration.test.ts (P19 C2 hardening,
 * max-lines split 1/3 of wallet-edge-cases-p19) - real Postgres: crash
 * injection between the credit's two statements, and concurrent-credit
 * collision-free seq allocation (invariant assertions only, never a sampled
 * count).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-cases-p19-credit-crash-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Wraps a real `TenantQueryable` so its Nth `.query()` call throws BEFORE running - models "the process died between the two credit statements", inside the SAME transaction (so the whole transaction rolls back). */
function crashOnNthQuery(real: TenantQueryable, n: number): TenantQueryable {
  let calls = 0;
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      calls += 1;
      if (calls === n) {
        throw new Error(`simulated crash before query ${String(n)}`);
      }
      return real.query<T>(sql, params);
    },
  };
}

describe('credit path - crash injection between the two credit statements (real Postgres)', () => {
  it('a_crash_between_the_ext_ref_insert_and_the_seq_stamp_leaves_no_partial_row_and_the_retry_is_correct', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: 1000 });
    const tenantDb = createTenantDb(pool);
    const externalRef = `topup-${randomUUID()}`;

    // The crash fires INSIDE the same withTenant transaction, between the
    // ext-ref-insert-and-credit statement (query #1) and the stamp statement
    // (query #2) - crashOnNthQuery throws before query #2 ever runs, so
    // withTenant's own catch block issues ROLLBACK and the whole transaction
    // (including the ext-ref placeholder row and the ledger row) is undone.
    await expect(
      tenantDb.withTenant(seeded.clientId, (tx) =>
        creditWallet(crashOnNthQuery(tx, 2), {
          clientId: seeded.clientId,
          amountMinor: 5000n,
          kind: 'topup_manual',
          reason: 'crash-injection probe',
          externalRef,
          staffId: randomUUID(),
        }),
      ),
    ).rejects.toThrow('simulated crash before query 2');

    // No partial state survives the rollback: no ext-ref row, no ledger row,
    // balance untouched.
    const extRefRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger_ext_refs WHERE client_id = $1 AND external_ref = $2',
      [seeded.clientId, externalRef],
    );
    expect(extRefRows.rows[0]?.count).toBe('0');

    const ledgerRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND external_ref = $2',
      [seeded.clientId, externalRef],
    );
    expect(ledgerRows.rows[0]?.count).toBe('0');

    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('1000');

    // The retry with the SAME external_ref after the crash must be treated
    // as a brand-new credit (never a false "replayed"), since nothing
    // actually committed - this is the "permanently seq=0 row" hazard the
    // dispatch calls out: a real crash rolls back the WHOLE transaction
    // (Postgres transactions are atomic), so there is no window in which a
    // seq=0 ext-ref row can survive without its own ledger row. Prove the
    // retry commits real money exactly once.
    const retry = await tenantDb.withTenant(seeded.clientId, (tx) =>
      creditWallet(tx, {
        clientId: seeded.clientId,
        amountMinor: 5000n,
        kind: 'topup_manual',
        reason: 'crash-injection probe retry',
        externalRef,
        staffId: randomUUID(),
      }),
    );
    expect(retry.replayed).toBe(false);

    const balanceAfterRetry = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterRetry.rows[0]?.balance_minor).toBe('6000');

    const ledgerAfterRetry = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND external_ref = $2',
      [seeded.clientId, externalRef],
    );
    expect(ledgerAfterRetry.rows[0]?.count).toBe('1');

    // A second call with the SAME external_ref after the successful retry
    // IS a genuine replay - never a second credit.
    const secondRetry = await tenantDb.withTenant(seeded.clientId, (tx) =>
      creditWallet(tx, {
        clientId: seeded.clientId,
        amountMinor: 5000n,
        kind: 'topup_manual',
        reason: 'replay after successful retry',
        externalRef,
        staffId: randomUUID(),
      }),
    );
    expect(secondRetry.replayed).toBe(true);
    expect(secondRetry.seq).toBe(retry.seq);

    const balanceAfterReplay = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterReplay.rows[0]?.balance_minor).toBe('6000');
  });
});

describe('credit path - concurrency (real Postgres, invariant assertions only)', () => {
  it('two_concurrent_credits_with_different_external_refs_allocate_collision_free_seqs', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: 0 });
    const tenantDb = createTenantDb(pool);
    const refA = `topup-${randomUUID()}`;
    const refB = `topup-${randomUUID()}`;

    const [a, b] = await Promise.all([
      tenantDb.withTenant(seeded.clientId, (tx) =>
        creditWallet(tx, {
          clientId: seeded.clientId,
          amountMinor: 1000n,
          kind: 'topup_manual',
          reason: 'race A',
          externalRef: refA,
          staffId: randomUUID(),
        }),
      ),
      tenantDb.withTenant(seeded.clientId, (tx) =>
        creditWallet(tx, {
          clientId: seeded.clientId,
          amountMinor: 2000n,
          kind: 'topup_manual',
          reason: 'race B',
          externalRef: refB,
          staffId: randomUUID(),
        }),
      ),
    ]);

    // Invariant: neither call replayed (they are genuinely different
    // credits) and the two allocated seqs are distinct - never a sampled
    // count, the PK (client_id, seq, created_at) is the real authority,
    // asserted below via row count.
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.seq).not.toBe(b.seq);

    const ledgerRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRows.rows[0]?.count).toBe('2');

    const distinctSeqs = await pool.query<{ count: string }>(
      'SELECT count(DISTINCT seq)::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(distinctSeqs.rows[0]?.count).toBe('2');

    // Continuity: balance after both credits equals the sum of both amounts
    // regardless of arrival order (the row lock on wallet_accounts
    // serializes the two UPDATEs).
    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('3000');
  });

  it('two_concurrent_credits_with_the_SAME_external_ref_yield_exactly_one_ledger_row', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds, { balanceMinor: 0 });
    const tenantDb = createTenantDb(pool);
    const externalRef = `topup-${randomUUID()}`;

    const [a, b] = await Promise.all([
      tenantDb.withTenant(seeded.clientId, (tx) =>
        creditWallet(tx, {
          clientId: seeded.clientId,
          amountMinor: 4000n,
          kind: 'topup_manual',
          reason: 'duplicate submit race',
          externalRef,
          staffId: randomUUID(),
        }),
      ),
      tenantDb.withTenant(seeded.clientId, (tx) =>
        creditWallet(tx, {
          clientId: seeded.clientId,
          amountMinor: 4000n,
          kind: 'topup_manual',
          reason: 'duplicate submit race',
          externalRef,
          staffId: randomUUID(),
        }),
      ),
    ]);

    // Exactly one of the two actually wrote the credit; the other's ext-ref
    // INSERT hit ON CONFLICT DO NOTHING and either raced its own read to
    // zero rows (retried by the caller in practice) or observed the winner's
    // committed row. Assert the invariant: never two winners.
    const replayedFlags = [a.replayed, b.replayed];
    expect(replayedFlags.filter((r) => r === false)).toHaveLength(1);

    const ledgerRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND external_ref = $2',
      [seeded.clientId, externalRef],
    );
    expect(ledgerRows.rows[0]?.count).toBe('1');

    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('4000');
  });
});
