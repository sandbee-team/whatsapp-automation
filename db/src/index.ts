/**
 * @wp/db - the single database definition shared by app/backend and
 * admin/backend: schema, migrations, createTenantDb() factory, pool, and the
 * migration runner. Owns zero business rules and exports no un-scoped query
 * helper for a tenant table. Real schema/migrations land from P02.
 */
export const packageName = '@wp/db' as const;

export { createPool, type CreatePoolOptions } from './pool.js';
export {
  runMigrations,
  MigrationFileError,
  MigrationChecksumMismatchError,
  MigrationOrderError,
  type RunMigrationsOptions,
  type AppliedMigration,
  type RunMigrationsResult,
} from './migrate.js';
export { EXPECTED_SCHEMA_VERSION } from './schema-version.js';
export {
  createTenantDb,
  createWorkerDb,
  InvalidTenantIdError,
  type TenantDb,
  type TenantQueryable,
  type WorkerDb,
  type WorkerQueryable,
} from './tenant-db.js';
export {
  TENANT_TABLE_COVERAGE,
  ISOLATION_NON_TENANT_TABLES,
  SUITE_A_INDEX_EXEMPTIONS,
  GLOBAL_UNIQUE_INDEXES,
  SEND_PATH_TABLES,
  CANONICAL_AUTHORITY_KEYS,
  type CanonicalAuthorityKey,
  type CanonicalAuthorityMatch,
} from './isolation/tenant-tables.js';
export {
  checkCoverage,
  checkAllowListExists,
  checkCoverageTablesExist,
  type CatalogTableRow,
  type CoverageRegistry,
  type CoverageFinding,
} from './isolation/coverage.js';
export {
  ensureAllPartitions,
  MONTHLY_PARTITIONED_TABLES,
  WEEKLY_PARTITIONED_TABLES,
  type EnsurePartitionsOptions,
} from './partitions.js';
export {
  bindQueryParams,
  convertNamedParams,
  loadNamedQuery,
  loadQuery,
  splitNamedSections,
  type LoadedSqlQuery,
} from './queries.js';
export { RETENTION_POLICIES, type RetentionPolicy } from './retention.js';
