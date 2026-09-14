import type { AdminAppQueryable } from './staff-audit.js';

/**
 * idempotency.ts (P28 Unit U3a, step 4; C2 fix round 2 - client-scoped
 * replay) - `readReplay`, the `staff_audit_log` lookup `with-staff-mutation.ts`
 * runs ONLY after its own INSERT hits the `staff_audit_log_idempotency_key_key`
 * unique-violation (SQLSTATE 23505) - never a pre-check (core invariant 3:
 * idempotency at the storage layer, not an in-memory/pre-read check).
 * `computeRequestHash` (now over `{method, path, body}`, so the SAME
 * idempotency key reused against a different route is a mismatch, not a
 * silent cross-route replay) stays in `staff-audit.ts` (see that file's own
 * header for why it lives there).
 *
 * Runs under `wp_admin_app` (BYPASSRLS - `staff-audit.ts#withAdminAppRole`'s
 * role idiom, applied here by the caller): the row that triggered the
 * unique-violation may belong to a DIFFERENT client than the one on the
 * losing transaction's `app.client_id` GUC (idempotency key reused across
 * clients), and `staff_audit_log` is RLS-forced on `client_id` - under
 * `wp_app` that row would be invisible to the losing session and this lookup
 * would wrongly report "no row" for a case that is really a cross-client
 * reuse. `readReplay` itself therefore takes the caller's `clientId` and
 * decides: different `client_id` OR different `request_hash` -> reuse (409
 * `IDEMPOTENCY_KEY_REUSED`); same client AND same hash -> the stored result.
 */

export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
  constructor() {
    super('This idempotency key was already used for a different request.');
    this.name = 'IdempotencyKeyReusedError';
  }
}

interface AuditReplayRow extends Record<string, unknown> {
  id: string;
  client_id: string | null;
  request_hash: string;
  result: string;
  action: string;
}

export interface ReplayResult {
  auditId: string;
  action: string;
  /** The stored `result` JSON, parsed - always an object (see `with-staff-mutation.ts`'s UPDATE). */
  result: unknown;
}

/**
 * Looks up the `staff_audit_log` row for `idempotencyKey` (unique, migration
 * 0070). `db` MUST be a connection running under `wp_admin_app` (BYPASSRLS) -
 * see the module header for why RLS under `wp_app` is unsafe here. Throws
 * `IdempotencyKeyReusedError` when the stored row belongs to a different
 * `clientId` OR its `request_hash` does not match `requestHash` (same key,
 * different client or different request) - matches on both -> returns the
 * stored result with `replayed: true` semantics (the caller wraps this).
 */
export async function readReplay(
  db: AdminAppQueryable,
  idempotencyKey: string,
  clientId: string | null,
  requestHash: string,
): Promise<ReplayResult> {
  const result = await db.query<AuditReplayRow>(
    `SELECT id, client_id, request_hash, result, action FROM staff_audit_log WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) {
    // The INSERT that triggered this lookup hit a unique-violation on this
    // exact key, so a row MUST exist - a concurrent transaction that has not
    // yet committed is invisible here (read-committed); the caller retries
    // via the standard Postgres unique-index blocking/serialization path,
    // never an in-memory wait loop. This is a defect, not a reuse - it stays
    // an unexpected-state 500 (logged with a `defect` marker by the caller).
    throw new Error(
      `readReplay: no staff_audit_log row for idempotency_key=${idempotencyKey} despite a unique-violation on it`,
    );
  }
  if (row.client_id !== clientId || row.request_hash !== requestHash) {
    throw new IdempotencyKeyReusedError();
  }
  return { auditId: row.id, action: row.action, result: JSON.parse(row.result) as unknown };
}
