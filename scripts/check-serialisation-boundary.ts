import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-serialisation-boundary.ts (P07 Unit U1, step 3, twin of
 * check-role-boot.ts's skeleton) - `BufferJSON` (baileys' Buffer-aware JSON
 * replacer/reviver) must be imported by exactly ONE file in the whole
 * workspace: `app/backend/src/provider/baileys/auth-state/codec.ts` (see
 * that file's module doc comment - "THE single serialisation boundary").
 *
 * Two ways to fail:
 *   1. A scanned file OTHER than the boundary file imports/re-exports
 *      `BufferJSON` from `'baileys'` or `'@whiskeysockets/baileys'` - in ANY
 *      of three import shapes (WARNING-5, lesson 2026-08-26): a named import
 *      (`import { BufferJSON } from 'baileys'`), a namespace import combined
 *      with a `.BufferJSON` member access (`import * as X from 'baileys'` ...
 *      `X.BufferJSON`), or a default import combined with a `.BufferJSON`
 *      member access (`import X from 'baileys'` ... `X.BufferJSON`).
 *   2. ZERO scanned files import `BufferJSON` at all - the boundary file
 *      must exist; a guard matching nothing is not a guard (P00 lesson,
 *      see check-single-claim.ts's "non-zero scanned count" precedent).
 *
 * Scans `app/*|admin/*|packages/*` under `src/**\/*.ts`, EXCLUDING
 * `*.test.ts`/`*.test.tsx`/`*.integration.test.ts` - test files may
 * legitimately reference `BufferJSON`-shaped codecs (server-kit's P01 tests)
 * without tripping this guard, because they are never scanned in the first
 * place.
 */

export const BOUNDARY_FILE_PATH = 'app/backend/src/provider/baileys/auth-state/codec.ts';

export const SERIALISATION_BOUNDARY_GLOBS = [
  'app/*/src/**/*.ts',
  'admin/*/src/**/*.ts',
  'packages/*/src/**/*.ts',
];

const TEST_FILE_PATTERN = /(\.integration)?\.test\.tsx?$/;

/**
 * Matches a `BufferJSON` import or re-export from either baileys package
 * name, e.g.:
 *   import { BufferJSON } from 'baileys'
 *   import { BufferJSON as X } from '@whiskeysockets/baileys'
 *   export { BufferJSON } from 'baileys'
 *   export { BufferJSON as X } from '@whiskeysockets/baileys'
 * A bare text reference to the identifier `BufferJSON` with no such
 * import/re-export clause (e.g. a comment or an unrelated local symbol of
 * the same name) is intentionally NOT matched - this guard polices the
 * import boundary, not the identifier's mere presence in text.
 */
const BUFFERJSON_IMPORT_PATTERN =
  /\b(?:import|export)\s*\{[^}]*\bBufferJSON\b[^}]*\}\s*from\s*['"](?:baileys|@whiskeysockets\/baileys)['"]/;

/**
 * WARNING-5 (guard blind spot, lesson 2026-08-26): the named-import pattern
 * above misses two other realistic import shapes that still reach
 * `BufferJSON`:
 *
 *   1. A namespace import combined with a `.BufferJSON` member access in the
 *      SAME file, e.g. `import * as baileys from 'baileys'` ...
 *      `baileys.BufferJSON`.
 *   2. A default import with a `.BufferJSON` member access, e.g.
 *      `import baileys from 'baileys'` ... `baileys.BufferJSON`.
 *
 * Both patterns are matched as a PAIR (the import clause AND a later member
 * access using that same local binding name) - a namespace/default import of
 * baileys that never touches `.BufferJSON` at all must not trip this guard.
 */
const NAMESPACE_IMPORT_PATTERN =
  /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"](?:baileys|@whiskeysockets\/baileys)['"]/g;

const DEFAULT_IMPORT_PATTERN =
  /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"](?:baileys|@whiskeysockets\/baileys)['"]/g;

export interface SourceFile {
  path: string;
  content: string;
}

function memberAccessesBufferJson(content: string, localName: string): boolean {
  const pattern = new RegExp(`\\b${localName}\\s*\\.\\s*BufferJSON\\b`);
  return pattern.test(content);
}

function importsBufferJson(content: string): boolean {
  if (BUFFERJSON_IMPORT_PATTERN.test(content)) {
    return true;
  }

  for (const match of content.matchAll(NAMESPACE_IMPORT_PATTERN)) {
    const localName = match[1];
    if (localName && memberAccessesBufferJson(content, localName)) {
      return true;
    }
  }

  for (const match of content.matchAll(DEFAULT_IMPORT_PATTERN)) {
    const localName = match[1];
    if (localName && memberAccessesBufferJson(content, localName)) {
      return true;
    }
  }

  return false;
}

/** Pure core - no filesystem access. */
export function scanSerialisationBoundary(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  let importerCount = 0;

  for (const file of files) {
    if (!importsBufferJson(file.content)) continue;
    importerCount += 1;
    if (file.path !== BOUNDARY_FILE_PATH) {
      violations.push({
        file: file.path,
        message:
          `"${file.path}" imports BufferJSON from baileys - only "${BOUNDARY_FILE_PATH}" ` +
          'may do so (the single serialisation boundary, P07 Unit U1).',
      });
    }
  }

  if (importerCount === 0) {
    violations.push({
      file: BOUNDARY_FILE_PATH,
      message:
        'zero scanned files import BufferJSON from baileys - the serialisation boundary file ' +
        `("${BOUNDARY_FILE_PATH}") must exist and import it; a guard matching nothing is not a guard.`,
    });
  }

  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(SERIALISATION_BOUNDARY_GLOBS)
    .filter((relativePath) => !TEST_FILE_PATTERN.test(relativePath))
    .map((relativePath) => ({
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    }));
}

export function runCheckSerialisationBoundary(): GuardResult {
  const files = readSourceFiles();
  return { violations: scanSerialisationBoundary(files), filesScanned: files.length };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanSerialisationBoundary(files);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`serialisation-boundary: ${violation.file} - ${violation.message}`);
    }
    process.exit(1);
  }
  console.log(`serialisation-boundary: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
