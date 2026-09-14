import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-wallet-debit.integration.test.ts (P18 Unit U3, split from
 * `result.integration.test.ts` at the max-lines cap - topic split only, no
 * behavior change, same idiom as `result-failure.integration.test.ts`) -
 * supersedes P11's "nothing in this phase writes a wallet row" now that
 * `resolveAck` charges the wallet via `chargeSend` (see `result.ts`'s own
 * module doc). The full exactly-once/replay/concurrency proof lives in
 * `modules/wallet/debit.integration.test.ts`; this file only proves the
 * ack path's own end-to-end shape (right price key, right amount, right
 * balance) reachable through `resolveAck` itself.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-wallet-debit-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveAck wallet debit - real Postgres', () => {
  it('a_successful_send_writes_exactly_one_wallet_debit_at_the_text_rate', async () => {
    // Default seeded rate for 'text' is 15 (default_inr, migration 0005).
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        outcome: { providerMsgId: 'wamid.money' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      deps,
    );

    const ledgerRows = await pool.query<{ amount_minor: string; price_key: string }>(
      'SELECT amount_minor::text, price_key FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRows.rows).toEqual([{ amount_minor: '-15', price_key: 'text' }]);

    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('99985');
  });
});
