import type { CrossTenantQueryEntry } from './cross-tenant-queries.js';
import { CROSS_TENANT_QUERIES_P28_ADMIN_READS } from './cross-tenant-queries-p28-admin-reads.js';

/**
 * cross-tenant-queries-p28-admin.ts (P28 Unit U4, steps 6-7) - the
 * `admin/backend` PLATFORM-READ surface's registry entries. Distinct from
 * the sibling `cross-tenant-queries-p28.ts`, which registers `app/backend`'s
 * `/internal/v1` staff-MUTATION spans; this module registers only reads, and
 * every one runs as `wp_admin_app` through
 * `admin/backend/src/platform/platform-read.ts`.
 *
 * ONE SHARED GATE, true of every entry here (never re-stated per entry):
 *  1. reachable only through `platformRead()`, which is the ONLY code in
 *     admin-backend that may `SET LOCAL ROLE wp_admin_app`
 *     (`platform-read.test.ts` proves this with a source scan) and which
 *     writes an `audit_logs` row (`action = 'platform.read'`, carrying the
 *     read key and the staff member's stated reason) in the SAME
 *     transaction - a read that returns data has always left a trail, and a
 *     read that fails leaves neither trail nor data;
 *  2. behind a staff session: an argon2id password + MANDATORY TOTP login
 *     from an allow-listed IP CIDR, a 2-minute access token, and a
 *     server-side `canStaff(role, '<area>.read')` re-check per request;
 *  3. `wp_admin_app` holds SELECT on these tables and INSERT on
 *     `audit_logs` ONLY - it cannot write tenant or send-path data at all
 *     (migration 0070; blueprint R-33), so a defect in this code fails with
 *     Postgres `42501` rather than corrupting a tenant.
 *
 * PROJECTION DISCIPLINE, also shared: no entry projects `phone_e164`,
 * `owner_jid`, `label`, `full_name`, `email`, `payload`, `external_ref` or
 * any `recipient_*` column. `company_name` is projected (a workspace's
 * business identity, which is the thing staff act on) and `reason` is
 * projected from `staff_audit_log` only (text a STAFF member wrote about
 * their own action - the point of an audit trail). Reading a tenant's actual
 * message content requires a separate, time-boxed, separately-audited
 * impersonation grant; it is never a side effect of an admin list.
 *
 * The 14 real read entries live in the sibling
 * `cross-tenant-queries-p28-admin-reads.ts` (this file would otherwise
 * breach `max-lines: 300` - the same per-phase split idiom as the P23/P25/
 * P26 modules); this file owns the shared rationale above plus the one
 * test-only entry below.
 */
export const CROSS_TENANT_QUERIES_P28_ADMIN: Record<string, CrossTenantQueryEntry> = Object.freeze({
  ...CROSS_TENANT_QUERIES_P28_ADMIN_READS,

  /**
   * TEST-ONLY, and deliberately registered rather than exempted: the proof
   * that a write from inside `platformRead()` is impossible. Its read
   * function attempts `INSERT INTO message_jobs`, which `wp_admin_app` has
   * no grant for, so Postgres refuses it with `42501` - the guarantee comes
   * from the GRANT SURFACE, not from application care. Registering it here
   * keeps the mechanical claim honest: this file lists every span, including
   * the one whose whole purpose is to fail.
   */
  'admin/backend/src/modules/clients/write-attempt-probe.read.ts:attemptSendPathWrite': {
    role: 'wp_admin_app',
    reason:
      'P28 U4 test-only probe (clients.read.integration.test.ts#admin_backend_never_opens_a_write_connection_to_a_send_path_table) - deliberately attempts INSERT INTO message_jobs under platformRead to prove wp_admin_app has no write grant on a send-path table: the statement is refused by Postgres with 42501, the surrounding transaction rolls back, and the audit row rolls back with it. Never reachable from any route - it is exported for the integration test only and registered here so the registry describes every span in the tree, including this one.',
    projectedColumns: ['(none - the statement is refused before it can project anything)'],
  },
});
