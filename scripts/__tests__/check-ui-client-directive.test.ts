import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheckUiClientDirective } from '../check-ui-client-directive.js';
import { REPO_ROOT } from '../guards/scan-config.js';
import type { SourceFile } from '../check-ui-client-directive.js';

const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'scripts',
  'guards',
  '__fixtures__',
  'ui-client-directive',
);

function readFixture(name: string): SourceFile {
  return {
    path: `packages/ui/src/${name}`,
    content: readFileSync(path.join(FIXTURES_DIR, name), 'utf8'),
  };
}

describe('check-ui-client-directive (P05 step 3)', () => {
  it('an_interactive_component_missing_the_directive_is_a_violation', () => {
    const result = runCheckUiClientDirective([readFixture('missing-directive.tsx')]);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('an_interactive_component_with_the_directive_is_clean', () => {
    const result = runCheckUiClientDirective([readFixture('with-directive.tsx')]);
    expect(result.violations).toEqual([]);
  });

  it('a_presentational_component_needs_no_directive', () => {
    const result = runCheckUiClientDirective([readFixture('presentational.tsx')]);
    expect(result.violations).toEqual([]);
  });
});
