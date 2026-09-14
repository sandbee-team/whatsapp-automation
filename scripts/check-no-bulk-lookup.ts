import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-no-bulk-lookup.ts (P20 Unit U3, step 9) - mechanizes ADR 0017
 * Alternatives / scope-delta "Refused outright #2": bulk/list recipient
 * validation via WhatsApp membership lookup is refused, not deferred. The
 * ONLY sanctioned use is a manual, single-number, user-initiated send
 * lookup, and even that must never live under `modules/contacts/` (contacts
 * is the bulk-adjacent surface - any lookup call reachable from there is a
 * bulk-validation risk by construction, allow-listed or not).
 *
 * The token is built by concatenation (`['on', 'WhatsApp'].join('')`) so
 * this guard's own source never matches its own scan (same
 * self-referential trap `check-forbidden-mechanisms.ts` avoids for its own
 * ban list) - `scripts/check-no-bulk-lookup.ts` is also explicitly exempt
 * from clause (a), the way `FORBIDDEN_MECHANISM_EXEMPT_FILES` exempts
 * `check-forbidden-mechanisms.ts` from its own clause (a).
 *
 * THREE CLAUSES:
 *
 * (a) Any `\bonWhatsApp\b` match in a file NOT listed in
 *     `BULK_LOOKUP_ALLOWED_FILES` is a violation.
 * (b) ANY match under `app/backend/src/modules/contacts/` is a violation
 *     even if the file is allow-listed - contacts is where bulk validation
 *     would actually get called from, so it can never be the exception.
 * (c) A loop-feeding shape (`for (`, `for await`, `.forEach(`, `.map(`,
 *     `Promise.all(`, `while (`) within the 400 characters immediately
 *     BEFORE an `onWhatsApp(` call is a violation in EVERY file, allow-
 *     listed or not - "no loop over a list may feed it".
 */

const BULK_LOOKUP_TOKEN = ['on', 'WhatsApp'].join('');
const BULK_LOOKUP_PATTERN = new RegExp(`\\b${BULK_LOOKUP_TOKEN}\\b`);
const BULK_LOOKUP_CALL_PATTERN = new RegExp(`${BULK_LOOKUP_TOKEN}\\(`, 'g');

/**
 * Path -> reason. STARTS EMPTY - no manual-send lookup site exists in the
 * repo yet; the future single sanctioned site is added here with a reason
 * once it is built.
 */
export const BULK_LOOKUP_ALLOWED_FILES: Readonly<Record<string, string>> = Object.freeze({});

/** This guard's own source is exempt from clause (a) - it IS the ban list (see module doc). */
const NO_BULK_LOOKUP_EXEMPT_FILES: readonly string[] = Object.freeze([
  'scripts/check-no-bulk-lookup.ts',
]);

/** Any file under this prefix is a violation even if allow-listed (clause (b)). */
const CONTACTS_MODULE_PREFIX = 'app/backend/src/modules/contacts/';

const LOOP_FEEDING_SHAPES = ['for (', 'for await', '.forEach(', '.map(', 'Promise.all(', 'while ('];
const LOOP_LOOKBACK_WINDOW = 400;

export const NO_BULK_LOOKUP_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  // n1 (P20 C1 note n2): the public marketing site is a candidate surface
  // for a naive bulk-validation call just like admin/app - never assumed
  // safe merely because it is customer-facing rather than internal.
  'website/src/**/*.{ts,tsx}',
];

export interface SourceFile {
  path: string;
  content: string;
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function scanClauseA(file: SourceFile): GuardViolation[] {
  if (NO_BULK_LOOKUP_EXEMPT_FILES.includes(file.path)) return [];
  if (file.path in BULK_LOOKUP_ALLOWED_FILES) return [];
  if (file.path.startsWith(CONTACTS_MODULE_PREFIX)) return []; // clause (b) reports it separately.

  const match = BULK_LOOKUP_PATTERN.exec(file.content);
  if (!match) return [];

  return [
    {
      file: file.path,
      line: lineOfIndex(file.content, match.index),
      message:
        'bulk/list recipient validation via onWhatsApp is refused, not deferred ' +
        '(ADR 0017 Alternatives; scope delta Refused outright #2)',
    },
  ];
}

function scanClauseB(file: SourceFile): GuardViolation[] {
  if (NO_BULK_LOOKUP_EXEMPT_FILES.includes(file.path)) return [];
  if (!file.path.startsWith(CONTACTS_MODULE_PREFIX)) return [];

  const match = BULK_LOOKUP_PATTERN.exec(file.content);
  if (!match) return [];

  return [
    {
      file: file.path,
      line: lineOfIndex(file.content, match.index),
      message:
        'onWhatsApp is never reachable from modules/contacts/ - contacts is the ' +
        'bulk-adjacent surface, so it can never be the allow-listed exception ' +
        '(ADR 0017 Alternatives; scope delta Refused outright #2)',
    },
  ];
}

function scanClauseC(file: SourceFile): GuardViolation[] {
  if (NO_BULK_LOOKUP_EXEMPT_FILES.includes(file.path)) return [];

  const violations: GuardViolation[] = [];
  for (const match of file.content.matchAll(BULK_LOOKUP_CALL_PATTERN)) {
    if (match.index === undefined) continue;
    const windowStart = Math.max(0, match.index - LOOP_LOOKBACK_WINDOW);
    const window = file.content.slice(windowStart, match.index);
    const loopShape = LOOP_FEEDING_SHAPES.find((shape) => window.includes(shape));
    if (!loopShape) continue;

    violations.push({
      file: file.path,
      line: lineOfIndex(file.content, match.index),
      message: `no loop over a list may feed onWhatsApp - found "${loopShape}" ${String(match.index - windowStart)} chars before the call (ADR 0017 Alternatives; scope delta Refused outright #2)`,
    });
  }
  return violations;
}

/** Pure core - no filesystem access. */
export function scanNoBulkLookup(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of files) {
    violations.push(...scanClauseA(file));
    violations.push(...scanClauseB(file));
    violations.push(...scanClauseC(file));
  }
  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(NO_BULK_LOOKUP_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckNoBulkLookup(files?: string[]): GuardResult {
  const sourceFiles =
    files?.map((relativePath) => ({
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    })) ?? readSourceFiles();

  return { violations: scanNoBulkLookup(sourceFiles), filesScanned: sourceFiles.length };
}

function main(): void {
  const result = runCheckNoBulkLookup();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      const location =
        violation.line === undefined
          ? violation.file
          : `${violation.file}:${String(violation.line)}`;
      console.error(`check-no-bulk-lookup: ${location} - ${violation.message}`);
    }
    console.log(
      `check-no-bulk-lookup: ${String(result.filesScanned)} files scanned, ${String(result.violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`check-no-bulk-lookup: ${String(result.filesScanned)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
