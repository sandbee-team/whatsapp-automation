import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  CROSS_TENANT_QUERIES,
  type CrossTenantQueryEntry,
} from './registries/cross-tenant-queries.js';
import { stripComments, literalSpans } from './guards/tenant-scope-spans.js';

/**
 * check-tenant-scope.ts (P00 step 6) - the tenant-isolation scanner (core
 * invariant 4). Flags a query against a table in `TENANT_TABLES` that has no
 * `client_id` predicate in the same SQL statement, UNLESS the enclosing
 * exported symbol has a complete exemption entry in `CROSS_TENANT_QUERIES`.
 *
 * `TENANT_TABLES` is a literal mirror of `db/src/isolation/tenant-tables.ts`'s
 * `TENANT_TABLE_COVERAGE` keys, NOT a live cross-project import (`scripts/
 * tsconfig.json` has no project reference to `db`) - kept in sync by
 * construction via `db/src/isolation/tenant-tables.test.ts`'s own equality
 * test. Update by hand alongside `TENANT_TABLE_COVERAGE`; drift fails loudly.
 *
 * Heuristic: a statement-level scan over string/template literals containing
 * a SQL keyword next to a tenant table name.
 */
export const TENANT_TABLES: string[] = [
  'clients',
  'memberships',
  'client_pricing',
  'wallet_accounts',
  'wallet_ledger',
  'wallet_ledger_ext_refs',
  'message_jobs',
  'message_job_refs',
  'message_wa_ids',
  'delivery_event_ids',
  'send_attempts',
  'delivery_events',
  'whatsapp_instances',
  'instance_lease_state',
  'campaigns',
  'whatsapp_session_credentials',
  'whatsapp_session_keys',
  'unresolved_action_keys',
  // P13 (pacing-ledger-and-warmup) U1, migration 0030. `pacing_profiles` and
  // `pacing_warmup_tiers` are deliberately absent: they are global platform
  // catalogs with no `client_id` (same class as `plans`/`plan_limits`) and are
  // registered in `ISOLATION_NON_TENANT_TABLES` instead.
  'instance_pacing_state',
  'pacing_ledger',
  'client_daily_usage',
  'pacing_events',
  'instance_pacing_overrides',
  'client_limit_overrides',
  // P14 (safe-mode-guards) U1, migration 0036.
  'opt_outs',
  'optout_confirmations',
  'tenant_optout_keywords',
  'tenant_blocked_words',
  'content_fingerprints',
  'content_fingerprint_recipients',
  'recipient_send_buckets',
  'instance_recipient_contacts',
  // P15 (outbox-relay-and-webhooks) Unit U1, migration 0041.
  'outbox_events',
  'webhook_endpoints',
  'webhook_deliveries',
  'instance_health_samples', // P16 (health-signals-and-pause) Unit A, migration 0044.
  // P17 (notifications-and-instance-card) Unit U1, migration 0048.
  'notifications',
  // P18 (wallet-ledger-and-pricing) U1, migration 0051.
  'wallet_charge_guards',
  'wallet_daily_summary',
  'wallet_reconcile_findings',
  // P19 (topup-and-staff-audit) U1, migration 0058.
  'topup_requests',
  // P20 (contacts-and-import) Unit U1, migration 0060.
  'contacts',
  'contact_tags',
  'contact_tag_links',
  'contact_imports',
  'contact_import_errors',
  'consent_records',
  // P21 (inbound-listener-receipts-and-optout) Unit U1, migration 0063.
  'inbound_dead_letters',
  'campaign_recipients', // P23 (broadcast-campaigns) Unit U1, migration 0064.
  'campaign_counters',
  // P24 (groups-messaging) Unit U1, migration 0066.
  'wa_groups',
  // P28 (admin-internal-api-and-panel) Unit U1, migration 0070.
  'impersonation_grants',
  'api_keys', // Go-live session, Unit U1, migration 0076.
  'media_assets', // P34 U-upload (ADR 0052 accepted scope), migration 0077.
];

/** The five ADR 0014 source trees' TS, plus raw SQL query files. */
export const TENANT_SCOPE_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'website/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'db/src/**/*.{ts,tsx}',
  'db/queries/**/*.sql',
];

export interface TenantScopeViolation {
  file: string;
  symbol: string;
  message: string;
}

interface SourceFile {
  path: string;
  content: string;
}

const CLIENT_ID_PREDICATE = /client_id\s*=|client_id\s+IN|\.clientId\b/i;
const SYMBOL_PATTERN = /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g;
// `-- name: <label>` marker convention used by db/queries/*.sql (see
// db/queries/ensure-partitions.sql) - the .sql equivalent of an exported
// symbol name, since raw SQL has no `export const|function`.
const SQL_NAME_MARKER_PATTERN = /--\s*name:\s*(\S+)/g;

function tableReferencePattern(table: string): RegExp {
  return new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i');
}
// stripComments/literalSpans (comment-stripping + literal-span helpers) live
// in guards/tenant-scope-spans.ts (split out at FIX-P09-B for the max-lines
// cap) - imported above, re-used unchanged here.
/** Nearest preceding `export const|function <name>` above `index`, or module scope. */
function enclosingSymbol(content: string, index: number): string {
  const before = content.slice(0, index);
  let symbol = '(module scope)';
  let match: RegExpExecArray | null;
  SYMBOL_PATTERN.lastIndex = 0;
  while ((match = SYMBOL_PATTERN.exec(before)) !== null) {
    symbol = match[1] ?? match[2] ?? symbol;
  }
  return symbol;
}

/**
 * Statement-block spans for a raw `.sql` file. `literalSpans` (below) only
 * finds text inside quoted string/template literals, which is the right
 * shape for SQL embedded in TS source (`` `SELECT * FROM message_jobs...` ``)
 * but WRONG for a `db/queries/*.sql` file: there, `FROM`/`JOIN`/table names
 * are bare SQL text, never inside a quote, so `literalSpans` finds nothing
 * and the whole file goes unscanned (a silent blind spot, not a real pass).
 * A `.sql` file is split on its `-- name: <label>` markers (the convention
 * `db/queries/ensure-partitions.sql` already uses) into one span per named
 * statement, each carrying its own symbol for `CROSS_TENANT_QUERIES` keying;
 * a file with no markers is treated as one `(module scope)` span.
 */
function sqlStatementSpans(
  content: string,
): Array<{ index: number; text: string; symbol: string }> {
  const markers: Array<{ index: number; name: string }> = [];
  const pattern = new RegExp(SQL_NAME_MARKER_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    markers.push({ index: match.index, name: match[1] ?? '(unnamed)' });
  }
  if (markers.length === 0) {
    return [{ index: 0, text: content, symbol: '(module scope)' }];
  }
  return markers.map((marker, i) => ({
    index: marker.index,
    text: content.slice(marker.index, markers[i + 1]?.index ?? content.length),
    symbol: marker.name,
  }));
}

function missingFields(entry: CrossTenantQueryEntry): string[] {
  const missing: string[] = [];
  if (!entry.role.trim()) missing.push('role');
  if (!entry.reason.trim()) missing.push('reason');
  if (entry.projectedColumns.length === 0) missing.push('projectedColumns');
  return missing;
}
/**
 * Pure scan: `files` are already-read source texts, `tenantTables` is
 * normally `TENANT_TABLES`, `registry` is normally `CROSS_TENANT_QUERIES`.
 * No filesystem access here - the CLI/guard wrap this with real reads.
 */
export function scanTenantScope(
  files: SourceFile[],
  tenantTables: string[],
  registry: Record<string, CrossTenantQueryEntry>,
): TenantScopeViolation[] {
  const violations: TenantScopeViolation[] = [];
  if (tenantTables.length === 0) {
    return violations;
  }

  for (const file of files) {
    // Raw .sql files carry SQL as bare text, not inside quoted literals - see
    // sqlStatementSpans' doc comment for why literalSpans is the wrong tool there.
    // `.sql` files use `--` comments, which are already outside literalSpans'
    // concern entirely, so stripComments (a TS `//`/`/* */` stripper) is
    // deliberately NOT applied there.
    const spans: Array<{ index: number; text: string; symbol?: string }> = file.path.endsWith(
      '.sql',
    )
      ? sqlStatementSpans(file.content)
      : [...literalSpans(stripComments(file.content))];

    for (const span of spans) {
      const matchedTable = tenantTables.find((table) =>
        tableReferencePattern(table).test(span.text),
      );
      if (!matchedTable) continue;
      if (CLIENT_ID_PREDICATE.test(span.text)) continue;

      const symbol = span.symbol ?? enclosingSymbol(file.content, span.index);
      const key = `${file.path}:${symbol}`;
      const entry = registry[key];

      if (entry) {
        const missing = missingFields(entry);
        if (missing.length === 0) continue;
        violations.push({
          file: file.path,
          symbol,
          message: `CROSS_TENANT_QUERIES["${key}"] is missing ${missing.join(', ')}`,
        });
        continue;
      }

      violations.push({
        file: file.path,
        symbol,
        message: `query against tenant table "${matchedTable}" in ${key} has no client_id predicate and no CROSS_TENANT_QUERIES entry`,
      });
    }
  }

  return violations;
}

// Test fixtures legitimately seed cross-tenant data (two-tenant isolation
// proofs); core invariant 4 targets runtime queries, not test setup SQL.
// Runtime code stays fully scanned - only test files are excluded here, and
// only for this guard (resolveFiles' own CONTENT_EXCLUSIONS/ARTIFACT_EXCLUSIONS
// stay untouched so every other guard's scan set is unaffected).
//
// P03: same path-shape convention (a `tests?`/`__tests__` dir segment, or a
// `.test.ts(x)`/`.spec.ts(x)` suffix) that keeps `isolation-suite-a.test.ts`
// and siblings out of this scan for files under a scanned `src/` tree, e.g.
// `app/backend/src/modules/queue/claim.integration.test.ts`. Exported so
// `check-tenant-scope.test.ts` can assert this is exactly that convention -
// never a bespoke carve-out - and that it never exempts application code.
export const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.tsx?$/;

function readSourceFiles(): SourceFile[] {
  return resolveFiles(TENANT_SCOPE_GLOBS)
    .filter((relativePath) => !TEST_FILE_PATTERN.test(relativePath))
    .map((relativePath) => ({
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    }));
}

export function runCheckTenantScope(): GuardResult {
  const files = readSourceFiles();
  const violations: GuardViolation[] = scanTenantScope(
    files,
    TENANT_TABLES,
    CROSS_TENANT_QUERIES,
  ).map((violation) => ({ file: violation.file, message: violation.message }));
  return { violations };
}

function main(): void {
  const files = readSourceFiles();

  if (TENANT_TABLES.length === 0) {
    console.log(
      `tenant-scope: ${files.length} files scanned, TENANT_TABLES empty — activates fully in P02`,
    );
    return;
  }

  const violations = scanTenantScope(files, TENANT_TABLES, CROSS_TENANT_QUERIES);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`tenant-scope: ${violation.file} (${violation.symbol}) - ${violation.message}`);
    }
    process.exit(1);
  }
  console.log(`tenant-scope: ${files.length} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
