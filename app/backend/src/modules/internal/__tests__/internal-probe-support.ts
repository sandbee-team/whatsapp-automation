import { randomUUID } from 'node:crypto';
import type { createPool } from '@wp/db';

/**
 * internal-probe-support.ts (P28 Unit U3a, step 4) - the row-level probe
 * READS and body builders shared by `internal-auth.integration.test.ts` and
 * `internal-mutations.integration.test.ts`. Split out of those two files for
 * their own `max-lines: 300` cap (the established sibling-split idiom, see
 * `session-worker-discovery-wiring.ts`), and because both files must count
 * the SAME tables the same way - a divergent probe would let one file's
 * "wrote nothing" assertion pass while the other's failed.
 *
 * Every query here is scoped to an explicit `client_id`/`idempotency_key`
 * probe value - never a whole-table count and never a `LIKE` name pattern,
 * so a parallel test run on the shared `wp_test2` database can never observe
 * another file's rows. NOT itself a test file.
 */

export type ProbePool = ReturnType<typeof createPool>;

export interface ProbeCounts {
  audit: number;
  ledger: number;
  /** Read as `::text`, so a balance past `Number.MAX_SAFE_INTEGER` compares exactly. */
  balanceMinor: string;
}

/** The three "did anything land?" numbers every fail-closed case asserts, for ONE client. */
export async function probeCounts(pool: ProbePool, clientId: string): Promise<ProbeCounts> {
  const audit = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM staff_audit_log WHERE client_id = $1`,
    [clientId],
  );
  const ledger = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM wallet_ledger WHERE client_id = $1`,
    [clientId],
  );
  const account = await pool.query<{ balance_minor: string }>(
    `SELECT balance_minor::text AS balance_minor FROM wallet_accounts WHERE client_id = $1`,
    [clientId],
  );
  return {
    audit: Number(audit.rows[0]?.n ?? '0'),
    ledger: Number(ledger.rows[0]?.n ?? '0'),
    balanceMinor: account.rows[0]?.balance_minor ?? '',
  };
}

export interface LedgerProbeRow extends Record<string, unknown> {
  seq: string;
  kind: string;
  actor_type: string;
  actor_staff_id: string | null;
  amount_minor: string;
  balance_after_minor: string;
}

/** Every `wallet_ledger` row for `clientId`, oldest first, all money columns as `::text`. */
export async function ledgerRows(pool: ProbePool, clientId: string): Promise<LedgerProbeRow[]> {
  const result = await pool.query<LedgerProbeRow>(
    `SELECT seq::text AS seq, kind, actor_type, actor_staff_id,
            amount_minor::text AS amount_minor,
            balance_after_minor::text AS balance_after_minor
       FROM wallet_ledger WHERE client_id = $1 ORDER BY seq ASC`,
    [clientId],
  );
  return result.rows;
}

export interface AuditProbeRow extends Record<string, unknown> {
  action: string;
  target_kind: string | null;
  target_ref: string | null;
  /** The `result` jsonb as text - `'{}'` means the post-`fn` UPDATE never ran. */
  result: string;
}

export async function auditRows(pool: ProbePool, clientId: string): Promise<AuditProbeRow[]> {
  const result = await pool.query<AuditProbeRow>(
    `SELECT action, target_kind, target_ref, result::text AS result
       FROM staff_audit_log WHERE client_id = $1 ORDER BY created_at ASC`,
    [clientId],
  );
  return result.rows;
}

/** How many `staff_audit_log` rows exist for ONE idempotency key - the replay invariant's own count. */
export async function auditCountForKey(pool: ProbePool, key: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM staff_audit_log WHERE idempotency_key = $1`,
    [key],
  );
  return Number(result.rows[0]?.n ?? '0');
}

export async function notificationKinds(pool: ProbePool, clientId: string): Promise<string[]> {
  const result = await pool.query<{ kind: string }>(
    `SELECT kind FROM notifications WHERE client_id = $1 ORDER BY created_at ASC`,
    [clientId],
  );
  return result.rows.map((row) => row.kind);
}

export async function walletAccount(
  pool: ProbePool,
  clientId: string,
): Promise<{ balanceMinor: string; state: string }> {
  const result = await pool.query<{ balance_minor: string; state: string }>(
    `SELECT balance_minor::text AS balance_minor, state FROM wallet_accounts WHERE client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`walletAccount: no wallet_accounts row for client=${clientId}`);
  }
  return { balanceMinor: row.balance_minor, state: row.state };
}

export async function topupStatus(pool: ProbePool, topupId: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM topup_requests WHERE id = $1`,
    [topupId],
  );
  return result.rows[0]?.status;
}

/** A valid `wallet/credit` body; `overrides` replaces any field (used to make a DIFFERENT body under the SAME idempotency key). */
export function creditBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: 'gate probe credit',
    amountMinor: '5000',
    kind: 'topup_manual',
    externalRef: `gate-${randomUUID()}`,
    ...overrides,
  };
}
