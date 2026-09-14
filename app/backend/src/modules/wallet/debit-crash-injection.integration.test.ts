import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { mulberry32 } from '../queue/__tests__/crash-injector.js';
import { chargeRepairedSend } from './charge.js';

/**
 * debit-crash-injection.integration.test.ts (P18 Unit U3, split from
 * `debit.integration.test.ts` at the max-lines cap - topic split only, no
 * behavior change, same idiom as `result-failure.integration.test.ts`) -
 * the mandatory 100x `kill -9` chaos proof: a seeded PRNG picks one of four
 * crash checkpoints per iteration (attempt-only commit, full-then-replay,
 * full-then-repaired-path, mid-transaction-abort-then-replay), and the
 * suite asserts exactly one charge landed per iteration regardless of
 * which checkpoint fired. Every money-shaped column is read `::text`
 * (bigint) and compared as a string.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'debit-crash-injection-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Wraps a real `TenantDb` so its Nth `withTenant` call throws BEFORE opening its own transaction - models "process died before the attempt-state write was even attempted". */
function crashBeforeNthCall(real: TenantDb, n: number): TenantDb {
  let calls = 0;
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      calls += 1;
      if (calls === n) {
        throw new Error(`simulated crash before withTenant call ${String(n)}`);
      }
      return real.withTenant(clientId, fn);
    },
  };
}

/** Wraps a real `TenantDb` so its Nth `withTenant` call lets `fn` run to completion, then throws INSIDE that same real transaction (before its own COMMIT) - the transaction rolls back, modelling a crash mid-transaction. */
function crashAfterNthCallBody(real: TenantDb, n: number): TenantDb {
  let calls = 0;
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      calls += 1;
      if (calls === n) {
        return real.withTenant(clientId, async (tx) => {
          await fn(tx);
          throw new Error(`simulated abort after withTenant call ${String(n)} body ran`);
        });
      }
      return real.withTenant(clientId, fn);
    },
  };
}

describe('the guard-first debit - crash injection (real Postgres)', () => {
  it('one_hundred_crash_injected_sends_produce_exactly_one_charge_each', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const realTenantDb = createTenantDb(pool);
    const rng = mulberry32(42);
    const checkpoints = [
      'after_attempt_only',
      'full_then_replay',
      'full_then_repaired_path',
      'mid_transaction_abort_then_replay',
    ] as const;
    const seenCheckpoints = new Set<string>();

    for (let i = 0; i < 100; i += 1) {
      const job = await seedClaimedJob(pool, { clientId, instanceId });
      await pool.query(
        `INSERT INTO send_attempts
           (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
            attempt_no, state, prepared_at, dispatched_at)
         VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
        [clientId, instanceId, job.id, job.createdAt, job.leaseId],
      );
      const checkpointIndex = Math.floor(rng() * checkpoints.length);
      const checkpoint = checkpoints[Math.min(checkpointIndex, checkpoints.length - 1)]!;
      seenCheckpoints.add(checkpoint);

      const baseInput = {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId: job.leaseId,
        attemptNo: 1,
        publicId: job.publicId,
        outcome: { providerMsgId: `wamid.chaos-${String(i)}` },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      };

      if (checkpoint === 'after_attempt_only') {
        const crashingDb = crashBeforeNthCall(realTenantDb, 2);
        await expect(
          resolveAck(baseInput, { tenantDb: crashingDb, rng: fixedRng }),
        ).rejects.toThrow();
        await resolveAck(baseInput, { tenantDb: realTenantDb, rng: fixedRng });
      } else if (checkpoint === 'full_then_replay') {
        await resolveAck(baseInput, { tenantDb: realTenantDb, rng: fixedRng });
        await expect(
          resolveAck(baseInput, { tenantDb: realTenantDb, rng: fixedRng }),
        ).rejects.toThrow();
      } else if (checkpoint === 'full_then_repaired_path') {
        await resolveAck(baseInput, { tenantDb: realTenantDb, rng: fixedRng });
        const attemptRow = await pool.query<{ id: string }>(
          'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = 1',
          [job.id],
        );
        const attemptId = attemptRow.rows[0]!.id;
        const repaired = await chargeRepairedSend(realTenantDb, { clientId, attemptId }, {});
        expect(repaired.guardRows).toBe(0);
      } else {
        const crashingDb = crashAfterNthCallBody(realTenantDb, 2);
        await expect(
          resolveAck(baseInput, { tenantDb: crashingDb, rng: fixedRng }),
        ).rejects.toThrow();
        await resolveAck(baseInput, { tenantDb: realTenantDb, rng: fixedRng });
      }
    }

    const guardCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'debit_send'",
      [clientId],
    );
    expect(guardCount.rows[0]?.count).toBe('100');

    const ledgerCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'",
      [clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('100');

    const unstamped = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND ledger_seq <= 0',
      [clientId],
    );
    expect(unstamped.rows[0]?.count).toBe('0');

    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe(String(100_000 - 100 * 15));

    for (const checkpoint of checkpoints) {
      expect(seenCheckpoints.has(checkpoint)).toBe(true);
    }
  });
});
