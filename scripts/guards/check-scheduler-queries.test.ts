import { describe, expect, it } from 'vitest';
import {
  extractLoadedQueryNames,
  hasLimitClause,
  isInherentlySingleRow,
  scanSchedulerQueries,
} from './scheduler-queries-lib.js';
import type { SourceFile } from './scheduler-queries-lib.js';
import { runCheckSchedulerQueries, SCHEDULER_LOOP_MODULES } from '../check-scheduler-queries.js';

// The loadNamedQuery('<file>', '<section>') half of this guard's own proofs
// (extractLoadedNamedQueryRefs / resolveNamedSectionText) lives in the
// sibling check-scheduler-named-queries.test.ts, split at the max-lines cap.

/**
 * check-scheduler-queries.test.ts (P16 gap-closer, item 1) - proves the
 * "no query in a scheduler loop without a LIMIT" guard: a fixture loop
 * module that loads an unbounded `.sql` file turns the pure scanner red; the
 * real pinned module list is green against the real repo tree.
 */

describe('scanSchedulerQueries (pure core)', () => {
  it('a_fixture_loop_module_loading_an_unbounded_sql_file_is_flagged', () => {
    const modules: SourceFile[] = [
      {
        path: 'fixture/bad-loop.ts',
        content: `const query = await loadQuery('unbounded-scan');`,
      },
    ];
    const queriesByName = new Map<string, SourceFile>([
      [
        'unbounded-scan',
        {
          path: 'db/queries/unbounded-scan.sql',
          content: `SELECT instance_id, client_id FROM whatsapp_instances WHERE desired_state = 'online';`,
        },
      ],
    ]);

    const violations = scanSchedulerQueries(modules, queriesByName);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.module).toBe('fixture/bad-loop.ts');
    expect(violations[0]?.queryPath).toBe('db/queries/unbounded-scan.sql');
  });

  it('a_fixture_loop_module_loading_a_limit_bounded_sql_file_is_clean', () => {
    const modules: SourceFile[] = [
      {
        path: 'fixture/good-loop.ts',
        content: `const query = await loadQuery('bounded-scan');`,
      },
    ];
    const queriesByName = new Map<string, SourceFile>([
      [
        'bounded-scan',
        {
          path: 'db/queries/bounded-scan.sql',
          content: `SELECT instance_id FROM whatsapp_instances WHERE desired_state = 'online' LIMIT $max_rows;`,
        },
      ],
    ]);

    const violations = scanSchedulerQueries(modules, queriesByName);

    expect(violations).toHaveLength(0);
  });

  it('a_loaded_query_name_with_no_resolvable_sql_file_is_flagged_not_silently_skipped', () => {
    const modules: SourceFile[] = [
      { path: 'fixture/missing-loop.ts', content: `await loadQuery('does-not-exist');` },
    ];

    const violations = scanSchedulerQueries(modules, new Map());

    expect(violations).toHaveLength(1);
    expect(violations[0]?.queryPath).toBe('db/queries/does-not-exist.sql');
  });

  it('a_module_loading_no_query_at_all_is_clean', () => {
    const modules: SourceFile[] = [
      { path: 'fixture/no-query-loop.ts', content: `// no loadQuery call here` },
    ];

    expect(scanSchedulerQueries(modules, new Map())).toHaveLength(0);
  });
});

describe('extractLoadedQueryNames', () => {
  it('extracts_every_distinct_loadquery_name_in_first_occurrence_order', () => {
    const content = `
      await loadQuery('first-name');
      await loadQuery("second-name");
      await loadQuery('first-name');
    `;
    expect(extractLoadedQueryNames(content)).toEqual(['first-name', 'second-name']);
  });
});

describe('hasLimitClause', () => {
  it('is_case_insensitive', () => {
    expect(hasLimitClause('SELECT 1 limit $1')).toBe(true);
    expect(hasLimitClause('SELECT 1 LIMIT $1')).toBe(true);
    expect(hasLimitClause('SELECT 1')).toBe(false);
  });

  it('accepts_a_bounded_batch_bind_parameter_into_a_delegated_function', () => {
    expect(hasLimitClause('SELECT * FROM wp_lease_scan_unowned($stale_ms, $max_rows)')).toBe(true);
    expect(hasLimitClause('SELECT * FROM wp_reap_expired_leases($grace_seconds, $limit)')).toBe(
      true,
    );
  });
});

describe('isInherentlySingleRow', () => {
  it('an_update_keyed_by_id_is_exempt', () => {
    expect(
      isInherentlySingleRow(
        `UPDATE whatsapp_instances SET health_state = 'degraded' WHERE id = $instance_id AND client_id = $client_id`,
      ),
    ).toBe(true);
  });

  it('a_select_with_no_top_level_from_is_exempt', () => {
    expect(
      isInherentlySingleRow(
        `SELECT (SELECT count(*) FROM whatsapp_instances) AS unowned_count, (SELECT count(*) FROM whatsapp_instances) AS desired_online_count`,
      ),
    ).toBe(true);
  });

  it('a_select_from_a_table_is_never_exempt', () => {
    expect(
      isInherentlySingleRow(
        `SELECT instance_id, client_id FROM instance_pacing_state WHERE eval_due_at <= now()`,
      ),
    ).toBe(false);
  });

  it('an_update_with_an_in_subselect_is_a_batch_write_never_exempt', () => {
    // Fix 2 (P16 fix round): a WHERE ... IN (SELECT ...) UPDATE scans/claims
    // a set of rows, not a single keyed row - deleting the subquery's own
    // LIMIT must not be able to slip past this guard as an "exempt" shape.
    expect(
      isInherentlySingleRow(
        `UPDATE instance_pacing_state SET eval_due_at = now() + interval '60 seconds'
          WHERE instance_id IN (
            SELECT instance_id FROM instance_pacing_state WHERE eval_due_at <= now()
          )
        RETURNING instance_id, client_id`,
      ),
    ).toBe(false);
  });

  it('a_delete_with_an_in_subselect_is_a_batch_write_never_exempt', () => {
    expect(
      isInherentlySingleRow(
        `DELETE FROM instance_health_samples
          WHERE id IN (SELECT id FROM instance_health_samples WHERE created_at < now())`,
      ),
    ).toBe(false);
  });

  it('a_guard_first_keyed_cte_chain_is_exempt', () => {
    // Same shape as debit-send.sql's debit-send / wallet-reconcile.sql's
    // wallet-adjustment-debit: every CTE keyed off the first CTE's own
    // $attempt/$client equality, chained via FROM <priorCte> only.
    expect(
      isInherentlySingleRow(
        `WITH job AS (
           SELECT j.id, j.client_id FROM send_attempts a
             JOIN message_jobs j ON j.id = a.message_job_id
            WHERE a.id = $attempt AND a.client_id = $client
         ),
         guard AS (
           INSERT INTO wallet_charge_guards (send_attempt_id, client_id)
           SELECT $attempt, u.client_id FROM job u
           RETURNING send_attempt_id, client_id
         ),
         acct AS (
           UPDATE wallet_accounts w SET balance_minor = w.balance_minor - $rate
             FROM guard g WHERE w.client_id = g.client_id
           RETURNING w.client_id
         )
         SELECT (SELECT count(*) FROM job)::int AS job_rows`,
      ),
    ).toBe(true);
  });

  it('a_with_chain_that_scans_a_fresh_table_is_never_exempt', () => {
    expect(
      isInherentlySingleRow(
        `WITH recent AS (
           SELECT client_id FROM wallet_accounts
         )
         SELECT client_id FROM recent`,
      ),
    ).toBe(false);
  });

  it('an_update_keyed_by_multiple_equality_columns_is_exempt', () => {
    expect(
      isInherentlySingleRow(
        `UPDATE instance_pacing_state SET last_hard_signal_at = now() WHERE instance_id = $1 AND client_id = $2`,
      ),
    ).toBe(true);
  });
});

describe('scanSchedulerQueries - UPDATE-with-IN-subselect loophole (P16 fix round, Fix 2)', () => {
  it('a_fixture_update_with_an_in_subselect_and_no_limit_is_flagged', () => {
    const modules: SourceFile[] = [
      {
        path: 'fixture/bad-batch-update-loop.ts',
        content: `const query = await loadQuery('unbounded-batch-update');`,
      },
    ];
    const queriesByName = new Map<string, SourceFile>([
      [
        'unbounded-batch-update',
        {
          path: 'db/queries/unbounded-batch-update.sql',
          content: `UPDATE instance_pacing_state SET eval_due_at = now()
             WHERE instance_id IN (
               SELECT instance_id FROM instance_pacing_state WHERE eval_due_at <= now()
             )
           RETURNING instance_id;`,
        },
      ],
    ]);

    const violations = scanSchedulerQueries(modules, queriesByName);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.queryPath).toBe('db/queries/unbounded-batch-update.sql');
  });

  it('the_real_repo_tree_today_has_zero_violations_after_the_tightened_exemption', () => {
    const result = runCheckSchedulerQueries();
    expect(result.violations).toEqual([]);
  });
});

describe('runCheckSchedulerQueries (real repo tree)', () => {
  it('the_pinned_module_list_is_non_empty_and_every_module_exists', () => {
    expect(SCHEDULER_LOOP_MODULES.length).toBeGreaterThan(0);
    // runCheckSchedulerQueries reads every pinned module from disk - if any
    // path were wrong, readFileSync would throw before returning a result.
    expect(() => runCheckSchedulerQueries()).not.toThrow();
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckSchedulerQueries();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });
});
