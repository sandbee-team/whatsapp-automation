import type { TenantQueryable } from '@wp/db';

/**
 * modules/realtime/authz.repo.ts (P05 Unit U3b) - the single batched query
 * `authz-tick.ts` issues per tick: one call to the SECURITY DEFINER function
 * `public.wp_realtime_authz_snapshot` (migration 0017), never a per-
 * connection or per-user query (phase risk, canon: "Re-authorisation must
 * not be O(connections) queries"). This is a function CALL, not a direct
 * read of `memberships`/`clients` (both FORCE RLS, migration 0005) - see the
 * migration's own header comment for why a plain `SELECT ... FROM
 * memberships` under `wp_app` with no `app.client_id` GUC would silently
 * return zero rows for every user (fail-unclear must never look like
 * fail-revoked).
 */

export type ClientStatus = 'active' | 'suspended' | 'closed' | (string & {});

export interface AuthzSnapshotRow {
  userId: string;
  tokenEpoch: number;
  /** NULL when the user has no membership row - itself the "membership revoked" signal. */
  clientId: string | null;
  clientStatus: ClientStatus | null;
}

interface AuthzSnapshotDbRow extends Record<string, unknown> {
  user_id: string;
  token_epoch: number;
  client_id: string | null;
  client_status: ClientStatus | null;
}

/**
 * Loads the authz snapshot for exactly `userIds` - a user id absent from the
 * result (deleted/never existed) is itself a drop signal the caller
 * distinguishes by absence. Empty input returns `[]` WITHOUT querying (no
 * point round-tripping to Postgres for zero users, and an empty `= ANY($1)`
 * array is legal SQL anyway - this is purely an optimisation for the common
 * "hub has no connections yet" case).
 */
export async function loadAuthzSnapshot(
  sql: TenantQueryable,
  userIds: readonly string[],
): Promise<AuthzSnapshotRow[]> {
  if (userIds.length === 0) {
    return [];
  }

  const result = await sql.query<AuthzSnapshotDbRow>(
    `SELECT user_id, token_epoch, client_id, client_status FROM public.wp_realtime_authz_snapshot($1::uuid[])`,
    [userIds],
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    tokenEpoch: row.token_epoch,
    clientId: row.client_id,
    clientStatus: row.client_status,
  }));
}
