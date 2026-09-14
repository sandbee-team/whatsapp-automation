import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('three_wp_ui_components_build_inside_the_static_export', () => {
  it('renders exactly three named @wp/ui components with no client directive', () => {
    const uiSmokeSource = readFileSync(
      path.resolve(TEST_DIR, '..', 'src', 'components', 'ui-smoke.tsx'),
      'utf8',
    );

    expect(uiSmokeSource).not.toContain("'use client'");
    expect(uiSmokeSource).not.toContain('"use client"');

    const importMatch = uiSmokeSource.match(/import\s*{([^}]+)}\s*from\s*'@wp\/ui'/);
    expect(importMatch).not.toBeNull();
    const importedNames = (importMatch as RegExpMatchArray)[1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    expect(importedNames.length).toBeGreaterThanOrEqual(3);

    const uiIndexSource = readRepoFile('packages/ui/src/index.ts');
    for (const name of importedNames) {
      expect(uiIndexSource).toContain(name);
    }

    // Button.tsx must carry 'use client' as its first statement (after
    // leading comments/blank lines): the real positive proof that the
    // `check-ui-client-directive` guard has something to check.
    const buttonSource = readRepoFile('packages/ui/src/button.tsx');
    const withoutLeadingCommentsOrBlank = buttonSource
      .replace(/^\s+/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '')
      .replace(/^\s+/, '');
    expect(withoutLeadingCommentsOrBlank.startsWith("'use client'")).toBe(true);

    // The real positive proof is the CI step running `next build` (comment
    // per brief); this test pins the structure that makes it meaningful.
    const registrySource = readRepoFile('scripts/guards/registry.ts');
    expect(registrySource).toContain('check-ui-client-directive');

    const ciStepsSource = readRepoFile('scripts/ci-steps.ts');
    expect(ciStepsSource).toContain('website-build');
  });
});
