import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';
import { loadQuery, bindQueryParams } from '@wp/db';

/**
 * internal-mutations-support.ts (P28 Unit U3a, step 4) - the shared fixture
 * `internal-mutations.integration.test.ts` uses (U3b appends its own cases
 * to that same file later, reusing this support module - see that file's
 * own header).
 */

export async function seedPendingTopup(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  amountMinor = 50_000,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO topup_requests (id, client_id, amount_minor, method, external_ref, status)
     VALUES ($1, $2, $3, 'upi', $4, 'pending')`,
    [id, clientId, amountMinor, `utr-${id}`],
  );
  return id;
}

/** Runs the canonical `claim-jobs.sql` claim statement (see that file's own header) for `clientId`/`instanceId`, returning the claimed row count - the same statement the real send loop uses, so a frozen/empty wallet's `w.state NOT IN ('empty','frozen')` predicate is exercised exactly as production would. */
export async function attemptClaim(
  pool: ReturnType<typeof createPool>,
  input: { clientId: string; instanceId: string; band: number; fence: number },
): Promise<number> {
  const query = await loadQuery('claim-jobs');
  const result = await pool.query(
    query.text,
    bindQueryParams(query, {
      client_id: input.clientId,
      instance_id: input.instanceId,
      band: input.band,
      fence: input.fence,
      worker: 'internal-mutations-test-worker',
      claim_expiry_ms: 30_000,
    }),
  );
  return result.rowCount ?? 0;
}
