import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * logout-call-sites.test.ts (P08 U1 step 3) - a static scan asserting every
 * `sock.logout(`-shaped call site in `app/backend/src` lives inside
 * `provider/baileys/adapter.ts` (the one legal call site - `unlink()`,
 * P08 U6 - per ADR 0013 constraint 6 / CLAUDE.md: "sock.logout() may exist
 * ONLY in provider/baileys/adapter.ts#unlink").
 *
 * Scoped to the METHOD-CALL form `.logout(` (a real Baileys socket call, or
 * any future `x.logout()` shaped call) rather than the bare token `logout(`
 * - the codebase already has an unrelated `identity` module function named
 * `logout()` (session/auth logout, nothing to do with Baileys) whose own
 * declaration and call sites would otherwise false-positive this guard. The
 * `.` prefix is what distinguishes "call a `.logout()` method on some
 * object" (the Baileys/provider-evasion risk this guards against) from
 * "call the free function named logout" (unrelated, already covered by its
 * own module's tests).
 *
 * `adapter.ts` does not exist yet (P08 U1) - zero occurrences today also
 * passes, per the task spec; this test's allow-list is exactly that one
 * path so a future U6 adapter stays legal and any other occurrence fails.
 */

const ALLOWED_RELATIVE_PATH = join('provider', 'baileys', 'adapter.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');
/**
 * This guard file itself is excluded from its own scan: its doc comment and
 * string-literal pattern (`'.logout('`) legitimately contain the scanned
 * token as DATA describing the check, not a real call site - self-scanning
 * a guard for the literal string it greps for is a standard false-positive
 * class (see `scripts/guards`' own fixture/guard-file exclusions).
 */
const SELF_PATH = join('provider', 'baileys', 'logout-call-sites.test.ts');

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

interface Occurrence {
  file: string;
  line: number;
}

/** Recursively collects every `.ts` file under `root` (no node_modules/dist to walk here - this is app/backend/src only). */
function collectTsFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function findLogoutCallSites(): Occurrence[] {
  const files = collectTsFiles(SRC_ROOT);
  const occurrences: Occurrence[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (line.includes('.logout(')) {
        occurrences.push({
          file: relative(SRC_ROOT, file).split(sep).join('/'),
          line: index + 1,
        });
      }
    });
  }

  return occurrences;
}

describe('sock_logout_appears_only_in_the_unlink_path', () => {
  it('every .logout( call site is within provider/baileys/adapter.ts', () => {
    const occurrences = findLogoutCallSites();
    const allowedPosix = ALLOWED_RELATIVE_PATH.split(sep).join('/');
    const selfPosix = SELF_PATH.split(sep).join('/');

    const illegal = occurrences.filter((o) => o.file !== allowedPosix && o.file !== selfPosix);

    expect(illegal).toEqual([]);
  });
});
