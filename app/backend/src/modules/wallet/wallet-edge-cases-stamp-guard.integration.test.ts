import { bindQueryParams, createPool, createTenantDb, loadNamedQuery } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createCountingNoOpRepairedSendSink } from '../queue/repaired-send-sink.js';
import { createWalletRepairedSendSink } from './wallet-sink.js';
import type { RepairedSendSink } from '../queue/repaired-send-sink.js';

/**
 * wallet-edge-cases-stamp-guard.integration.test.ts (P18 C2 hardening) -
 * real Postgres: `wallet-stamp-guard`'s own `ledger_seq = 0` replay-guard
 * predicate in isolation, plus a compile-time-only proof that the counting
 * no-op sink and the real wallet sink both satisfy `RepairedSendSink`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-stamp-guard-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wallet-stamp-guard replay predicate (real Postgres)', () => {
  it('calling_the_stamp_twice_leaves_ledger_seq_at_the_first_value', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]!.id;

    await pool.query(
      `INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
       VALUES ($1, 'debit_send', $2, 0, $3)`,
      [attemptId, seeded.clientId, seeded.jobCreatedAt],
    );

    const stampQuery = await loadNamedQuery('debit-send', 'wallet-stamp-guard');

    await tenantDb.withTenant(seeded.clientId, (tx) =>
      tx.query(
        stampQuery.text,
        bindQueryParams(stampQuery, {
          seq: '42',
          attempt: attemptId,
          kind: 'debit_send',
          client: seeded.clientId,
        }),
      ),
    );
    const afterFirst = await pool.query<{ ledger_seq: string }>(
      'SELECT ledger_seq::text FROM wallet_charge_guards WHERE send_attempt_id = $1',
      [attemptId],
    );
    expect(afterFirst.rows[0]?.ledger_seq).toBe('42');

    // Second call: the `ledger_seq = 0` predicate no longer matches (it is
    // now 42), so this UPDATE touches zero rows - a correct no-op, never
    // overwriting with a different seq.
    const second = await tenantDb.withTenant(seeded.clientId, (tx) =>
      tx.query(
        stampQuery.text,
        bindQueryParams(stampQuery, {
          seq: '99',
          attempt: attemptId,
          kind: 'debit_send',
          client: seeded.clientId,
        }),
      ),
    );
    expect(second.rowCount).toBe(0);

    const afterSecond = await pool.query<{ ledger_seq: string }>(
      'SELECT ledger_seq::text FROM wallet_charge_guards WHERE send_attempt_id = $1',
      [attemptId],
    );
    expect(afterSecond.rows[0]?.ledger_seq).toBe('42');
  });
});

describe('RepairedSendSink interface agreement (typecheck-level)', () => {
  it('the_counting_no_op_sink_and_the_real_wallet_sink_both_satisfy_RepairedSendSink', () => {
    // Assignability is checked at COMPILE TIME by TypeScript; if either
    // factory's return type ever drifts from RepairedSendSink, this file
    // fails to typecheck (tsc -b / the gate's typecheck step), which is the
    // proof this test exists for. The runtime assertion below is incidental.
    const counting: RepairedSendSink = createCountingNoOpRepairedSendSink();
    const real: RepairedSendSink = createWalletRepairedSendSink({
      tenantDb: createTenantDb(pool),
    });
    expect(typeof counting.onRepairedSent).toBe('function');
    expect(typeof counting.onReconciledLost).toBe('function');
    expect(typeof real.onRepairedSent).toBe('function');
    expect(typeof real.onReconciledLost).toBe('function');
  });
});
