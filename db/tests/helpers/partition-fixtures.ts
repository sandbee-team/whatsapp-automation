import type pg from 'pg';

/**
 * Shared setup/query machinery for `partitions.test.ts` (P02 migration 0003
 * / P03 `ensureAllPartitions`), split out at P03 close for the max-lines
 * cap. Pure DB-access helpers only - no assertions here, those stay in the
 * test file.
 */

/** Throwaway partitioned probe table used by the migration-0003 cases; always dropped by the caller's `afterEach`. */
export async function createPartitionProbeTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE wp_part_probe (
      client_id uuid NOT NULL,
      created_at timestamptz NOT NULL
    ) PARTITION BY RANGE (created_at)
  `);
}

export interface UnkeyedUniqueIndexRow {
  index_name: string;
  table_name: string;
  key_columns: string[];
  index_columns: string[];
}

/**
 * Blueprint mandatory test 21 - generic catalog scan, no probe table. For
 * every partitioned parent in `public` AND every one of its partition
 * children, every UNIQUE index (including PKs) must include all of the
 * parent's partition-key columns. Postgres allows a UNIQUE index created
 * directly on one child that omits the key - that is per-partition
 * uniqueness only, silently NOT global uniqueness. Returns the violating
 * rows (empty when clean).
 */
export async function fetchUnkeyedUniqueIndexes(pool: pg.Pool): Promise<UnkeyedUniqueIndexRow[]> {
  const result = await pool.query<UnkeyedUniqueIndexRow>(`
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
  return result.rows;
}

/**
 * Drops every far-future (year 2032) monthly/weekly partition child of
 * message_jobs, wallet_ledger and delivery_events - the `ensureAllPartitions`
 * cases' own cleanup, shared so both the "creates current plus two months"
 * and "is idempotent when rerun" cases call one line instead of repeating
 * the DO block.
 */
export async function dropY2032TestPartitions(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE v_table name;
    BEGIN
      FOR v_table IN
        SELECT c.relname
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent IN (
                 'message_jobs'::regclass, 'wallet_ledger'::regclass, 'delivery_events'::regclass
               )
           AND (c.relname LIKE '%_y2032m%' OR c.relname LIKE '%_y2032w%')
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I', v_table);
      END LOOP;
    END;
    $$;
  `);
}
