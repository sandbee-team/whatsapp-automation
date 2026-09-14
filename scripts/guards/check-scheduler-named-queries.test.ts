import { describe, expect, it } from 'vitest';
import {
  hasLimitClause,
  isInherentlySingleRow,
  scanSchedulerQueries,
} from './scheduler-queries-lib.js';
import type { SourceFile } from './scheduler-queries-lib.js';
import {
  extractLoadedNamedQueryRefs,
  resolveNamedSectionText,
} from './scheduler-named-queries-lib.js';

/**
 * check-scheduler-named-queries.test.ts (P18 U8b) - proves the
 * `loadNamedQuery('<file>', '<section>')` half of the "no query in a
 * scheduler loop without a LIMIT" guard, split out of
 * `check-scheduler-queries.test.ts` at the max-lines cap (same idiom as
 * `scheduler-named-queries-lib.ts` itself).
 */

describe('extractLoadedNamedQueryRefs', () => {
  it('extracts_every_distinct_loadnamedquery_file_and_section_pair_in_first_occurrence_order', () => {
    const content = `
      await loadNamedQuery('wallet-reconcile', 'wallet-rollup-compute');
      await loadNamedQuery("wallet-reconcile", "wallet-rollup-upsert");
      await loadNamedQuery('wallet-reconcile', 'wallet-rollup-compute');
    `;
    expect(extractLoadedNamedQueryRefs(content)).toEqual([
      { file: 'wallet-reconcile', section: 'wallet-rollup-compute' },
      { file: 'wallet-reconcile', section: 'wallet-rollup-upsert' },
    ]);
  });
});

describe('resolveNamedSectionText', () => {
  it('a_loadnamedquery_call_to_a_limit_bounded_section_passes', () => {
    const sqlFile: SourceFile = {
      path: 'db/queries/fixture-named.sql',
      content: `-- name: bounded-section\nSELECT * FROM wp_bounded_scan($limit);\n\n-- name: other-section\nSELECT 1;`,
    };
    const text = resolveNamedSectionText(sqlFile, 'bounded-section');
    expect(text).toContain('$limit');
    expect(hasLimitClause(text ?? '')).toBe(true);
  });

  it('a_planted_section_without_any_limit_or_bind_fails', () => {
    const sqlFile: SourceFile = {
      path: 'db/queries/fixture-named.sql',
      content: `-- name: unbounded-section\nSELECT client_id FROM wallet_accounts;`,
    };
    const text = resolveNamedSectionText(sqlFile, 'unbounded-section');
    expect(text).toBeDefined();
    expect(hasLimitClause(text ?? '')).toBe(false);
    expect(isInherentlySingleRow(text ?? '')).toBe(false);
  });

  it('a_fixture_loop_module_using_loadnamedquery_for_an_unbounded_section_is_flagged', () => {
    const modules: SourceFile[] = [
      {
        path: 'fixture/bad-named-loop.ts',
        content: `const q = await loadNamedQuery('fixture-named', 'unbounded-section');`,
      },
    ];
    const queriesByName = new Map<string, SourceFile>([
      [
        'fixture-named',
        {
          path: 'db/queries/fixture-named.sql',
          content: `-- name: unbounded-section\nSELECT client_id FROM wallet_accounts;`,
        },
      ],
    ]);

    const violations = scanSchedulerQueries(modules, queriesByName);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.queryPath).toBe('db/queries/fixture-named.sql');
  });

  it('a_fixture_loop_module_using_loadnamedquery_for_a_limit_bounded_section_is_clean', () => {
    const modules: SourceFile[] = [
      {
        path: 'fixture/good-named-loop.ts',
        content: `const q = await loadNamedQuery('fixture-named', 'bounded-section');`,
      },
    ];
    const queriesByName = new Map<string, SourceFile>([
      [
        'fixture-named',
        {
          path: 'db/queries/fixture-named.sql',
          content: `-- name: bounded-section\nSELECT * FROM wp_bounded_scan($limit);`,
        },
      ],
    ]);

    expect(scanSchedulerQueries(modules, queriesByName)).toHaveLength(0);
  });
});
