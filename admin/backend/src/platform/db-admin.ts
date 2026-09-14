import { createPool } from '@wp/db';
import type { AdminConfig } from './config.js';

/**
 * platform/db-admin.ts (P28 Unit U4, step 6) - THE ONLY file in
 * admin-backend that constructs a database pool. `platform-read.test.ts#
 * a_cross_tenant_read_outside_platform_read_is_impossible` asserts that
 * mechanically (a source scan for `createPool(`/`new Pool(` across the whole
 * tree), which is what makes "every cross-tenant read goes through
 * `platformRead()` and therefore writes an audit row" unbypassable rather
 * than merely conventional: no other module can obtain a connection to open
 * an unaudited read.
 *
 * The pool connects as the POOL user (the login role in
 * `ADMIN_DATABASE_URL`), never as `wp_admin_app` - that role is NOLOGIN
 * (migration 0005) and is entered per-transaction by `platform-read.ts` (the
 * one file allowed to issue that role change - its own source-scan test
 * pins that), so the BYPASSRLS privilege is held for exactly the span of one
 * audited read and is dropped at COMMIT/ROLLBACK.
 *
 * `max: 5` (vs app-backend's much larger pool): admin traffic is a handful
 * of staff, and this pool shares a Postgres instance with the send path -
 * a slow admin query must never be able to starve customer sending of
 * connections. `statementTimeoutMs: 5000` is server-side (see
 * `@wp/db`'s `createPool`), so an accidentally-unbounded admin scan is
 * killed by Postgres itself rather than held open by application code.
 */

export type AdminPool = ReturnType<typeof createPool>;

/** The ONE admin pool factory (see module header) - no other export, so nothing can build a differently-configured pool. */
export function createAdminPool(config: AdminConfig): AdminPool {
  return createPool({
    connectionString: config.ADMIN_DATABASE_URL,
    applicationName: 'wp-admin-api',
    max: 5,
    statementTimeoutMs: 5000,
  });
}
