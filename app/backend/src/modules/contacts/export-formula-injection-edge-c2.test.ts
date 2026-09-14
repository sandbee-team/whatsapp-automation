import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from './export.js';

/**
 * export-formula-injection-edge-c2.test.ts (C2 hardening) - the C2 brief's
 * exact formula-injection edge cases not named in `export.test.ts`: a JSON
 * blob starting with `{` is NOT a formula trigger, the bare single
 * character `-` IS prefixed, an empty string stays unquoted-empty (never
 * itself treated as a formula trigger), and a value that is ONLY `\r\n` is
 * quoted (RFC 4180: contains `\r`/`\n`) even though it is not itself a
 * formula-trigger prefix match on its own bytes after any transform.
 */

describe('a JSON-shaped attrs cell beginning with { is not formula-guarded', () => {
  it('a_curly_brace_prefix_is_never_treated_as_a_formula_trigger', () => {
    const jsonCell = '{"city":"Pune"}';
    expect(escapeCsvCell(jsonCell)).toBe(`"{""city"":""Pune""}"`);
    // Specifically: no leading `'` guard was added - `{` is not in
    // FORMULA_TRIGGER_PATTERN (`=+-@\t\r`).
    expect(escapeCsvCell(jsonCell).startsWith(`"'`)).toBe(false);
  });
});

describe('a display_name of exactly a single hyphen', () => {
  it('the_bare_minus_character_is_formula_guarded_and_quoted', () => {
    expect(escapeCsvCell('-')).toBe(`"'-"`);
  });
});

describe('an empty string cell', () => {
  it('stays_unquoted_empty_never_formula_guarded', () => {
    expect(escapeCsvCell('')).toBe('');
  });
});

describe('a value containing only a CRLF pair', () => {
  it('is_quoted_because_it_contains_cr_and_lf', () => {
    // '\r\n' itself starts with `\r`, which IS a formula-trigger character
    // (FORMULA_TRIGGER_PATTERN includes `\r`) - so this cell is BOTH
    // formula-guarded (prefixed with `'`) AND quoted (RFC 4180, contains
    // \r/\n), never left bare either way.
    expect(escapeCsvCell('\r\n')).toBe(`"'\r\n"`);
  });
});
