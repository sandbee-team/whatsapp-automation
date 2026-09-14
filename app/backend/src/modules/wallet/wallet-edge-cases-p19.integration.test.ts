import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { readTopupRequest } from './topups.repo.js';
import { readTopupForDecision } from '../internal/internal-access.js';

/**
 * wallet-edge-cases-p19.integration.test.ts (P19 C2 fix round) - the bigint
 * PAISE precision regression: `topup_requests.amount_minor` is a real
 * Postgres `bigint`, so a legitimate high-value top-up can exceed
 * `Number.MAX_SAFE_INTEGER`. `topups.repo.ts#readTopupRequest` and
 * `internal-access.ts#readTopupForDecision` must carry `amountMinor` as a
 * `bigint` end-to-end (never round-tripped through `Number()`, which
 * silently rounds `9007199254740993` to the even `9007199254740992`).
 *
 * This file originally held the full P19 C2 hardening sweep but exceeded the
 * repo's 300-line max-lines cap once formatted, and was split into three
 * siblings that hold the rest of that sweep:
 *   - wallet-edge-cases-p19-credit-crash.integration.test.ts
 *   - wallet-edge-cases-p19-notify-boundaries.integration.test.ts
 *   - wallet-edge-cases-p19-queue-status-and-precision.integration.test.ts
 * (the last of which also carries its own bigint-precision pin over the
 * repo functions this file exercises). This file is the home for the
 * regression test proving the fix, per the P19 C2 fix-round dispatch.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-cases-p19-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('bigint amount_minor precision - topup_requests.amount_minor beyond Number.MAX_SAFE_INTEGER', () => {
  it('a_seeded_bigint_range_amount_reads_back_EXACT_through_topups_repo_and_internal_access', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds);
    // Number.MAX_SAFE_INTEGER + 2, deliberately odd - Number() would round
    // it to the even 9007199254740992, so any precision regression is
    // immediately visible as a mismatch below.
    const hugeAmountMinor = '9007199254740993';
    const externalRef = `utr-${randomUUID()}`;

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO topup_requests (client_id, amount_minor, method, external_ref)
       VALUES ($1, $2::bigint, 'upi', $3) RETURNING id`,
      [seeded.clientId, hugeAmountMinor, externalRef],
    );
    const id = inserted.rows[0]!.id;

    // The raw column value is exact - the baseline the repo reads must match.
    const raw = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor::text FROM topup_requests WHERE id = $1',
      [id],
    );
    expect(raw.rows[0]?.amount_minor).toBe(hugeAmountMinor);

    // topups.repo.ts#readTopupRequest - bigint end-to-end, exact.
    const tenantDb = createTenantDb(pool);
    const viaRepo = await tenantDb.withTenant(seeded.clientId, (tx) =>
      readTopupRequest(tx, seeded.clientId, id),
    );
    expect(viaRepo).toBeDefined();
    expect(typeof viaRepo!.amountMinor).toBe('bigint');
    expect(viaRepo!.amountMinor).toBe(BigInt(hugeAmountMinor));
    expect(String(viaRepo!.amountMinor)).toBe(hugeAmountMinor);

    // internal-access.ts#readTopupForDecision - the staff approval read
    // path; this value feeds creditWalletAndNotify and becomes real money
    // in wallet_ledger, so it must be exact too.
    const viaInternal = await readTopupForDecision(pool, id);
    expect(viaInternal).toBeDefined();
    expect(typeof viaInternal!.amountMinor).toBe('bigint');
    expect(viaInternal!.amountMinor).toBe(BigInt(hugeAmountMinor));
    expect(String(viaInternal!.amountMinor)).toBe(hugeAmountMinor);
  });
});
