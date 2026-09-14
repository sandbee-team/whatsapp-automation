import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-no-raw-hex.ts (P05 step 3) - raw-CSS-colour guard. ADR 0007 / the
 * blueprint's Surfaces section: "a raw hex inside `packages/ui` is a lint
 * error" - extended here to every shipped frontend surface (`app`, `admin`,
 * `website`), because a hand-typed colour anywhere outside
 * `packages/design-tokens` (the only place colours may live) breaks the
 * single visual contract the token system exists to guarantee.
 *
 * Two independent match shapes, both scanned line-by-line:
 *
 *   (a) a raw hex colour literal - `#` followed by exactly 3, 4, 6, or 8 hex
 *       digits, immediately followed by a non-word character (so `#ff0000`
 *       matches but `#ff0000g` or a longer run does not). Lines containing
 *       `getElementById`, `href=`, or `url(#` are allow-listed wholesale -
 *       these are the three real shapes a `#fragment`/DOM-id lookup takes in
 *       this codebase (`document.getElementById('#root')`, `href="#main"`,
 *       an SVG `url(#gradient-id)`), and none of them is a colour.
 *   (b) a `rgb(`/`rgba(`/`hsl(`/`oklch(` function-call colour literal,
 *       anywhere outside `packages/design-tokens/**` (excluded from
 *       `RAW_HEX_GLOBS` by construction - it is the one place these values
 *       are defined).
 *
 * This is a pragmatic heuristic, not a CSS parser - documented here so a
 * future false positive/negative can be triaged against the rule as
 * written, not against an assumed "real" CSS-colour grammar.
 */

/** Hex colour: `#` + 3/4/6/8 hex digits, followed by a non-word boundary. */
const HEX_COLOUR_PATTERN =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b(?!-)/g;

/** Allow-listed non-colour `#` shapes: DOM id lookups, href fragments, SVG `url(#id)` references. */
const HEX_ALLOWLIST_LINE_PATTERN = /getElementById|href\s*=|url\(#/;

/** CSS colour function literals - legal only inside packages/design-tokens (excluded from these globs). */
const COLOUR_FUNCTION_PATTERN = /\b(?:rgba?|hsla?|oklch)\(/;

/** The four shipped frontend surfaces' TS/TSX/CSS - packages/design-tokens is deliberately NOT included. */
export const RAW_HEX_GLOBS = [
  'packages/ui/src/**/*.{ts,tsx,css}',
  'app/*/src/**/*.{ts,tsx,css}',
  'admin/*/src/**/*.{ts,tsx,css}',
  'website/src/**/*.{ts,tsx,css}',
];

/** Exempt file shapes: tests, fixtures, and generated router codegen. */
const EXEMPT_PATTERNS = [/\.test\./, /__fixtures__\//, /routeTree\.gen\.ts$/];

export interface SourceFile {
  path: string;
  content: string;
}

function isExempt(filePath: string): boolean {
  return EXEMPT_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function scanNoRawHex(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (isExempt(file.path)) continue;

    const lines = file.content.split('\n');
    lines.forEach((line, index) => {
      if (HEX_ALLOWLIST_LINE_PATTERN.test(line)) {
        return;
      }

      // `matchAll` (not a single `.exec()` call) so a line with MULTIPLE
      // distinct colour literals reports one violation PER MATCH, not just
      // the first - `HEX_COLOUR_PATTERN` carries the `g` flag `matchAll`
      // requires, and (unlike a manual `exec`-in-a-loop) needs no
      // `lastIndex` bookkeeping since `matchAll` always starts a fresh scan.
      for (const hexMatch of line.matchAll(HEX_COLOUR_PATTERN)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message: `raw hex colour "${hexMatch[0]}" - colours must live only in packages/design-tokens`,
        });
      }

      if (COLOUR_FUNCTION_PATTERN.test(line)) {
        violations.push({
          file: file.path,
          line: index + 1,
          message:
            'raw CSS colour function literal - colours must live only in packages/design-tokens',
        });
      }
    });
  }

  return violations;
}

export function runCheckNoRawHex(files: SourceFile[]): GuardResult {
  return { violations: scanNoRawHex(files) };
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(RAW_HEX_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanNoRawHex(files);

  if (violations.length > 0) {
    for (const violation of violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-no-raw-hex: ${location} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(`check-no-raw-hex: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
