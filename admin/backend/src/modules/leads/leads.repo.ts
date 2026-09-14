import { withStaffRoleTx, type AdminReadPool } from '../../platform/platform-read.js';

/**
 * modules/leads/leads.repo.ts (P29 U4b) - the ONLY table this module touches
 * is `leads` (migration 0074). It is a NON-TENANT table (registered in
 * `ISOLATION_NON_TENANT_TABLES`, never `TENANT_TABLE_COVERAGE`): a marketing
 * visitor submitting the contact form has no client yet, so there is no
 * `client_id` to scope by.
 *
 * The grant surface is what makes an accidental UPDATE/DELETE structurally
 * impossible, not application discipline: `wp_admin_app` holds SELECT +
 * INSERT on `leads` only (migration 0074's `GRANT`), so a bug that tried to
 * update or delete a row would fail with Postgres `42501` rather than
 * silently succeed. This repo therefore exposes `insert` only.
 *
 * `withStaffRoleTx` (not `platformRead`) is the right primitive here: a
 * lead insert is a write, not a cross-tenant READ of existing tenant data,
 * so it does not belong in the audited-read pipeline (which would also
 * require a `StaffCtx`/reason that does not exist on an unauthenticated
 * public route).
 */

/** Source-scan anchor for `leads.routes.test.ts#the_lead_endpoint_reads_and_writes_no_tenant_table`. */
export const LEADS_TABLES_TOUCHED = ['leads'] as const;

export interface LeadRow {
  name: string;
  email: string;
  company: string | null;
  phoneE164: string | null;
  message: string | null;
  source: string;
  utm: Record<string, string>;
  ipHash: string;
}

export interface LeadsRepo {
  insert(row: LeadRow): Promise<{ id: string }>;
}

const INSERT_LEAD = `INSERT INTO leads
    (name, email, company, phone_e164, message, source, utm, ip_hash)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  RETURNING id`;

export function createLeadsRepo(pool: AdminReadPool): LeadsRepo {
  return {
    insert: async (row) => {
      const result = await withStaffRoleTx(pool, (db) =>
        db.query<{ id: string }>(INSERT_LEAD, [
          row.name,
          row.email,
          row.company,
          row.phoneE164,
          row.message,
          row.source,
          JSON.stringify(row.utm),
          row.ipHash,
        ]),
      );
      return { id: result.rows[0]!.id };
    },
  };
}
