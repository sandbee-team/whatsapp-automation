import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * cron-loop-shape.test.ts (P12 Unit U4, step 7) - `the_loops_never_touch_
 * sockets_or_leases`, asserted STRUCTURALLY: from the cron role's own
 * composition roots (`roles/cron.ts`, `engine/cron/cron-wiring.ts`), the
 * transitive RELATIVE-import graph must never reach `provider/**` (the
 * socket/pairing layer this process owns no connection to) or
 * `engine/session/**` (the lease-owning session engine) - a mock-that-was-
 * never-called would only prove "this test didn't call it", not "this code
 * CAN'T reach it"; a dependency-direction assertion over the real import
 * graph is the honest version (same idiom as `scripts/check-shutdown-
 * purity.ts`/`scripts/check-placement-neutrality.ts`, whose shared
 * `scripts/guards/module-graph.ts` walker cannot be imported here directly:
 * `app/backend/tsconfig.json`'s `rootDir: "src"` rejects any import outside
 * `app/backend/src` with TS6059/TS6307 - `tsc -b`'s composite-project
 * boundary, not a stylistic choice - so this file re-implements the same
 * small relative-import walk locally instead of reaching across it).
 */

const IMPORT_PATTERN =
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// app/backend/src/engine/cron -> app/backend/src
const SRC_ROOT = path.resolve(HERE, '..', '..');

function listAllTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listAllTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** repo-relative-to-src-root path, posix-separated, no extension normalisation beyond what's already on disk. */
function toSrcRelative(absPath: string): string {
  return path.relative(SRC_ROOT, absPath).split(path.sep).join('/');
}

function resolveRelativeSpecifier(
  fromSrcRelative: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return undefined;
  }
  const fromDir = fromSrcRelative.split('/').slice(0, -1);
  const stack = [...fromDir];
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  const candidates = [
    joined,
    joined.replace(/\.js$/, '.ts'),
    joined.replace(/\.js$/, '.tsx'),
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}/index.ts`,
  ];
  return candidates.find((candidate) => knownPaths.has(candidate));
}

const ROOTS = ['roles/cron.ts', 'engine/cron/cron-wiring.ts'];
const BANNED_PREFIXES = ['provider/', 'engine/session/'];

describe('the cron loops never touch sockets or leases', () => {
  it('roles_cron_and_cron_wiring_never_reach_provider_or_engine_session', () => {
    const allFiles = listAllTsFiles(SRC_ROOT);
    const contentByPath = new Map<string, string>();
    for (const absPath of allFiles) {
      contentByPath.set(toSrcRelative(absPath), readFileSync(absPath, 'utf8'));
    }
    const knownPaths = new Set(contentByPath.keys());

    expect(ROOTS.every((root) => knownPaths.has(root))).toBe(true);

    const visited = new Set<string>();
    const queue = [...ROOTS];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);

      const content = contentByPath.get(current);
      if (content === undefined) continue;

      const pattern = new RegExp(IMPORT_PATTERN.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined) continue;
        const resolved = resolveRelativeSpecifier(current, specifier, knownPaths);
        if (resolved !== undefined && !visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }

    const violations = [...visited].filter((nodePath) =>
      BANNED_PREFIXES.some((prefix) => nodePath.startsWith(prefix)),
    );

    expect(violations).toEqual([]);
  });
});
