import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { TERMINAL_IMPORT_REASONS } from './import-runner-terminal.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * import-runner-terminal.test.ts (P20 C1 M3) - `TERMINAL_IMPORT_REASONS` is
 * EXACTLY the four closed strings, and `import-runner-batch.ts` never writes
 * one of them at a per-record `row_no` (row 0 is the only sentinel any of
 * them may ever land at - see `import-runner-terminal.ts`'s own header).
 */

describe('TERMINAL_IMPORT_REASONS', () => {
  it('is_exactly_the_four_closed_strings', () => {
    expect(TERMINAL_IMPORT_REASONS).toEqual([
      'max_contacts_exceeded',
      'source_object_missing',
      'parse_error',
      'unexpected_error',
    ]);
  });

  it('import_runner_batch_never_writes_a_terminal_reason_at_a_per_record_row_no', () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const batchSource = readFileSync(path.join(dirname, 'import-runner-batch.ts'), 'utf8');

    // Strip block comments (`/** ... */`) before scanning - the module doc
    // legitimately NAMES `max_contacts_exceeded` in prose (explaining why
    // `InsertableErrorRow.reason` is wider than the per-record `InvalidReason`
    // union); only actual CODE (a `reason:`-shaped literal outside a comment)
    // may never carry a terminal reason at a per-record `row_no`.
    const codeOnly = batchSource.replace(/\/\*\*[\s\S]*?\*\//g, '');

    for (const reason of TERMINAL_IMPORT_REASONS) {
      expect(codeOnly.includes(`'${reason}'`)).toBe(false);
    }
  });
});
