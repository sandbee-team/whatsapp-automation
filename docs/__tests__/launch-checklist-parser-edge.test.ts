import { describe, expect, it } from 'vitest';
import { extractBacktickedPaths, parseChecklistRows } from './launch-checklist-parser.js';

/**
 * launch-checklist-parser-edge.test.ts (P29a E3/C2 hardening) - exercises
 * the checklist table PARSER on synthetic strings, never the real
 * `docs/LAUNCH-CHECKLIST.md` file (that stays launch-checklist.test.ts's
 * job). Each fixture row below is a case the launch-checklist.test.ts rules
 * (applied by a caller, not the parser itself) must reject.
 */

const HEADER = '| # | Gate | Status | Evidence | Notes |';
const SEPARATOR = '| --- | --- | --- | --- | --- |';

function table(...rows: string[]): string {
  return [HEADER, SEPARATOR, ...rows].join('\n');
}

describe('parseChecklistRows on synthetic tables', () => {
  it('a_done_row_with_evidence_em_dash_parses_but_has_zero_backticked_paths', () => {
    const text = table('| 1 | Some gate | DONE | — | a note |');
    const rows = parseChecklistRows(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('DONE');
    const paths = extractBacktickedPaths(rows[0]?.evidence ?? '');
    // A DONE row's caller-side rule requires >= 1 backticked path - this
    // fixture must produce ZERO, so the caller rule rejects it.
    expect(paths).toHaveLength(0);
  });

  it('a_not_done_row_with_a_path_parses_but_evidence_is_not_the_bare_em_dash', () => {
    const text = table('| 1 | Some gate | NOT DONE | `docs/evidence/x.md` | a note |');
    const rows = parseChecklistRows(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('NOT DONE');
    // The caller rule requires evidence === '—' for a NOT DONE row - this
    // fixture's evidence is NOT that, so the caller rule rejects it.
    expect(rows[0]?.evidence).not.toBe('—');
  });

  it('a_path_outside_backticks_leaves_residual_text_after_stripping_backticked_spans', () => {
    const text = table('| 1 | Some gate | DONE | `docs/a.md` and also docs/b.md | a note |');
    const rows = parseChecklistRows(text);
    const evidence = rows[0]?.evidence ?? '';
    const withoutBackticked = evidence
      .replace(/`[^`]+`/g, '')
      .replace(/,/g, '')
      .trim();
    // The caller rule requires this to be empty for a clean DONE row - here
    // it is NOT empty (residual "and also docs/b.md"), so it is rejected.
    expect(withoutBackticked).not.toBe('');
  });

  it('a_windows_style_backslash_path_is_extracted_verbatim_not_normalised', () => {
    const text = table('| 1 | Some gate | DONE | `docs\\evidence\\x.md` | a note |');
    const rows = parseChecklistRows(text);
    const paths = extractBacktickedPaths(rows[0]?.evidence ?? '');
    expect(paths).toEqual(['docs\\evidence\\x.md']);
    // The parser does not normalise separators - a consuming rule that
    // joins this against a POSIX-style repo root would fail to find the
    // file (a Windows-backslash path is not a valid evidence path on this
    // repo's convention), which is why this fixture must be REJECTED by
    // any caller that checks fs.existsSync on the raw path.
    expect(paths[0]).not.toContain('/');
  });

  it('trailing_spaces_around_status_are_trimmed_by_the_parser_not_left_dangling', () => {
    const text = table('| 1 | Some gate |   DONE   | `docs/a.md` | a note |');
    const rows = parseChecklistRows(text);
    // The parser's own `.trim()` normalises this to the exact accepted
    // token - documented behaviour, not a false-negative in the caller
    // rule (a caller comparing status !== 'DONE' would otherwise wrongly
    // reject a merely-padded but semantically valid row).
    expect(rows[0]?.status).toBe('DONE');
  });

  it('lowercase_done_is_not_a_recognised_status_token', () => {
    const text = table('| 1 | Some gate | done | `docs/a.md` | a note |');
    const rows = parseChecklistRows(text);
    expect(rows[0]?.status).toBe('done');
    // The caller rule is `['DONE', 'NOT DONE'].includes(status)` -
    // case-sensitive, so lowercase "done" must be rejected by that rule.
    expect(['DONE', 'NOT DONE']).not.toContain(rows[0]?.status);
  });

  it('a_row_whose_first_cell_is_not_a_number_is_skipped_entirely', () => {
    const text = table('| # | Some gate | DONE | `docs/a.md` | a note |');
    const rows = parseChecklistRows(text);
    expect(rows).toHaveLength(0);
  });

  it('a_separator_row_of_dashes_is_skipped_even_mid_table', () => {
    const text = table(
      '| 1 | Gate one | DONE | `docs/a.md` | note one |',
      '| --- | --- | --- | --- | --- |',
      '| 2 | Gate two | DONE | `docs/b.md` | note two |',
    );
    const rows = parseChecklistRows(text);
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  it('multiple_backticked_paths_in_one_evidence_cell_are_all_extracted_in_order', () => {
    const evidence = '`docs/a.md`, `docs/b.md`, `docs/c.md`';
    expect(extractBacktickedPaths(evidence)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md']);
  });
});
