import { describe, expect, it } from 'vitest';
import {
  bindQueryParams,
  convertNamedParams,
  loadNamedQuery,
  loadQuery,
  splitNamedSections,
  type LoadedSqlQuery,
} from './queries.js';

/**
 * db/src/queries.ts (P03 Unit B, step 5) - the shared named-param SQL
 * loader. `convertNamedParams` is the pure in-memory conversion
 * (`$name` -> `$1..$n`, stable first-occurrence order, repeated names reuse
 * their position); `loadQuery` reads the on-disk file byte-exact and applies
 * it, caching per file base name. No real Postgres connection is needed for
 * any of this - purely file/text transforms.
 */

describe('convertNamedParams', () => {
  it('replaces_named_params_with_positional_binds_in_first_occurrence_order', () => {
    const raw = 'SELECT * FROM t WHERE a = $foo AND b = $bar';
    const result = convertNamedParams(raw);

    expect(result.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(result.paramNames).toEqual(['foo', 'bar']);
  });

  it('a_repeated_named_param_reuses_the_same_positional_index', () => {
    const raw = 'UPDATE t SET a = $fence WHERE b = $fence';
    const result = convertNamedParams(raw);

    expect(result.text).toBe('UPDATE t SET a = $1 WHERE b = $1');
    expect(result.paramNames).toEqual(['fence']);
  });

  it('text_with_no_named_params_is_returned_unchanged_with_an_empty_param_list', () => {
    const raw = 'SELECT 1';
    const result = convertNamedParams(raw);

    expect(result.text).toBe('SELECT 1');
    expect(result.paramNames).toEqual([]);
  });
});

describe('bindQueryParams', () => {
  const query: LoadedSqlQuery = {
    name: 'fixture',
    text: 'SELECT $1, $2',
    paramNames: ['foo', 'bar'],
  };

  it('binds_named_values_to_the_positional_array_in_paramNames_order', () => {
    expect(bindQueryParams(query, { bar: 'b', foo: 'a' })).toEqual(['a', 'b']);
  });

  it('throws_when_a_required_param_name_is_missing', () => {
    expect(() => bindQueryParams(query, { foo: 'a' })).toThrow(/bar/);
  });
});

describe('loadQuery("claim-jobs")', () => {
  it('loads_the_on_disk_claim_jobs_sql_and_converts_every_named_param', async () => {
    const query = await loadQuery('claim-jobs');

    expect(query.name).toBe('claim-jobs');
    expect(query.text).not.toContain('$client_id');
    expect(query.text).not.toContain('$fence');
    expect(query.text).toContain('SKIP LOCKED');
    expect(query.paramNames).toEqual([
      'client_id',
      'instance_id',
      'band',
      'fence',
      'worker',
      'claim_expiry_ms',
    ]);
  });

  it('the_fence_param_appears_twice_in_the_sql_body_but_once_in_paramNames', async () => {
    const query = await loadQuery('claim-jobs');
    const fenceIndex = query.paramNames.indexOf('fence') + 1;
    const occurrences = query.text.split(`$${String(fenceIndex)}`).length - 1;

    expect(occurrences).toBe(2);
  });

  it('a_second_call_returns_a_cached_equal_result', async () => {
    const first = await loadQuery('claim-jobs');
    const second = await loadQuery('claim-jobs');

    expect(second).toEqual(first);
  });

  it('rejects_a_query_name_that_could_escape_the_queries_dir', async () => {
    // note 9, P03 close: `name` is joined straight into a filesystem path -
    // must never be allowed to traverse out of db/queries/.
    await expect(loadQuery('../secrets')).rejects.toThrow(/invalid query name/);
  });
});

describe('loadQuery() on the pacing statements - comment-aware parsing (Finding 2)', () => {
  /**
   * FINDING 2 FIX (P13 C1 review): `convertNamedParams` used to be
   * comment-UNAWARE, so it harvested `$name` tokens out of header-comment
   * PROSE (e.g. `reserve-pacing.sql`'s own header, documenting `$name`
   * itself) as spurious bind parameters, silently shifting every real
   * positional bind by one. These tests assert the TRUE, authoritative
   * bind order for every pacing statement that has ever hit this bug class
   * - `paramNames` is the runtime authority (see each SQL file's own
   * header, which points back here) - a regression that reintroduces
   * comment-sensitivity would change one of these lists.
   */
  it('reserve_pacing_param_order_is_correct_and_comment_immune', async () => {
    const query = await loadQuery('reserve-pacing');
    expect(query.paramNames).toEqual([
      'instance_id',
      'client_id',
      'is_exempt',
      'is_new_conversation',
      'is_group',
      'gap_ms',
    ]);
  });

  it('release_pacing_param_order_is_correct_and_comment_immune', async () => {
    const query = await loadQuery('release-pacing');
    expect(query.paramNames).toEqual([
      'message_job_id',
      'client_id',
      'is_exempt',
      'is_new_conversation',
      'is_group',
      'gap_ms',
      'instance_id',
      'ledger_date',
    ]);
  });

  it('pacing_deny_reason_param_order_is_correct_and_comment_immune', async () => {
    const query = await loadQuery('pacing-deny-reason');
    expect(query.paramNames).toEqual([
      'instance_id',
      'client_id',
      'is_exempt',
      'is_new_conversation',
      'is_group',
    ]);
  });
});

describe('loadQuery() on the P14 Unit U6 guard-pipeline dispose/defer statements', () => {
  it('dispose_job_param_order_is_correct_and_comment_immune', async () => {
    const query = await loadQuery('dispose-job');
    expect(query.paramNames).toEqual(['outcome', 'reason', 'id', 'client_id', 'lease_id']);
  });

  it('defer_job_param_order_is_correct_and_comment_immune', async () => {
    const query = await loadQuery('defer-job');
    expect(query.paramNames).toEqual(['retry_at', 'reason', 'id', 'client_id', 'lease_id']);
  });
});

describe('splitNamedSections', () => {
  it('splits_a_file_with_two_named_sections_into_a_map_keyed_by_label', () => {
    const raw = [
      '-- header prose, ignored',
      '-- name: first-section',
      'SELECT 1',
      '-- name: second-section',
      'SELECT 2',
      '',
    ].join('\n');

    const sections = splitNamedSections(raw);

    expect([...sections.keys()]).toEqual(['first-section', 'second-section']);
    expect(sections.get('first-section')).toBe('SELECT 1');
    expect(sections.get('second-section')).toBe('SELECT 2');
  });

  it('header_prose_before_the_first_marker_is_ignored', () => {
    const raw = ['-- this file documents $something in prose', '-- name: only', 'SELECT 3'].join(
      '\n',
    );

    const sections = splitNamedSections(raw);

    expect(sections.size).toBe(1);
    expect(sections.get('only')).toBe('SELECT 3');
  });

  it('a_file_with_no_markers_yields_an_empty_map', () => {
    const sections = splitNamedSections('SELECT 1');
    expect(sections.size).toBe(0);
  });
});

describe('loadNamedQuery', () => {
  it('throws_a_clear_error_when_the_named_section_does_not_exist', async () => {
    await expect(loadNamedQuery('ensure-partitions', 'does-not-exist')).rejects.toThrow(
      /has no "-- name: does-not-exist" section/,
    );
  });

  it('loads_a_real_named_section_and_converts_its_params', async () => {
    const query = await loadNamedQuery('ensure-partitions', 'ensureMonthlyPartition');
    expect(query.name).toBe('ensure-partitions:ensureMonthlyPartition');
    expect(query.text).not.toMatch(/\$[A-Za-z_]/);
  });
});
