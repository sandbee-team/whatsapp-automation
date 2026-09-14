import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  CANONICAL_AUTHORITY_KEYS,
  GLOBAL_UNIQUE_INDEXES,
  ISOLATION_NON_TENANT_TABLES,
  SUITE_A_INDEX_EXEMPTIONS,
  TENANT_TABLE_COVERAGE,
  type CanonicalAuthorityKey,
  type CatalogTableRow,
} from '../../src/index.js';
import type pg from 'pg';
import { seedContactsTenant } from './isolation-fixtures-contacts.js';
import { seedBroadcastsTenant } from './isolation-fixtures-broadcasts.js';

/**
 * Seed/cleanup machinery and probe/table-spec data for
 * `isolation-suite-a.test.ts` (blueprint mandatory isolation suite A,
 * plan/v1/P02-db-foundations-and-isolation.md step 9), split out at P03
 * close for the max-lines cap. Nothing here is an assertion - the test file
 * keeps every `expect(...)`.
 */

// prettier-ignore
export type PgError = Error & { code?: string };
export type ProbeBranch = 'rls_exercised' | 'grant_denied';

export const REGISTRY = { coverage: TENANT_TABLE_COVERAGE, nonTenant: ISOLATION_NON_TENANT_TABLES };

// Table/column names interpolated below always come from the live catalog or this file's own literals.
export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

// A template literal here would split "SET" right after `${table}`, tripping the no-plain-SET guard.
export function buildNoopUpdateSql(table: string, column: string, idColumn: string): string {
  return 'UPDATE %TABLE% SET %COL% = %COL% WHERE %ID% = $1'
    .replace(/%TABLE%/g, table)
    .replace(/%COL%/g, column)
    .replace(/%ID%/g, idColumn);
}

// prettier-ignore
type CatalogQueryRow = { table_name: string; parent_table: string | null; columns: string[] };

// Live pg_class enumeration (partitions resolved to their parent via pg_inherits, plus columns) - feeds checkCoverage/checkAllowListExists.
export async function fetchCatalogRows(pool: pg.Pool): Promise<CatalogTableRow[]> {
  const sql = `
    SELECT c.relname AS table_name, p.relname AS parent_table, array_agg(a.attname ORDER BY a.attnum) AS columns FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid LEFT JOIN pg_catalog.pg_class p ON p.oid = i.inhparent JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') GROUP BY c.relname, p.relname`;
  const result = await pool.query<CatalogQueryRow>(sql);
  return result.rows.map((row) => ({
    tableName: row.table_name,
    parentTable: row.parent_table,
    columns: row.columns,
  }));
}

// Every live table/partition-child name whose effective (parent-resolved) table is covered.
export function coveredLiveTableNames(catalogRows: readonly CatalogTableRow[]): string[] {
  return catalogRows
    .filter((row) =>
      Object.prototype.hasOwnProperty.call(TENANT_TABLE_COVERAGE, row.parentTable ?? row.tableName),
    )
    .map((row) => row.tableName);
}

// prettier-ignore
export type IndexCatalogRow = {
  effective_table: string; index_name: string; indisunique: boolean; indisprimary: boolean; first_column: string | null;
};

// Every index on the covered tables + partition children (first key column); LEFT JOIN (not JOIN) on pg_attribute so an expression index (indkey[0]=0, no matching attribute row) surfaces as a violation/waiver instead of silently vanishing from the scan (N11).
export async function fetchCoveredIndexRows(pool: pg.Pool): Promise<IndexCatalogRow[]> {
  const coveredTableNames = Object.keys(TENANT_TABLE_COVERAGE);
  const sql = `
    WITH target_tables AS (
      SELECT c.oid AS table_oid, COALESCE(p.relname, c.relname) AS effective_table FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid LEFT JOIN pg_catalog.pg_class p ON p.oid = i.inhparent WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND COALESCE(p.relname, c.relname) = ANY($1)
    )
    SELECT tt.effective_table, ic.relname AS index_name, ix.indisunique, ix.indisprimary, a.attname AS first_column FROM pg_catalog.pg_index ix JOIN target_tables tt ON tt.table_oid = ix.indrelid JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]`;
  const result = await pool.query<IndexCatalogRow>(sql, [coveredTableNames]);
  return result.rows;
}

// Does a registered CANONICAL_AUTHORITY_KEYS entry for this table explain why `row` legitimately does
// not lead with the tenant key? `leading_column` deliberately excludes PK rows (a PK match must go
// through `primary_key`) so a single entry can't accidentally paper over an unrelated PK violation.
function matchesCanonicalAuthority(
  entries: readonly CanonicalAuthorityKey[] | undefined,
  row: IndexCatalogRow,
): boolean {
  if (!entries) return false;
  return entries.some((entry) => {
    if (entry.reason.trim().length === 0) return false;
    switch (entry.match.kind) {
      case 'primary_key':
        return row.indisprimary;
      case 'named':
        return row.index_name === entry.match.indexName;
      case 'leading_column':
        return !row.indisprimary && row.first_column === entry.match.column;
      default:
        return false;
    }
  });
}

// Pure violation detector for the "every index leads with client_id" rule - DB-independent so its
// guard power (an unregistered non-leading unique index must still fail) and its name-independence
// for partitioned tables (a not-yet-created future partition's auto-named index must still be
// recognized) both have a fast, deterministic proof alongside the live-catalog assertion below.
export function computeIndexLeadViolations(indexRows: readonly IndexCatalogRow[]): string[] {
  const exemptions: readonly string[] = SUITE_A_INDEX_EXEMPTIONS;
  const violations: string[] = [];
  for (const row of indexRows) {
    const tenantKeyColumn = TENANT_TABLE_COVERAGE[row.effective_table];
    if (row.first_column === tenantKeyColumn) continue;
    // N13: exempt only for UNIQUE indexes on these tables - a non-unique index still must lead with client_id.
    if (exemptions.includes(row.effective_table) && row.indisunique) continue;
    if (row.indisunique && !row.indisprimary) {
      const reason = GLOBAL_UNIQUE_INDEXES[row.index_name];
      if (reason !== undefined && reason.trim().length > 0) continue;
    }
    if (matchesCanonicalAuthority(CANONICAL_AUTHORITY_KEYS[row.effective_table], row)) continue;
    violations.push(
      `index "${row.index_name}" on "${row.effective_table}" leads with "${row.first_column}", ` +
        `expected tenant-key column "${String(tenantKeyColumn)}" (or a GLOBAL_UNIQUE_INDEXES/CANONICAL_AUTHORITY_KEYS entry)`,
    );
  }
  return violations;
}

// prettier-ignore
export type SeededTenant = { label: string; userId: string; clientId: string; instanceId: string; externalRef: string; contactId: string; tagId: string; importId: string };

// Seeds one tenant with one row in every covered table, as superuser (bypasses RLS); unique per run.
export async function seedTenant(pool: pg.Pool, label: string): Promise<SeededTenant> {
  const suffix = randomBytes(6).toString('hex');
  const userId = randomUUID();
  const clientId = randomUUID();
  const instanceId = randomUUID();
  const campaignId = randomUUID();
  const externalRef = `isolation-suite-a-${label}-${suffix}`;
  const name = `Isolation Suite A ${label}`;
  const slug = `isolation-suite-a-${label}-${suffix}`;

  // prettier-ignore
  const inserts: Array<[string, unknown[]]> = [
    ['INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [userId, name, `${slug}@example.com`]],
    ['INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [clientId, name, slug]],
    ['INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [clientId, userId, 'owner']],
    ['INSERT INTO client_pricing (client_id, price_list_key) VALUES ($1, $2)', [clientId, 'default_inr']],
    ['INSERT INTO wallet_accounts (client_id, max_rate_minor) VALUES ($1, $2)', [clientId, 15]],
    [
      'INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, now())',
      [clientId, 1, 'signup_credit', 1000, 1000, 'system'],
    ],
    ['INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq) VALUES ($1, $2, $3)', [clientId, externalRef, 1]],
    ['INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, $3)', [instanceId, clientId, `${slug}-instance`]],
    ['INSERT INTO instance_lease_state (instance_id, client_id) VALUES ($1, $2)', [instanceId, clientId]],
    [
      `INSERT INTO campaigns (id, client_id, status, instance_id, name, audience, message)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb)`,
      [campaignId, clientId, 'draft', instanceId, `Isolation Suite A Campaign ${label}`],
    ],
    [
      'INSERT INTO message_jobs (client_id, instance_id, recipient_jid, recipient_e164, payload, payload_kind, priority, priority_rank, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [clientId, instanceId, '15550000000@s.whatsapp.net', '+15550000000', JSON.stringify({ text: 'isolation-probe' }), 'text', 'normal', 10, 'queued'],
    ],
    [
      'INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at) VALUES ($1, $2, $3, $4, now())',
      [randomInt(1, 2147483647), 'debit_send', clientId, 1],
    ],
    [
      'INSERT INTO wallet_daily_summary (client_id, day, instance_id) VALUES ($1, current_date, $2)',
      [clientId, instanceId],
    ],
    [
      "INSERT INTO wallet_reconcile_findings (client_id, kind, detail) VALUES ($1, 'probe', '{}'::jsonb)",
      [clientId],
    ],
    [
      `INSERT INTO topup_requests (client_id, amount_minor, method, external_ref, status)
         VALUES ($1, $2, 'upi', $3, 'pending')`,
      [clientId, 10000, `${externalRef}-topup`],
    ],
    [
      `INSERT INTO wa_groups (client_id, instance_id, group_jid)
         VALUES ($1, $2, $3)`,
      [clientId, instanceId, `${suffix}00000000000001@g.us`],
    ],
  ];
  for (const [sql, params] of inserts) {
    await pool.query(sql, params);
  }
  const contactIds = await seedContactsTenant(pool, { clientId, suffix, name });
  await seedBroadcastsTenant(pool, {
    clientId,
    campaignId,
    contactId: contactIds.contactId,
    suffix,
  });
  return { label, userId, clientId, instanceId, externalRef, ...contactIds };
}

// Reverse-FK-order cleanup; tolerant of a partially-seeded tenant (undefined = no-op).
export async function cleanupTenant(
  pool: pg.Pool,
  tenant: SeededTenant | undefined,
): Promise<void> {
  if (!tenant) return;
  // prettier-ignore
  const tenantScoped = ['wa_groups', 'consent_records', 'contact_import_errors', 'contact_imports', 'contact_tag_links', 'contact_tags', 'campaign_counters', 'campaign_recipients', 'contacts', 'topup_requests', 'wallet_reconcile_findings', 'wallet_daily_summary', 'wallet_charge_guards', 'message_jobs', 'campaigns', 'instance_lease_state', 'whatsapp_instances', 'wallet_ledger_ext_refs', 'wallet_ledger', 'wallet_accounts', 'client_pricing', 'memberships'];
  for (const table of tenantScoped) {
    await pool.query(`DELETE FROM ${table} WHERE client_id = $1`, [tenant.clientId]);
  }
  await pool.query('DELETE FROM clients WHERE id = $1', [tenant.clientId]);
  await pool.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
}

// [table, id column, innocuous column to no-op UPDATE] - all key on client_id except clients (id).
// prettier-ignore
export const PROBE_SPECS: Array<[string, string, string]> = [
  ['clients', 'id', 'company_name'],
  ['memberships', 'client_id', 'role'],
  ['client_pricing', 'client_id', 'updated_at'],
  ['wallet_accounts', 'client_id', 'updated_at'],
  ['wallet_ledger', 'client_id', 'reason'],
  ['wallet_ledger_ext_refs', 'client_id', 'seq'],
  ['message_jobs', 'client_id', 'status'],
  ['whatsapp_instances', 'client_id', 'label'],
  ['campaigns', 'client_id', 'status'],
  ['instance_lease_state', 'client_id', 'owner_worker_id'],
  ['wallet_charge_guards', 'client_id', 'ledger_seq'],
  ['wallet_daily_summary', 'client_id', 'sent_count'],
  ['wallet_reconcile_findings', 'client_id', 'corrected_at'],
  ['topup_requests', 'client_id', 'review_reason'],
  ['contacts', 'client_id', 'display_name'],
  ['contact_tags', 'client_id', 'color'],
  ['contact_tag_links', 'client_id', 'added_at'],
  ['contact_imports', 'client_id', 'filename'],
  ['contact_import_errors', 'client_id', 'reason'],
  ['consent_records', 'client_id', 'source_note'],
  ['campaign_recipients', 'client_id', 'status'],
  ['campaign_counters', 'client_id', 'total'],
  ['wa_groups', 'client_id', 'subject'],
];
