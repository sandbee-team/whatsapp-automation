import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/**
 * Blueprint mandatory tests for migration 0004 (wallet and pricing) - see
 * `plan/v1/P02-db-foundations-and-isolation.md` step 6. Probe rows (a user +
 * client, needed only to satisfy `wallet_accounts.client_id`'s FK to
 * `clients`) are tracked per test and removed in `afterEach`, in reverse-FK
 * order, so the shared dev database stays clean for the other suites in
 * this file (schema_parity, enum_parity) and for `partitions.test.ts`'s
 * generic catalog scan.
 */
describe('wallet_schema', () => {
  let probeUserIds: string[] = [];
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM wallet_ledger_ext_refs WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    }
    if (probeUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [probeUserIds]);
    }
    probeUserIds = [];
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  /** Creates a probe user + client pair and tracks both ids for cleanup. */
  async function createProbeClient(): Promise<string> {
    const pool = await getMigratedPool();
    const userId = randomUUID();
    const clientId = randomUUID();

    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Wallet Probe',
      `wallet-probe-${clientId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Wallet Probe Client',
      `wallet-probe-${clientId}`,
    ]);

    probeUserIds.push(userId);
    probeClientIds.push(clientId);
    return clientId;
  }

  it('wallet_accounts_max_rate_minor_rejects_zero_and_negative', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();

    await expect(
      pool.query('INSERT INTO wallet_accounts (client_id, max_rate_minor) VALUES ($1, $2)', [
        clientId,
        0,
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    await expect(
      pool.query('INSERT INTO wallet_accounts (client_id, max_rate_minor) VALUES ($1, $2)', [
        clientId,
        -5,
      ]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23514' });

    await expect(
      pool.query('INSERT INTO wallet_accounts (client_id) VALUES ($1)', [clientId]),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23502' });

    const columnCheck = await pool.query<{ column_default: string | null }>(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'wallet_accounts' AND column_name = 'max_rate_minor'`,
    );
    expect(columnCheck.rowCount).toBe(1);
    expect(columnCheck.rows[0]?.column_default).toBeNull();
  });

  it('wallet_ledger_external_ref_uniqueness_lives_on_the_non_partitioned_side_table', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    const externalRef = `probe-ref-${randomUUID()}`;

    await pool.query(
      'INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq) VALUES ($1, $2, $3)',
      [clientId, externalRef, 1],
    );

    await expect(
      pool.query(
        'INSERT INTO wallet_ledger_ext_refs (client_id, external_ref, seq) VALUES ($1, $2, $3)',
        [clientId, externalRef, 2],
      ),
    ).rejects.toMatchObject<Partial<PgError>>({ code: '23505' });

    const partitionedCheck = await pool.query(
      `SELECT 1
         FROM pg_catalog.pg_partitioned_table pt
         JOIN pg_catalog.pg_class c ON c.oid = pt.partrelid
        WHERE c.relname = 'wallet_ledger_ext_refs'`,
    );
    expect(partitionedCheck.rowCount).toBe(0);

    // Enumerate wallet_ledger and every one of its partition children, then
    // scan for any UNIQUE index (any table, any of these OIDs) whose key
    // includes external_ref - proving global uniqueness was never attempted
    // via a per-partition index.
    const ledgerTables = await pool.query<{ table_oid: string }>(
      `SELECT 'wallet_ledger'::regclass::text AS table_oid
       UNION ALL
       SELECT i.inhrelid::regclass::text
         FROM pg_catalog.pg_inherits i
        WHERE i.inhparent = 'wallet_ledger'::regclass`,
    );
    const tableNames = ledgerTables.rows.map((row) => row.table_oid);

    const externalRefUniqueIndexes = await pool.query<{ index_name: string; table_name: string }>(
      `SELECT c.relname AS index_name, ix.indrelid::regclass::text AS table_name
         FROM pg_catalog.pg_index ix
         JOIN pg_catalog.pg_class c ON c.oid = ix.indexrelid
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE ix.indisunique
          AND k.ord <= ix.indnkeyatts
          AND a.attname = 'external_ref'
          AND ix.indrelid::regclass::text = ANY($1)`,
      [tableNames],
    );
    expect(externalRefUniqueIndexes.rows).toEqual([]);
  });

  it('no_money_column_is_a_floating_point_type', async () => {
    const pool = await getMigratedPool();

    const floatColumns = await pool.query<{ table_name: string; column_name: string }>(
      // Base tables only: extension views (pg_stat_statements, installed for P26)
      // expose double-precision timing columns that are not our schema.
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('real', 'double precision')`,
    );
    expect(floatColumns.rows).toEqual([]);

    const minorColumnsNotInt8 = await pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
    }>(
      `SELECT table_name, column_name, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name LIKE '%\\_minor' ESCAPE '\\'
          AND udt_name <> 'int8'`,
    );
    expect(minorColumnsNotInt8.rows).toEqual([]);
  });
});
