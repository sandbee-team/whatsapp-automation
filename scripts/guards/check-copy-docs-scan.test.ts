import { describe, expect, it } from 'vitest';
import { COPY_GLOBS } from '../check-copy.js';
import { resolveFiles } from './scan-config.js';

/**
 * check-copy-docs-scan.test.ts (P25 Unit U5, step 8) - pins `docs/RUNBOOK.md`
 * and `docs/CONVENTIONS.md` into the copy guard's real file set. Split out of
 * `check-copy.test.ts` (which sits at the 300-line cap) - the runbook is copy
 * too: alert wording and operator procedures go through the same banned-claim
 * scan as every panel string.
 */
describe('check-copy docs scan (P25 Unit U5, step 8)', () => {
  it('docs_runbook_is_in_the_copy_scan', () => {
    const matchedFiles = resolveFiles(COPY_GLOBS);
    expect(matchedFiles).toContain('docs/RUNBOOK.md');
    expect(matchedFiles).toContain('docs/CONVENTIONS.md');
  });
});
