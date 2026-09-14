import type { TenantQueryable } from '@wp/db';

/**
 * optout-mirror.ts (P20 Unit U7, step 8) - `syncOptOutMirror`, the SINGLE
 * writer of `contacts.opt_out_state`/`contacts.opted_out_at` (besides the
 * import upsert's own INSERT-time derivation and `mirror-reconcile.ts`'s
 * sweep, which both run the SAME derivation below). Design intent (P20
 * design doc S2.5): `contacts.opt_out_state` is a denormalised MIRROR of the
 * `opt_outs` table, written in the SAME transaction as the `opt_outs`
 * insert/restore - it is NEVER the gate. The gate remains `opt_outs` itself
 * (P14's three enforcement points via `isOptedOut`); nothing here is ever
 * read by `modules/pacing/**` (dependency-cruiser rule
 * `pacing-never-imports-contacts`).
 *
 * Mirror semantics (binding): a contact is `opted_out` when ANY live
 * `opt_outs` row (client- OR instance-scope, `restored_at IS NULL`) exists
 * for `(client_id, phone_hash)` - "this person has asked at least one of
 * your numbers to stop". `opted_out_at` is the EARLIEST such row's
 * `created_at`.
 *
 * `syncOptOutMirror` is called INSIDE P14's `recordOptOut`/`restoreOptOut`
 * transactions via an injected port (a later unit wires the real call) - it
 * takes the SAME transaction the caller already holds (never a separate
 * connection, so a caller rollback also rolls back the mirror write), and it
 * never writes `opt_outs` itself.
 */

export interface OptOutMirrorInput {
  clientId: string;
  phoneHash: Buffer;
}

export interface OptOutMirrorSyncResult {
  contactsUpdated: number;
}

export interface OptOutMirrorWriter {
  (tx: TenantQueryable, input: OptOutMirrorInput): Promise<OptOutMirrorSyncResult>;
}

/**
 * ONE idempotent statement, derived from the `opt_outs` authority inside the
 * caller's own transaction. A repeat call with nothing changed matches zero
 * rows (`contactsUpdated: 0`) via the `WHERE ((...) <> d.live OR ... IS
 * DISTINCT FROM ...)` drift guard - never an unconditional write. A
 * soft-deleted contact (`deleted_at IS NOT NULL`) is never matched.
 */
export const syncOptOutMirror: OptOutMirrorWriter = async (tx, input) => {
  const result = await tx.query(
    `WITH derived AS (
       SELECT EXISTS (
                SELECT 1 FROM opt_outs o
                 WHERE o.client_id = $1 AND o.phone_hash = $2 AND o.restored_at IS NULL
              ) AS live,
              (
                SELECT min(o.created_at) FROM opt_outs o
                 WHERE o.client_id = $1 AND o.phone_hash = $2 AND o.restored_at IS NULL
              ) AS first_at
     )
     UPDATE contacts c SET
            opt_out_state = CASE WHEN d.live THEN 'opted_out'::contact_opt_out_state ELSE 'none'::contact_opt_out_state END,
            opted_out_at  = d.first_at,
            updated_at    = now()
       FROM derived d
      WHERE c.client_id = $1 AND c.phone_hash = $2 AND c.deleted_at IS NULL
        AND ((c.opt_out_state = 'opted_out') <> d.live OR c.opted_out_at IS DISTINCT FROM d.first_at)`,
    [input.clientId, input.phoneHash],
  );
  return { contactsUpdated: result.rowCount ?? 0 };
};
