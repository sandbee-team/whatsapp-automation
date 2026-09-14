/**
 * P02 step 8 - the pure tenant-table coverage checker. No DB connection, no
 * filesystem access: callers (the live isolation suite A in step 9, and this
 * package's own unit tests) supply already-fetched catalog rows and the
 * registry to check them against.
 */

export interface CatalogTableRow {
  tableName: string;
  /** Parent table name if this row is a partition child, else null. */
  parentTable: string | null;
  columns: readonly string[];
}

export interface CoverageRegistry {
  coverage: Readonly<Record<string, string>>;
  nonTenant: Readonly<Record<string, string>>;
}

export interface CoverageFinding {
  tableName: string;
  problem: string;
}

/**
 * Checks every catalog row against the registry. Partition children resolve
 * to their parent's classification first (rule 1) - the effective table is
 * what every subsequent rule checks.
 */
export function checkCoverage(
  catalogRows: readonly CatalogTableRow[],
  registry: CoverageRegistry,
): CoverageFinding[] {
  const findings: CoverageFinding[] = [];

  for (const row of catalogRows) {
    const effectiveTable = row.parentTable ?? row.tableName;
    const inCoverage = Object.prototype.hasOwnProperty.call(registry.coverage, effectiveTable);
    const inNonTenant = Object.prototype.hasOwnProperty.call(registry.nonTenant, effectiveTable);

    if (!inCoverage && !inNonTenant) {
      findings.push({
        tableName: row.tableName,
        problem: `table "${effectiveTable}" is not covered and not allow-listed`,
      });
      continue;
    }

    if (inCoverage && inNonTenant) {
      findings.push({
        tableName: row.tableName,
        problem: `table "${effectiveTable}" is registered as BOTH a tenant table and a non-tenant allow-list entry`,
      });
      continue;
    }

    if (inCoverage) {
      const tenantKeyColumn = registry.coverage[effectiveTable];
      if (tenantKeyColumn !== undefined && !row.columns.includes(tenantKeyColumn)) {
        findings.push({
          tableName: row.tableName,
          problem: `table "${effectiveTable}" is registered with tenant-key column "${tenantKeyColumn}", but that column is not present`,
        });
      }
      continue;
    }

    // inNonTenant
    const reason = registry.nonTenant[effectiveTable];
    if (reason === undefined || reason.trim().length === 0) {
      findings.push({
        tableName: row.tableName,
        problem: `non-tenant allow-list entry for "${effectiveTable}" has an empty/whitespace reason`,
      });
    }
  }

  return findings;
}

/**
 * A non-tenant allow-list entry naming a table that does not exist in the
 * live catalog is a stale allow-list, hence a red build.
 */
export function checkAllowListExists(
  existingTables: readonly string[],
  nonTenant: Readonly<Record<string, string>>,
): CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  const existing = new Set(existingTables);

  for (const tableName of Object.keys(nonTenant)) {
    if (!existing.has(tableName)) {
      findings.push({
        tableName,
        problem: `allow-list entry "${tableName}" does not exist in the live catalog`,
      });
    }
  }

  return findings;
}

/**
 * A `TENANT_TABLE_COVERAGE` entry naming a table that does not exist in the
 * live catalog is a stale coverage entry - mirrors `checkAllowListExists`,
 * but for the tenant-table registry instead of the non-tenant allow-list.
 * Both lists must be live: an entry that once existed and was later dropped
 * (or renamed) without updating the registry is a silent coverage gap.
 */
export function checkCoverageTablesExist(
  existingTables: readonly string[],
  coverage: Readonly<Record<string, string>>,
): CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  const existing = new Set(existingTables);

  for (const tableName of Object.keys(coverage)) {
    if (!existing.has(tableName)) {
      findings.push({
        tableName,
        problem: `coverage entry "${tableName}" does not exist in the live catalog`,
      });
    }
  }

  return findings;
}
