import type pg from 'pg';

/**
 * P02 step 10 - grant-snapshot support. Plain query helpers (no
 * canonicalization/dump-shaping - see `grants-canonical.ts` for that, split
 * out at P03 close for the max-lines cap) so `grants-snapshot.test.ts` stays
 * readable; nothing here touches the filesystem.
 */

// P12 U2a (migration 0027) adds a FIFTH role, `wp_reaper` - NOLOGIN,
// BYPASSRLS, owner of `wp_reap_expired_leases` ONLY (see that migration's
// header for the full rationale). P13a FIX ROUND (migration 0034) adds a
// SIXTH, `wp_warmup` - same shape, owner of `wp_warmup_apply_tier_change`
// ONLY. P15 C1 FIX F4 (MAJ-2) adds a SEVENTH, `wp_relay` (migration 0041) -
// NOLOGIN, BYPASSRLS, the outbox-relay/webhook-dispatcher's own cross-tenant
// claim/publish/cleanup surface (`outbox_events`/`webhook_deliveries`/a
// column-scoped `webhook_endpoints` write, migrations 0041/0042). It was
// OMITTED from this list entirely at U1/U5 close, so its whole grant surface
// was previously UNPINNED by the snapshot (a stale claim it was captured -
// the snapshot held zero wp_relay rows). All roles included here
// deliberately so every grants-snapshot assertion covers them automatically.
export const SNAPSHOT_ROLES = [
  'wp_migrator',
  'wp_app',
  'wp_scheduler',
  'wp_admin_app',
  'wp_reaper',
  'wp_warmup',
  'wp_relay',
] as const;
export type SnapshotRole = (typeof SNAPSHOT_ROLES)[number];

export interface RoleAttributesRow {
  rolname: string;
  rolbypassrls: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
}

export interface TableGrantRow {
  grantee: string;
  table_name: string;
  privilege_type: string;
}

export interface ColumnGrantRow {
  grantee: string;
  table_name: string;
  privilege_type: string;
  /** Sorted, deduped column names this (grantee, table, privilege) covers. */
  columns: string[];
}

export interface FunctionAttributesRow {
  proname: string;
  owner: string;
  prosecdef: boolean;
  proconfig: string[] | null;
}

/**
 * Fetches the four roles' `pg_roles` attributes, ordered by `rolname`.
 */
export async function fetchRoleAttributes(
  pool: pg.Pool | pg.PoolClient,
): Promise<RoleAttributesRow[]> {
  const result = await pool.query<RoleAttributesRow>(
    `SELECT rolname, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
       FROM pg_roles
      WHERE rolname = ANY($1::name[])
      ORDER BY rolname`,
    [SNAPSHOT_ROLES as unknown as string[]],
  );
  return result.rows;
}

/**
 * Fetches `pg_proc` attributes for every `wp_*` function in `public`,
 * ordered by `proname` - the reviewer-M1 addition (findings M1/M2) that lets
 * `grants-snapshot.test.ts` catch a future blanket REASSIGN OWNED, or a
 * search_path regression, silently turning a SECURITY DEFINER gate into a
 * no-op.
 */
export async function fetchFunctionAttributes(
  pool: pg.Pool | pg.PoolClient,
): Promise<FunctionAttributesRow[]> {
  const result = await pool.query<FunctionAttributesRow>(
    `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname LIKE 'wp\\_%' ESCAPE '\\'
      ORDER BY p.proname`,
  );
  return result.rows;
}

/**
 * Live (uncanonicalized-name) grant rows for one grantee restricted to a
 * specific set of table names - used by the tests that must reason about
 * partition children individually (they need to know the actual child
 * names, not the `_yNNNNmNN` placeholder).
 */
export async function fetchLiveGrantsForTables(
  pool: pg.Pool | pg.PoolClient,
  grantee: string,
  tableNames: readonly string[],
): Promise<TableGrantRow[]> {
  if (tableNames.length === 0) {
    return [];
  }
  const result = await pool.query<TableGrantRow>(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = $1
        AND table_schema = 'public'
        AND table_name = ANY($2::name[])
      ORDER BY table_name, privilege_type`,
    [grantee, tableNames as unknown as string[]],
  );
  return result.rows;
}

export interface LiveColumnGrantRow {
  grantee: string;
  table_name: string;
  column_name: string;
  privilege_type: string;
}

/**
 * Live (uncanonicalized-name) COLUMN-grant rows for one grantee restricted
 * to a specific set of table names - the column-level counterpart of
 * `fetchLiveGrantsForTables` (P03 close, finding 3). Used where a
 * table-level-only check would miss a column-narrowed write grant (e.g. a
 * future `GRANT UPDATE (status) ON message_jobs TO wp_admin_app`, which
 * never shows up in `role_table_grants` at all).
 */
export async function fetchLiveColumnGrantsForTables(
  pool: pg.Pool | pg.PoolClient,
  grantee: string,
  tableNames: readonly string[],
): Promise<LiveColumnGrantRow[]> {
  if (tableNames.length === 0) {
    return [];
  }
  const result = await pool.query<LiveColumnGrantRow>(
    `SELECT grantee, table_name, column_name, privilege_type
       FROM information_schema.role_column_grants
      WHERE grantee = $1
        AND table_schema = 'public'
        AND table_name = ANY($2::name[])
      ORDER BY table_name, privilege_type, column_name`,
    [grantee, tableNames as unknown as string[]],
  );
  return result.rows;
}

/** Direct partition children (one level) of `public.<parentTable>`, by name. */
export async function fetchPartitionChildren(
  pool: pg.Pool | pg.PoolClient,
  parentTable: string,
): Promise<string[]> {
  const result = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_catalog.pg_inherits i
       JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE i.inhparent = $1::regclass
        AND n.nspname = 'public'
      ORDER BY c.relname`,
    [`public.${parentTable}`],
  );
  return result.rows.map((row) => row.relname);
}

/** The subset of `tableNames` that currently exist as `public.<name>` base tables/partitions. */
export async function fetchExistingTables(
  pool: pg.Pool | pg.PoolClient,
  tableNames: readonly string[],
): Promise<string[]> {
  if (tableNames.length === 0) {
    return [];
  }
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::name[])
      ORDER BY table_name`,
    [tableNames as unknown as string[]],
  );
  return result.rows.map((row) => row.table_name);
}
