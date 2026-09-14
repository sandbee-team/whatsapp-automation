import { afterAll, describe, expect, it } from 'vitest';
import { getMigratedPool, closeMigratedPool } from './helpers/migrated-db.js';
import {
  fetchExistingTables,
  fetchLiveColumnGrantsForTables,
  fetchLiveGrantsForTables,
  fetchPartitionChildren,
} from './helpers/grants.js';
import { fetchCanonicalColumnGrants } from './helpers/grants-canonical.js';

/**
 * P28 (admin-internal-api-and-panel) Unit U1 - the phase gate. Split out of
 * `grants-snapshot.test.ts` (that file plus `isolation-suite-a.test.ts` sit
 * at/near the 300-line cap) so this phase's own write-surface pin lives in
 * its own file, same split idiom as `grants-snapshot-p08-instances.test.ts`.
 *
 * `wp_admin_app` must never gain an INSERT/UPDATE/DELETE/TRUNCATE grant on
 * any send-path table (core invariant 6 / safety-compliance: no staff-side
 * bypass of the fail-safe pause), and its entire write surface across the
 * whole schema must equal exactly the pinned set below.
 */

// `messages` does not exist in v1 (no inbox/chat message-body table has
// landed yet) - included in the list per this phase's own instruction, but
// the existence assertion below only requires 8 of the 9 to be present so a
// typo in this list cannot make the "zero write grants" assertion vacuous.
const SEND_PATH_CANDIDATE_TABLES = [
  'message_jobs',
  'send_attempts',
  'delivery_events',
  'whatsapp_instances',
  'pacing_ledger',
  'wallet_ledger',
  'wallet_charge_guards',
  'messages',
  'campaign_recipients',
] as const;

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

async function allTablesIncludingPartitions(
  pool: Awaited<ReturnType<typeof getMigratedPool>>,
  tableNames: readonly string[],
): Promise<string[]> {
  const childLists = await Promise.all(
    tableNames.map((tableName) => fetchPartitionChildren(pool, tableName)),
  );
  return [...tableNames, ...childLists.flat()];
}

describe('grants_snapshot_p28_admin_role', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('wp_admin_app_cannot_write_any_send_path_table', async () => {
    const pool = await getMigratedPool();

    const existing = await fetchExistingTables(pool, SEND_PATH_CANDIDATE_TABLES);
    expect(
      existing.length,
      `only ${String(existing.length)} of ${String(SEND_PATH_CANDIDATE_TABLES.length)} candidate send-path tables exist - list may be stale`,
    ).toBeGreaterThanOrEqual(8);

    const allTables = await allTablesIncludingPartitions(pool, existing);

    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', allTables);
    const columnGrants = await fetchLiveColumnGrantsForTables(pool, 'wp_admin_app', allTables);

    const writeTableGrants = tableGrants.filter((row) =>
      WRITE_PRIVILEGES.includes(row.privilege_type),
    );
    const writeColumnGrants = columnGrants.filter((row) =>
      WRITE_PRIVILEGES.includes(row.privilege_type),
    );

    expect(writeTableGrants, JSON.stringify(writeTableGrants, null, 2)).toEqual([]);
    expect(writeColumnGrants, JSON.stringify(writeColumnGrants, null, 2)).toEqual([]);
  });

  it('wp_admin_app_has_no_grant_on_wallet_ledger_writes', async () => {
    const pool = await getMigratedPool();
    const tables = ['wallet_ledger', 'wallet_ledger_ext_refs'];
    const existing = await fetchExistingTables(pool, tables);
    expect(existing.sort()).toEqual([...tables].sort());

    const allTables = await allTablesIncludingPartitions(pool, existing);

    const tableGrants = await fetchLiveGrantsForTables(pool, 'wp_admin_app', allTables);
    const columnGrants = await fetchLiveColumnGrantsForTables(pool, 'wp_admin_app', allTables);

    const writeTableGrants = tableGrants.filter((row) =>
      WRITE_PRIVILEGES.includes(row.privilege_type),
    );
    const writeColumnGrants = columnGrants.filter((row) =>
      WRITE_PRIVILEGES.includes(row.privilege_type),
    );

    expect(writeTableGrants, JSON.stringify(writeTableGrants, null, 2)).toEqual([]);
    expect(writeColumnGrants, JSON.stringify(writeColumnGrants, null, 2)).toEqual([]);
  });

  it('wp_admin_app_write_surface_is_exactly_the_pinned_set', async () => {
    const pool = await getMigratedPool();
    const columnGrants = await fetchCanonicalColumnGrants(pool);

    const writeRows = columnGrants.filter(
      (row) => row.grantee === 'wp_admin_app' && WRITE_PRIVILEGES.includes(row.privilege_type),
    );

    const actualPairs = writeRows.map((row) => `${row.table_name}:${row.privilege_type}`).sort();

    const expectedPairs = [
      'staff_users:INSERT',
      'staff_users:UPDATE',
      'staff_sessions:INSERT',
      'staff_sessions:UPDATE',
      'audit_logs:INSERT',
      'topup_requests:UPDATE',
      // P29 step 5 (blueprint R-52): the public lead endpoint writes the marketing lead row.
      'leads:INSERT',
    ].sort();

    expect(actualPairs).toEqual(expectedPairs);

    const topupUpdate = writeRows.find(
      (row) => row.table_name === 'topup_requests' && row.privilege_type === 'UPDATE',
    );
    expect(topupUpdate?.columns).toEqual(
      ['status', 'reviewed_by_staff_id', 'review_reason', 'reviewed_at'].sort(),
    );
  });
});
