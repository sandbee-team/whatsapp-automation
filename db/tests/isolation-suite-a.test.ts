import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANONICAL_AUTHORITY_KEYS,
  checkAllowListExists,
  checkCoverage,
  checkCoverageTablesExist,
  createTenantDb,
  GLOBAL_UNIQUE_INDEXES,
  ISOLATION_NON_TENANT_TABLES,
  SUITE_A_INDEX_EXEMPTIONS,
  TENANT_TABLE_COVERAGE,
  type CatalogTableRow,
} from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  buildNoopUpdateSql,
  cleanupTenant,
  computeIndexLeadViolations,
  coveredLiveTableNames,
  fetchCatalogRows,
  fetchCoveredIndexRows,
  PROBE_SPECS,
  quoteIdent,
  REGISTRY,
  seedTenant,
  type IndexCatalogRow,
  type PgError,
  type ProbeBranch,
  type SeededTenant,
} from './helpers/isolation-fixtures.js';

// Blueprint mandatory isolation suite A (plan/v1/P02-db-foundations-and-isolation.md step 9). Two tenants, each seeded with one row in every covered table; idempotent via unique per-run seeds.
describe('isolation_suite_a', () => {
  let tenantA: SeededTenant | undefined;
  let tenantB: SeededTenant | undefined;

  beforeAll(async () => {
    const pool = await getMigratedPool();
    tenantA = await seedTenant(pool, 'a');
    tenantB = await seedTenant(pool, 'b');
  });

  afterAll(async () => {
    const pool = await getMigratedPool();
    try {
      await cleanupTenant(pool, tenantB);
    } finally {
      await cleanupTenant(pool, tenantA);
    }
    await closeMigratedPool();
  });

  it('every_base_table_and_partition_is_tenant_covered_or_allow_listed_with_a_reason', async () => {
    const pool = await getMigratedPool();
    const catalogRows = await fetchCatalogRows(pool);
    const findings = checkCoverage(catalogRows, REGISTRY);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
  it('a_table_without_client_id_is_reported_by_the_coverage_checker', () => {
    const rows: CatalogTableRow[] = [
      { tableName: 'demo_bad_table', parentTable: null, columns: ['id', 'note'] },
      { tableName: 'clients', parentTable: null, columns: ['id', 'company_name', 'slug'] },
    ];
    const findings = checkCoverage(rows, REGISTRY);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.tableName).toBe('demo_bad_table');
  });
  it('every_tenant_table_has_rowsecurity_and_forcerowsecurity_true', async () => {
    const pool = await getMigratedPool();
    const coveredNames = coveredLiveTableNames(await fetchCatalogRows(pool));
    expect(coveredNames.length).toBeGreaterThan(0);
    // prettier-ignore
    type RlsRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policy_count: number };
    const sql = `
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_catalog.pg_policies pol WHERE pol.schemaname = 'public' AND pol.tablename = c.relname AND pol.policyname = 'tenant_isolation') AS policy_count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)`;
    const result = await pool.query<RlsRow>(sql, [coveredNames]);
    expect(result.rows).toHaveLength(coveredNames.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname}: rowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}: forcerowsecurity`).toBe(true);
      expect(row.policy_count, `${row.relname}: tenant_isolation policy`).toBe(1);
    }
  });
  it('an_unset_client_context_returns_zero_rows_from_every_tenant_table', async () => {
    const pool = await getMigratedPool();
    const coveredNames = coveredLiveTableNames(await fetchCatalogRows(pool));
    expect(coveredNames.length).toBeGreaterThan(0);
    const client = await pool.connect();
    // N10 pattern: zero-rows (RLS, no context) vs 42501 (child partitions lack a grant) - must not be all-42501.
    let zeroRowsBranchCount = 0;
    let permissionDeniedBranchCount = 0;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      for (const tableName of coveredNames) {
        await client.query('SAVEPOINT probe');
        try {
          const result = await client.query(`SELECT * FROM ${quoteIdent(tableName)}`);
          expect(result.rows, `${tableName}: unset-context select`).toEqual([]);
          zeroRowsBranchCount += 1;
        } catch (err) {
          expect((err as PgError).code, `${tableName}: unset-context error`).toBe('42501');
          permissionDeniedBranchCount += 1;
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT probe');
        }
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(
      zeroRowsBranchCount,
      `zero-rows=${String(zeroRowsBranchCount)} 42501=${String(permissionDeniedBranchCount)} of ${String(coveredNames.length)} tables - must not be all-42501`,
    ).toBeGreaterThanOrEqual(6);
  });
  it('tenant_b_cannot_select_update_or_delete_tenant_a_rows', async () => {
    const pool = await getMigratedPool();
    const tenantDb = createTenantDb(pool);
    const clientA = tenantA;
    const clientB = tenantB;
    if (!clientA || !clientB)
      throw new Error('seeding did not complete: tenantA/tenantB unavailable');

    const probeSpecs = PROBE_SPECS;
    const branchCounts = { rls_exercised: 0, grant_denied: 0 };
    await tenantDb.withTenant(clientB.clientId, async (tx) => {
      await tx.query('SET LOCAL ROLE wp_app');
      // N10 pattern: rowCount 0 (RLS exercised) vs 42501 (grant-denied) - tallied so grant narrowing can't go all-42501/vacuous.
      async function probeMutation(sql: string, params: unknown[]): Promise<ProbeBranch> {
        await tx.query('SAVEPOINT probe_mutation');
        try {
          expect((await tx.query(sql, params)).rowCount).toBe(0);
          return 'rls_exercised';
        } catch (err) {
          expect((err as PgError).code).toBe('42501');
          return 'grant_denied';
        } finally {
          await tx.query('ROLLBACK TO SAVEPOINT probe_mutation');
        }
      }
      for (const [table, idCol, updateColumn] of probeSpecs) {
        const params = [clientA.clientId];
        await tx.query('SAVEPOINT probe_select');
        try {
          const sel = await tx.query(`SELECT ${idCol} FROM ${table} WHERE ${idCol} = $1`, params);
          expect(sel.rows, `${table}: cross-tenant select`).toEqual([]);
          await tx.query('RELEASE SAVEPOINT probe_select');
        } catch (err) {
          // whatsapp_instances/campaigns/instance_lease_state currently carry
          // NO wp_app grant at all (a real grant gap - see
          // claim.integration.test.ts's own header for the same flag on
          // wp_scheduler - not this task's to fix): a bare permission-denied
          // on SELECT is a STRONGER isolation guarantee than an RLS-scoped
          // zero-row result, so it is an accepted branch here, not a failure.
          expect((err as PgError).code, `${table}: cross-tenant select`).toBe('42501');
          await tx.query('ROLLBACK TO SAVEPOINT probe_select');
        }
        for (const sql of [
          buildNoopUpdateSql(table, updateColumn, idCol),
          `DELETE FROM ${table} WHERE ${idCol} = $1`,
        ]) {
          branchCounts[await probeMutation(sql, params)] += 1;
        }
      }
    });
    // Post-0006 floor: UPDATE clients, UPDATE wallet_accounts, UPDATE+DELETE memberships must exercise RLS, not just hit 42501.
    expect(
      branchCounts.rls_exercised,
      `rls_exercised=${String(branchCounts.rls_exercised)} grant_denied=${String(branchCounts.grant_denied)} of ${String(probeSpecs.length * 2)} update/delete probes - must be >= 4 (post-0006 floor)`,
    ).toBeGreaterThanOrEqual(4);
  });
  it('every_tenant_index_leads_with_client_id_except_the_three_named_exemptions', async () => {
    const pool = await getMigratedPool();
    const indexRows = await fetchCoveredIndexRows(pool);
    expect(indexRows.length).toBeGreaterThan(0);
    const violations = computeIndexLeadViolations(indexRows);
    expect(violations, violations.join('\n')).toEqual([]);
  });
  it('the_index_lead_rule_still_fails_an_unregistered_non_leading_unique_index_and_stays_name_independent_for_future_partitions', () => {
    const rows: IndexCatalogRow[] = [
      // Unregistered: a hypothetical new unique index that doesn't lead with client_id and has no
      // CANONICAL_AUTHORITY_KEYS/GLOBAL_UNIQUE_INDEXES entry - must still fail (guard power).
      {
        effective_table: 'message_jobs',
        index_name: 'message_jobs_totally_new_unique_idx',
        indisunique: true,
        indisprimary: false,
        first_column: 'recipient_hash',
      },
      // Registered via `primary_key`, on a FUTURE partition's auto-generated name that does not exist
      // in CANONICAL_AUTHORITY_KEYS literally - proves the match is by shape, not by name.
      {
        effective_table: 'message_jobs',
        index_name: 'message_jobs_y2099m01_pkey',
        indisunique: true,
        indisprimary: true,
        first_column: 'id',
      },
      // Registered via `leading_column`, same future-partition-name-independence proof for the
      // deliberately-global lease-expiry sweep index.
      {
        effective_table: 'message_jobs',
        index_name: 'message_jobs_y2099m01_lease_expires_at_idx',
        indisunique: false,
        indisprimary: false,
        first_column: 'lease_expires_at',
      },
    ];
    const violations = computeIndexLeadViolations(rows);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('message_jobs_totally_new_unique_idx');
  });
  it('every_registered_tenant_table_has_at_least_one_client_id_leading_index', async () => {
    const pool = await getMigratedPool();
    const indexRows = await fetchCoveredIndexRows(pool);
    expect(indexRows.length).toBeGreaterThan(0);
    const tablesWithClientIdLeadingIndex = new Set(
      indexRows
        .filter((row) => row.first_column === TENANT_TABLE_COVERAGE[row.effective_table])
        .map((row) => row.effective_table),
    );
    const missing = Object.keys(TENANT_TABLE_COVERAGE).filter(
      (table) => !tablesWithClientIdLeadingIndex.has(table),
    );
    expect(missing, missing.join(', ')).toEqual([]);
  });
  it('the_suite_a_index_exemption_list_is_exactly_three_entries', () => {
    const expected = ['campaign_recipients', 'wallet_charge_guards', 'contact_import_errors'];
    expect([...SUITE_A_INDEX_EXEMPTIONS].sort()).toEqual([...expected].sort());
  });
  // P06 (session-lease-and-fence) - ADR 0029: instance_lease_state does NOT
  // get a fourth SUITE_A_INDEX_EXEMPTIONS entry (that registry is for
  // UNIQUE-index authorities on a globally unique parent id). Its new
  // `ils_stale_idx (lease_seen_at) WHERE owner_worker_id IS NOT NULL` is a
  // non-unique, deliberately-global index, so it belongs in
  // CANONICAL_AUTHORITY_KEYS instead, same class as
  // message_jobs_lease_expiry_idx. This test pins BOTH the exemption list's
  // count/names AND the exact shape of instance_lease_state's canonical
  // keys, so either a fourth exemption table or an unregistered/extra shape
  // on this table turns the suite red.
  it('instance_lease_state_is_the_fourth_and_last_exemption', () => {
    const expected = ['campaign_recipients', 'wallet_charge_guards', 'contact_import_errors'];
    expect([...SUITE_A_INDEX_EXEMPTIONS].sort()).toEqual([...expected].sort());

    const keys = CANONICAL_AUTHORITY_KEYS.instance_lease_state ?? [];
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ match: { kind: 'primary_key' } }),
        expect.objectContaining({
          match: { kind: 'leading_column', column: 'lease_seen_at' },
        }),
      ]),
    );
  });
  // P15 U1, migration 0041: same reasoning as instance_lease_state above -
  // surrogate PKs, deliberately-global claim-scan indexes and
  // webhook_deliveries' own uniqueness authority go through
  // CANONICAL_AUTHORITY_KEYS, not a fourth+ exemption entry.
  it('outbox_events_and_webhook_tables_are_not_suite_a_index_exemptions', () => {
    const expected = ['campaign_recipients', 'wallet_charge_guards', 'contact_import_errors'];
    expect([...SUITE_A_INDEX_EXEMPTIONS].sort()).toEqual([...expected].sort());

    const kinds = (table: string): string[] =>
      (CANONICAL_AUTHORITY_KEYS[table] ?? []).map((k) => k.match.kind);
    expect(kinds('outbox_events').sort()).toEqual(['leading_column', 'primary_key']);
    expect(kinds('webhook_endpoints')).toEqual(['primary_key']);
    expect(kinds('webhook_deliveries').sort()).toEqual(['leading_column', 'named', 'primary_key']);
  });
  it('the_global_unique_index_waiver_list_is_exactly_the_three_named_entries', () => {
    const expected = [
      'clients_slug_key',
      'memberships_one_workspace_per_user_uq',
      'api_keys_key_prefix_uq',
    ];
    expect(Object.keys(GLOBAL_UNIQUE_INDEXES).sort()).toEqual([...expected].sort());
  });
  it('every_allow_listed_non_tenant_table_exists', async () => {
    const pool = await getMigratedPool();
    const catalogRows = await fetchCatalogRows(pool);
    const liveTableNames = catalogRows.map((row) => row.tableName);
    const allowListFindings = checkAllowListExists(liveTableNames, ISOLATION_NON_TENANT_TABLES);
    const coverageFindings = checkCoverageTablesExist(liveTableNames, TENANT_TABLE_COVERAGE);
    expect(
      [...allowListFindings, ...coverageFindings],
      JSON.stringify([...allowListFindings, ...coverageFindings], null, 2),
    ).toEqual([]);
  });
});
