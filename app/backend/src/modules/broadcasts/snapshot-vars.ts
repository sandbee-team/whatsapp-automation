/**
 * snapshot-vars.ts (P23 Unit U4, step 4) - builds the `freezeVars` source
 * object from one `snapshot-audience-batch.sql` row. `@wp/domain#freezeVars`
 * resolves dotted paths (`attrs.city`) against this object, so `attrs` is
 * passed through as a nested object (already jsonb from Postgres, never
 * re-parsed), and the flat fields it also supports
 * (`first_name`/`last_name`/`display_name`/`phone_e164`) are top-level keys -
 * exactly the token vocabulary the phase canon names.
 */
export interface SnapshotAudienceRow extends Record<string, unknown> {
  contact_id: string;
  wa_jid: string;
  phone_e164: string;
  phone_hash: Buffer;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  attrs: Record<string, unknown>;
  is_opted_out: boolean;
}

/** The `freezeVars(body, source)` source object for one audience row - never a live re-read later (frozen once, at snapshot time). */
export function freezeVarsSource(row: SnapshotAudienceRow): Record<string, unknown> {
  return {
    first_name: row.first_name,
    last_name: row.last_name,
    display_name: row.display_name,
    phone_e164: row.phone_e164,
    attrs: row.attrs,
  };
}
