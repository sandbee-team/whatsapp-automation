import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-ui-client-directive.ts (P05 step 3) - blueprint Surfaces section:
 * "Every interactive `@wp/ui` component carries `'use client'`; purely
 * presentational ones do not." Flags any `packages/ui/src/**\/*.tsx` file
 * that uses an interactive marker (state/effect hooks, DOM event handler
 * props) without `'use client';` as its first statement (leading comments
 * are allowed before the directive - only comments and whitespace may
 * precede it).
 *
 * `activatesIn: 'P05'` in the registry (see registry.ts): `packages/ui/src`
 * has no `.tsx` files yet as of this guard's introduction (U4 adds the
 * first components) - zero matches are tolerated while P05 is not `done`.
 */

const INTERACTIVE_MARKER_PATTERN =
  /\bonClick\b|\bonChange\b|\bonSubmit\b|\buseState\(|\buseEffect\(|\buseRef\(|\buseReducer\(|\bonKeyDown\b|\bonPointer\w*\b/;

const USE_CLIENT_DIRECTIVE = "'use client'";

export const UI_CLIENT_DIRECTIVE_GLOBS = ['packages/ui/src/**/*.tsx'];

export interface SourceFile {
  path: string;
  content: string;
}

/**
 * The directive must be the first STATEMENT: only comments (line/block) and
 * blank lines may precede it. Strips leading comments/whitespace, then
 * checks the first remaining token is the directive (single or double
 * quoted, with or without a trailing semicolon).
 */
function startsWithUseClientDirective(content: string): boolean {
  let rest = content;
  // Strip leading blank lines / block comments / line comments, in any order.
  let previousLength = -1;
  while (rest.length !== previousLength) {
    previousLength = rest.length;
    rest = rest.replace(/^\s+/, '');
    rest = rest.replace(/^\/\*[\s\S]*?\*\//, '');
    rest = rest.replace(/^\/\/[^\n]*\n?/, '');
  }
  return rest.startsWith(USE_CLIENT_DIRECTIVE) || rest.startsWith('"use client"');
}

export function scanUiClientDirective(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (!INTERACTIVE_MARKER_PATTERN.test(file.content)) {
      continue;
    }
    if (startsWithUseClientDirective(file.content)) {
      continue;
    }
    violations.push({
      file: file.path,
      line: 1,
      message:
        "interactive component missing a leading 'use client'; directive (blueprint: every interactive @wp/ui component carries 'use client')",
    });
  }

  return violations;
}

export function runCheckUiClientDirective(files: SourceFile[]): GuardResult {
  return { violations: scanUiClientDirective(files) };
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(UI_CLIENT_DIRECTIVE_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanUiClientDirective(files);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`check-ui-client-directive: ${violation.file} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(`check-ui-client-directive: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
