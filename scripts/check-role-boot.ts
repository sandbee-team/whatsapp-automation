import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-role-boot.ts (reviewer M5) - every non-migrate role entrypoint under
 * `app/backend/src/roles/**\/*.ts` (including any nested entrypoint, e.g.
 * `roles/api/index.ts`) must reference `assertDbPreconditionsOrExit`
 * (see `app/backend/src/platform/db/assert-db-preconditions.ts`'s doc
 * comment: "the one function every non-migrate role entrypoint calls before
 * serving any request"). A text scan for the identifier is enough - this
 * guard exists to catch a NEW role file that forgets the call, not to parse
 * call graphs (twin of `check-sql-lint.ts`'s pure-core + CLI shape).
 *
 * Only the TOP-LEVEL `app/backend/src/roles/migrate.ts` is exempt: the
 * migration runner boots the schema itself, so it necessarily runs before
 * `assertDbPreconditionsOrExit`'s schema-version and wallet-precondition
 * checks could mean anything. A nested `migrate.ts` (e.g.
 * `roles/api/migrate.ts`) is NOT exempt by name alone - only the one true
 * top-level entrypoint is.
 *
 * Today (P02) `app/backend/src/roles/` contains only `migrate.ts`, which is
 * exempt - so this guard scans 1 file and finds 0 violations, honestly. It
 * starts enforcing for real the moment a second role file (api.ts,
 * worker.ts, a nested `roles/api/index.ts`, ...) lands.
 */

export const ROLE_BOOT_GLOBS = ['app/backend/src/roles/**/*.ts'];

const EXEMPT_PATH = 'app/backend/src/roles/migrate.ts';
const REQUIRED_SYMBOL = 'assertDbPreconditionsOrExit';

export interface SourceFile {
  path: string;
  content: string;
}

function isExemptRoleFile(filePath: string): boolean {
  return filePath === EXEMPT_PATH;
}

/** Pure core - no filesystem access. */
export function scanRoleBoot(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (isExemptRoleFile(file.path)) continue;
    if (!file.content.includes(REQUIRED_SYMBOL)) {
      violations.push({
        file: file.path,
        message:
          `role entrypoint "${file.path}" never references ${REQUIRED_SYMBOL}() - every ` +
          'non-migrate role must assert DB preconditions before serving a request',
      });
    }
  }

  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(ROLE_BOOT_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckRoleBoot(): GuardResult {
  const files = readSourceFiles();
  return { violations: scanRoleBoot(files) };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanRoleBoot(files);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`role-boot: ${violation.file} - ${violation.message}`);
    }
    process.exit(1);
  }
  console.log(`role-boot: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
