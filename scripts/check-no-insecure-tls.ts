import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-no-insecure-tls.ts (P15 Unit U3) - the build-time half of the SSRF
 * guard: `safe-fetch.ts`'s own certificate verification is worthless if
 * anything in the tree can disable it. Fails the build on either
 * `rejectUnauthorized: false` (Node's TLS/HTTPS escape hatch) or
 * `NODE_TLS_REJECT_UNAUTHORIZED` (the process-wide env-var escape hatch)
 * appearing OUTSIDE test fixtures/test files.
 *
 * Reference failure this exists to prevent: evolution-api's SSRF check
 * (`webhook.controller.ts:20-23`) was simply commented out with no guard to
 * catch the regression - this script is that guard, for the TLS-bypass
 * class specifically.
 *
 * Two independent match shapes, scanned line-by-line (same idiom as
 * `check-no-raw-hex.ts`):
 *   (a) `rejectUnauthorized` followed by `:` and `false` (whitespace
 *       tolerant) - the TLS/HTTPS client option;
 *   (b) the literal `NODE_TLS_REJECT_UNAUTHORIZED` identifier anywhere -
 *       reading OR setting this env var at any point disables verification
 *       process-wide, so both directions are treated as violations.
 *
 * Exemptions: `.test.ts(x)`/`.spec.ts(x)` files, anything under a
 * `__fixtures__/` directory, and THIS file itself (its own doc comment and
 * pattern source text would otherwise self-match).
 */

const REJECT_UNAUTHORIZED_FALSE_PATTERN = /rejectUnauthorized\s*:\s*false/;
const NODE_TLS_REJECT_ENV_PATTERN = /NODE_TLS_REJECT_UNAUTHORIZED/;

/** The tree this guard scans - source only, matching the other check-* guards' scope. */
export const INSECURE_TLS_GLOBS = [
  'app/**/*.{ts,tsx,mjs,cjs,js}',
  'admin/**/*.{ts,tsx,mjs,cjs,js}',
  'website/**/*.{ts,tsx,mjs,cjs,js}',
  'packages/**/*.{ts,tsx,mjs,cjs,js}',
  'db/**/*.{ts,tsx,mjs,cjs,js}',
  'scripts/**/*.{ts,tsx,mjs,cjs,js}',
];

const EXEMPT_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /__fixtures__\//,
  /check-no-insecure-tls\.ts$/,
];

export interface SourceFile {
  path: string;
  content: string;
}

function isExempt(filePath: string): boolean {
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function scanNoInsecureTls(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (isExempt(file.path)) continue;

    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      if (REJECT_UNAUTHORIZED_FALSE_PATTERN.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'rejectUnauthorized: false disables TLS certificate verification - never permitted',
        });
      }
      if (NODE_TLS_REJECT_ENV_PATTERN.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'NODE_TLS_REJECT_UNAUTHORIZED disables TLS certificate verification process-wide - never permitted',
        });
      }
    });
  }

  return violations;
}

export function runCheckNoInsecureTls(files: SourceFile[]): GuardResult {
  return { violations: scanNoInsecureTls(files) };
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(INSECURE_TLS_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanNoInsecureTls(files);

  if (violations.length > 0) {
    const filesWithViolations = new Set(violations.map((v) => v.file));
    for (const violation of violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-no-insecure-tls: ${location} - ${violation.message}`);
    }
    console.error(
      `check-no-insecure-tls: ${String(filesWithViolations.size)} file(s) with violations, ${String(
        violations.length,
      )} total`,
    );
    process.exit(1);
  }

  console.log(`check-no-insecure-tls: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
