import type pg from 'pg';
import {
  fetchFunctionAttributes,
  fetchRoleAttributes,
  SNAPSHOT_ROLES,
  type ColumnGrantRow,
  type FunctionAttributesRow,
  type RoleAttributesRow,
  type TableGrantRow,
} from './grants.js';

/**
 * P02 step 10 - grant-snapshot canonicalization/shaping. Split out of
 * `grants.ts` (P03 close, max-lines cap) so the plain query helpers stay in
 * one file and the canonicalization/dump-shaping logic stays in another;
 * `grants-snapshot.test.ts` imports from both.
 */

export interface CanonicalGrantDump {
  roles: RoleAttributesRow[];
  tableGrants: TableGrantRow[];
  columnGrants: ColumnGrantRow[];
  functions: FunctionAttributesRow[];
}

/**
 * A monthly partition CHILD name (message_jobs, wallet_ledger) embeds the
 * migration-run month (e.g. `wallet_ledger_y2026m08`); a weekly partition
 * CHILD name (delivery_events, seeded current-week+2 by migration 0009)
 * embeds the migration-run ISO week (e.g. `delivery_events_y2026w35`). Left
 * raw, the snapshot would drift every month/week and every machine that
 * re-runs the partition-creation migration - a weekly child in particular
 * drifts on every calendar week boundary, not just monthly. Any table_name
 * ending in `_y<4 digits>m<2 digits>` or `_y<4 digits>w<2 digits>` is
 * rewritten to the generic `<parent>_yNNNNmNN` / `<parent>_yNNNNwNN`
 * placeholder (matching the suffix's own unit letter) BEFORE the rows are
 * deduped and sorted, so N identical monthly/weekly children collapse into
 * one canonical row per (grantee, privilege_type).
 */
const PARTITION_SUFFIX_RE = /_y\d{4}(m\d{2}|w\d{2})$/;

export function canonicalizePartitionTableName(tableName: string): string {
  const match = PARTITION_SUFFIX_RE.exec(tableName);
  if (!match) {
    return tableName;
  }
  const unit = (match[1] as string).startsWith('w') ? 'w' : 'm';
  return tableName.replace(PARTITION_SUFFIX_RE, `_yNNNN${unit}NN`);
}

function compareTableGrantRows(a: TableGrantRow, b: TableGrantRow): number {
  return (
    a.grantee.localeCompare(b.grantee) ||
    a.table_name.localeCompare(b.table_name) ||
    a.privilege_type.localeCompare(b.privilege_type)
  );
}

function compareColumnGrantRows(a: ColumnGrantRow, b: ColumnGrantRow): number {
  return (
    a.grantee.localeCompare(b.grantee) ||
    a.table_name.localeCompare(b.table_name) ||
    a.privilege_type.localeCompare(b.privilege_type)
  );
}

/**
 * Fetches every `public` schema table-grant row for the four snapshot
 * roles, canonicalizes partition-child table names (see
 * `canonicalizePartitionTableName`), dedupes the resulting
 * (grantee, table_name, privilege_type) triples, and returns them in stable
 * sorted order.
 */
export async function fetchCanonicalTableGrants(
  pool: pg.Pool | pg.PoolClient,
): Promise<TableGrantRow[]> {
  const result = await pool.query<TableGrantRow>(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = ANY($1::name[])
        AND table_schema = 'public'
      ORDER BY grantee, table_name, privilege_type`,
    [SNAPSHOT_ROLES as unknown as string[]],
  );

  const seen = new Map<string, TableGrantRow>();
  for (const row of result.rows) {
    const canonicalRow: TableGrantRow = {
      grantee: row.grantee,
      table_name: canonicalizePartitionTableName(row.table_name),
      privilege_type: row.privilege_type,
    };
    const key = `${canonicalRow.grantee} ${canonicalRow.table_name} ${canonicalRow.privilege_type}`;
    seen.set(key, canonicalRow);
  }

  return [...seen.values()].sort(compareTableGrantRows);
}

/**
 * Fetches every `public` schema COLUMN-grant row for the four snapshot
 * roles from `information_schema.role_column_grants` (P03 close, finding
 * 3): `role_table_grants` is table-level only, so a column-narrowed GRANT
 * (e.g. migration 0012's `GRANT SELECT (id, ...) ON message_jobs TO
 * wp_scheduler`) is otherwise invisible to the snapshot - the table simply
 * has no row for that role, which reads as "no access" instead of
 * "narrowed access", and a future `GRANT UPDATE (status) ON message_jobs TO
 * wp_admin_app` (the forbidden staff-resume mechanism) would land with zero
 * automated evidence.
 *
 * Postgres represents an ordinary table-level GRANT as an ACL entry on the
 * relation, but `role_column_grants` reports it expanded to one row per
 * column of that table (verified against the live dev DB) - so a
 * table-level grant and a column-narrowed grant both show up here, just
 * with a full vs. partial column list. Rows are canonicalized
 * (partition-child names) and grouped into one row per (grantee,
 * table_name, privilege_type) with a sorted, deduped column list, so the
 * snapshot stays readable instead of one row per column.
 */
export async function fetchCanonicalColumnGrants(
  pool: pg.Pool | pg.PoolClient,
): Promise<ColumnGrantRow[]> {
  const result = await pool.query<{
    grantee: string;
    table_name: string;
    column_name: string;
    privilege_type: string;
  }>(
    `SELECT grantee, table_name, column_name, privilege_type
       FROM information_schema.role_column_grants
      WHERE grantee = ANY($1::name[])
        AND table_schema = 'public'
      ORDER BY grantee, table_name, privilege_type, column_name`,
    [SNAPSHOT_ROLES as unknown as string[]],
  );

  const grouped = new Map<string, ColumnGrantRow>();
  for (const row of result.rows) {
    const tableName = canonicalizePartitionTableName(row.table_name);
    const key = `${row.grantee} ${tableName} ${row.privilege_type}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.columns.includes(row.column_name)) {
        existing.columns.push(row.column_name);
      }
    } else {
      grouped.set(key, {
        grantee: row.grantee,
        table_name: tableName,
        privilege_type: row.privilege_type,
        columns: [row.column_name],
      });
    }
  }

  const rows = [...grouped.values()];
  for (const row of rows) {
    row.columns.sort();
  }
  return rows.sort(compareColumnGrantRows);
}

/** Full canonical dump: `{ roles, tableGrants, columnGrants, functions }`, all in stable order. */
export async function fetchCanonicalGrantDump(
  pool: pg.Pool | pg.PoolClient,
): Promise<CanonicalGrantDump> {
  const [roles, tableGrants, columnGrants, functions] = await Promise.all([
    fetchRoleAttributes(pool),
    fetchCanonicalTableGrants(pool),
    fetchCanonicalColumnGrants(pool),
    fetchFunctionAttributes(pool),
  ]);
  return { roles, tableGrants, columnGrants, functions };
}

/** Serializes a canonical dump the same way on every call: 2-space indent, trailing newline. */
export function serializeCanonicalGrantDump(dump: CanonicalGrantDump): string {
  return `${JSON.stringify(dump, null, 2)}\n`;
}
