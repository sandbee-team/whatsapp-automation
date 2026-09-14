import { PG_ENUMS } from '@wp/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { SUITE_A_INDEX_EXEMPTIONS } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * P03 (db-queue-and-claim) Unit A - the five schema-assertion cases named in
 * the phase file's "Tests that prove it" table. Two of these (case 1 and
 * case 3 below) are intentionally the SAME catalog-scan assertion already
 * proven by pre-existing P02 tests (`db/tests/partitions.test.ts`'s
 * `no_unique_index_on_a_partitioned_table_without_the_partition_key`, and
 * `db/tests/enum-parity.test.ts`'s `enum_parity_db_vs_domain`) - duplicated
 * here verbatim because the P03 dispatch names this file as their home too.
 * The duplication is harmless: both are read-only catalog scans with no
 * side effects, so running the same query twice from two files changes
 * nothing about what is asserted.
 */
describe('schema_assertions', () => {
  afterAll(async () => {
    await closeMigratedPool();
  });

  it('no_unique_index_on_a_partitioned_table_without_the_partition_key', async () => {
    const pool = await getMigratedPool();

    // Blueprint mandatory test 21 - generic catalog scan, no probe table.
    // For every partitioned parent in `public` AND every one of its
    // partition children, every UNIQUE index (including PKs) must include
    // all of the parent's partition-key columns.
    const result = await pool.query<{
      index_name: string;
      table_name: string;
      key_columns: string[];
      index_columns: string[];
    }>(`
      WITH partition_keys AS (
        SELECT
          pt.partrelid AS parent_oid,
          array_agg(a.attname) AS key_columns
        FROM pg_catalog.pg_partitioned_table pt
        JOIN pg_catalog.pg_class pc ON pc.oid = pt.partrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = pc.relnamespace
        CROSS JOIN LATERAL unnest(pt.partattrs) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = k.attnum
        WHERE n.nspname = 'public'
        GROUP BY pt.partrelid
      ),
      target_tables AS (
        SELECT parent_oid AS table_oid, key_columns FROM partition_keys
        UNION ALL
        SELECT i.inhrelid AS table_oid, pk.key_columns
          FROM pg_catalog.pg_inherits i
          JOIN partition_keys pk ON pk.parent_oid = i.inhparent
      ),
      unique_indexes AS (
        SELECT
          ix.indexrelid,
          ix.indrelid AS table_oid,
          array_agg(a.attname) AS index_columns
        FROM pg_catalog.pg_index ix
        CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = x.attnum
        WHERE ix.indisunique AND x.ord <= ix.indnkeyatts
        GROUP BY ix.indexrelid, ix.indrelid
      )
      SELECT
        c.relname AS index_name,
        tt.table_oid::regclass::text AS table_name,
        tt.key_columns,
        ui.index_columns
      FROM unique_indexes ui
      JOIN target_tables tt ON tt.table_oid = ui.table_oid
      JOIN pg_catalog.pg_class c ON c.oid = ui.indexrelid
      WHERE NOT (tt.key_columns::text[] <@ ui.index_columns::text[])
    `);

    expect(result.rows).toEqual([]);
  });

  it('exactly_one_table_carries_a_reserve_counter', async () => {
    const pool = await getMigratedPool();

    // Blueprint mandatory test 22 - EQUALITY assertion, tightened by P13
    // (this case was a SUBSET assertion at P03, since `pacing_ledger` did
    // not exist yet: "no table other than pacing_ledger carries a reserve
    // counter" rather than "exactly {pacing_ledger}", which would have been
    // a red test nobody in that session could fix). P13's migration 0030
    // creates `pacing_ledger` - the reserve/refund authority the blueprint
    // calls "one counter table, one grantor" - so the set of tables holding
    // a reserve counter now equals exactly `{pacing_ledger}`, asserted here
    // as two conjoined checks so the test fails LOUDLY (not vacuously) if
    // `pacing_ledger` itself is ever missing:
    //   1. no table OTHER than pacing_ledger carries a reserve counter
    //      (same leak-detection query as the original subset assertion,
    //      unchanged operational definition - a NUMERIC column whose name
    //      contains "reserve", case-insensitive; `message_jobs.pacing_
    //      reserved_at` is a timestamp, not a counter, so it never matches).
    //   2. pacing_ledger itself EXISTS and carries its real counter column
    //      (`consumed_count`) - a non-vacuous existence check. pacing_ledger's
    //      own counter columns are named `consumed_count`/`sent_this_hour`/
    //      etc, not literally "*reserve*" (the RESERVE ACTION is what
    //      `pacing_ledger.last_reserved_at`/`next_eligible_at` record - the
    //      counter it increments per reservation is `consumed_count`), so
    //      check 2 is the equality assertion's "pacing_ledger is present"
    //      half; check 1 is its "and nothing else" half - together they are
    //      exactly `{pacing_ledger}`, never a vacuous empty-set pass.
    const leaks = await pool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name <> 'pacing_ledger'
         AND column_name ILIKE '%reserve%'
         AND data_type IN ('smallint', 'integer', 'bigint', 'numeric')
    `);
    expect(leaks.rows).toEqual([]);

    const ledgerCounter = await pool.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pacing_ledger'
         AND column_name = 'consumed_count'
         AND data_type IN ('smallint', 'integer', 'bigint', 'numeric')
    `);
    expect(ledgerCounter.rows).toHaveLength(1);
  });

  it('enum_parity_db_vs_domain', async () => {
    const pool = await getMigratedPool();

    // Blueprint mandatory test 23 - every pg_enum label set equals its
    // @wp/domain union, both directions.
    const result = await pool.query<{ enum_name: string; label: string }>(`
      SELECT t.typname AS enum_name, e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `);

    const dbEnums = new Map<string, string[]>();
    for (const row of result.rows) {
      const labels = dbEnums.get(row.enum_name) ?? [];
      labels.push(row.label);
      dbEnums.set(row.enum_name, labels);
    }

    for (const [enumName, expectedLabels] of Object.entries(PG_ENUMS)) {
      const actualLabels = dbEnums.get(enumName);
      expect(actualLabels, `enum '${enumName}' missing from the database`).toBeDefined();
      expect(actualLabels).toEqual([...expectedLabels]);
    }

    for (const enumName of dbEnums.keys()) {
      expect(
        Object.hasOwn(PG_ENUMS, enumName),
        `DB enum '${enumName}' has no PG_ENUMS mirror in @wp/domain`,
      ).toBe(true);
    }
  });

  it('every_new_queue_table_leads_with_client_id_or_is_on_the_exemption_list', async () => {
    const pool = await getMigratedPool();

    // The exemption list is exactly the delta's three entries - none exist
    // as live tables yet, so this is a static identity check on the
    // registry, mirroring db/tests/isolation-suite-a.test.ts's own
    // "the_suite_a_index_exemption_list_is_exactly_three_entries" case.
    const expectedExemptions = [
      'campaign_recipients',
      'wallet_charge_guards',
      'contact_import_errors',
    ];
    expect([...SUITE_A_INDEX_EXEMPTIONS].sort()).toEqual([...expectedExemptions].sort());

    // Every table this P03 dispatch created must have AT LEAST ONE index
    // (unique or not - the PK counts) whose FIRST column is client_id,
    // unless the table is on the exemption list above. None of the nine
    // tables below are on that list, so all nine must satisfy the rule
    // directly - several do so via a PK that happens to lead with
    // client_id (message_wa_ids), most via a purpose-built secondary index
    // (see migrations 0007-0010 for which index on each table this is).
    const newQueueTables = [
      'message_jobs',
      'message_job_refs',
      'message_wa_ids',
      'delivery_event_ids',
      'send_attempts',
      'delivery_events',
      'whatsapp_instances',
      'instance_lease_state',
      'campaigns',
    ];

    const result = await pool.query<{ table_name: string; first_column: string | null }>(
      `
      SELECT
        COALESCE(p.relname, c.relname) AS table_name,
        a.attname AS first_column
      FROM pg_catalog.pg_index ix
      JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
      LEFT JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]
      WHERE n.nspname = 'public'
        AND COALESCE(p.relname, c.relname) = ANY($1)
      `,
      [newQueueTables],
    );

    const tablesWithClientIdLeadingIndex = new Set(
      result.rows.filter((row) => row.first_column === 'client_id').map((row) => row.table_name),
    );

    const violations = newQueueTables.filter((table) => !tablesWithClientIdLeadingIndex.has(table));
    expect(violations, `tables with no client_id-leading index: ${violations.join(', ')}`).toEqual(
      [],
    );
  });

  // P06 (session-lease-and-fence) - the 0010 shell deliberately excluded
  // current_fence/lease_seen_at from whatsapp_instances (they live on
  // instance_lease_state instead); this pins that split stays true after
  // migration 0018 adds `released_at` to instance_lease_state.
  it('whatsapp_instances_no_longer_carries_a_fence', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('whatsapp_instances', 'instance_lease_state')
          AND column_name IN ('current_fence', 'lease_seen_at', 'released_at')`,
    );

    const byTable = new Map<string, Set<string>>();
    for (const row of result.rows) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      byTable.set(row.table_name, set);
    }

    expect(byTable.get('whatsapp_instances')?.has('current_fence')).toBeFalsy();
    expect(byTable.get('whatsapp_instances')?.has('lease_seen_at')).toBeFalsy();

    expect(byTable.get('instance_lease_state')?.has('current_fence')).toBe(true);
    expect(byTable.get('instance_lease_state')?.has('lease_seen_at')).toBe(true);
    expect(byTable.get('instance_lease_state')?.has('released_at')).toBe(true);
  });

  // P08 Unit U3 (migration 0022) - the P06-carried leftover: nothing has
  // written whatsapp_instances.owner_worker_id since lease ownership moved to
  // instance_lease_state.owner_worker_id in migration 0018; this pins the
  // dead duplicate is gone while instance_lease_state.owner_worker_id (the
  // real column) stays untouched.
  it('whatsapp_instances_no_longer_carries_owner_worker_id', async () => {
    const pool = await getMigratedPool();

    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('whatsapp_instances', 'instance_lease_state')
          AND column_name = 'owner_worker_id'`,
    );

    const tablesWithColumn = new Set(result.rows.map((row) => row.table_name));

    expect(tablesWithColumn.has('whatsapp_instances')).toBe(false);
    expect(tablesWithColumn.has('instance_lease_state')).toBe(true);
  });

  it('no_foreign_key_points_at_message_jobs', async () => {
    const pool = await getMigratedPool();

    // Zero FKs referencing the partitioned parent, in either direction -
    // covers both a hypothetical FK ON message_jobs and a FK on some OTHER
    // table that targets message_jobs (confrelid).
    const result = await pool.query<{ conname: string; table_name: string }>(`
      SELECT con.conname, con.conrelid::regclass::text AS table_name
        FROM pg_catalog.pg_constraint con
       WHERE con.contype = 'f'
         AND (
           con.conrelid = 'message_jobs'::regclass
           OR con.confrelid = 'message_jobs'::regclass
         )
    `);

    expect(result.rows).toEqual([]);
  });
});
