import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from './export.js';

/**
 * export.test.ts (P20 Unit U6, step 7) - pure unit coverage for
 * `escapeCsvCell`: RFC 4180 quoting PLUS the formula-injection defence (a
 * raw value starting with `=`, `+`, `-`, `@`, tab, or CR is prefixed with a
 * literal `'` before quoting, neutralising a spreadsheet formula payload).
 */

describe('escape_csv_cell_neutralises_formula_prefixes_and_quotes_correctly', () => {
  it('escape_csv_cell_neutralises_formula_prefixes_and_quotes_correctly', () => {
    const cases: Array<[string | null | undefined, string]> = [
      [`=cmd|' /C calc'!A0`, `"'=cmd|' /C calc'!A0"`],
      ['+1', `"'+1"`],
      ['-1', `"'-1"`],
      ['@x', `"'@x"`],
      ['\tX', `"'\tX"`],
      ['\rX', `"'\rX"`],
      ['a"b', `"a""b"`],
      ['a,b', `"a,b"`],
      ['a\nb', `"a\nb"`],
      ['plain', 'plain'],
      [null, ''],
      [undefined, ''],
      // Phones start with `+` - quoted+prefixed by design (spreadsheets
      // strip the leading apostrophe on display, same as any other cell).
      ['+919876543210', `"'+919876543210"`],
    ];

    for (const [input, expected] of cases) {
      expect(escapeCsvCell(input)).toBe(expected);
    }
  });
});
