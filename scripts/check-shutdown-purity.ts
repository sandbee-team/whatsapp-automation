import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import { buildGraph, traverseModuleGraph } from './guards/module-graph.js';
import type { ModuleFile } from './guards/module-graph.js';

/**
 * check-shutdown-purity.ts (P09 Unit U5, step 8, mandatory test 11) -
 * structurally proves the drain/shed shutdown path can never delete
 * credentials or unlink the device.
 *
 * Canonical drain sequence (blueprint verbatim, see drain.ts's own header
 * comment): stop grabbing -> stop claiming -> wait <=20s for in-flight sends
 * (anything still in flight -> needs_reconcile) -> flush saveCreds ->
 * sock.end() on every session (NEVER logout(); the shutdown path structurally
 * cannot import unlink()) -> release every lease -> close pools -> exit 0.
 *
 * From the two roots, walks the transitive RELATIVE-import graph (see
 * `module-graph.ts`) and fails if it reaches:
 *   (a) any module under `app/backend/src/provider/baileys/**` - the
 *       socket/pairing layer. The repo's ONLY legal `sock.logout()` call
 *       site lives at `provider/baileys/adapter.ts` (see
 *       `logout-call-sites.test.ts`) - the shutdown path must never be able
 *       to reach it at all, legal call site or not.
 *   (b) any reached file whose content calls `logout(` or `unlink(` (incl.
 *       `fs.unlink`/`node:fs`'s `unlink`) - the point is the shutdown path
 *       structurally cannot delete creds or unlink the device.
 *   (c) the pinned `baileys` package (or `@whiskeysockets/baileys`) imported
 *       directly, bypassing the provider boundary.
 *
 * The two roots satisfy this today (they are port-injected by design) - this
 * guard must PASS on the real tree with a non-zero scanned count.
 */

export const SHUTDOWN_PURITY_ROOTS = [
  'app/backend/src/engine/fleet/drain.ts',
  'app/backend/src/engine/fleet/shed.ts',
] as const;

export const SHUTDOWN_PURITY_GLOBS = ['app/backend/src/**/*.{ts,tsx}'];

const PROVIDER_BAILEYS_PREFIX = 'app/backend/src/provider/baileys/';
const BAILEYS_PACKAGE_SPECIFIERS = new Set(['baileys', '@whiskeysockets/baileys']);
const FORBIDDEN_CALL_PATTERN = /\b(?:logout|unlink)\s*\(/;

/**
 * Blanks `//` and `/* *‍/` comments (preserving every other character's
 * index and every newline), same shape as `check-tenant-scope.ts`'s
 * `stripComments` (not exported there, so re-implemented here rather than
 * editing a file outside this unit's scope fence) - a doc comment like
 * "never `sock.logout()`" must never itself trip `FORBIDDEN_CALL_PATTERN`.
 */
function stripComments(content: string): string {
  let out = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '`' || ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = content[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += content[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < n && content[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        out += content[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function readSourceFiles(): ModuleFile[] {
  return resolveFiles(SHUTDOWN_PURITY_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

/** Pure core - no filesystem access. `files` must include the roots plus enough of the graph to resolve their relative imports. */
export function scanShutdownPurity(
  files: readonly ModuleFile[],
  roots: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const graph = buildGraph(files);
  const contentByPath = graph;

  const presentRoots = roots.filter((root) => graph.has(root));
  const { visited, edges } = traverseModuleGraph(presentRoots, graph);

  for (const edge of edges) {
    if (BAILEYS_PACKAGE_SPECIFIERS.has(edge.specifier)) {
      violations.push({
        file: presentRoots.join(', '),
        message: `shutdown path imports the pinned baileys package directly ("${edge.specifier}") - it must stay port-injected, never reach the socket layer itself`,
      });
    }
  }

  for (const nodePath of visited) {
    if (nodePath.startsWith(PROVIDER_BAILEYS_PREFIX)) {
      violations.push({
        file: nodePath,
        message: `shutdown path reaches "${nodePath}" under provider/baileys/** - the socket/pairing layer must never be reachable from drain/shed`,
      });
    }

    const content = contentByPath.get(nodePath);
    const codeOnly = content !== undefined ? stripComments(content) : undefined;
    if (codeOnly !== undefined && FORBIDDEN_CALL_PATTERN.test(codeOnly)) {
      const match = FORBIDDEN_CALL_PATTERN.exec(codeOnly);
      violations.push({
        file: nodePath,
        message: `shutdown path reaches "${nodePath}", which calls ${match ? match[0] : 'logout(/unlink('} - the shutdown path structurally cannot delete creds or unlink the device`,
      });
    }
  }

  return violations;
}

export function runCheckShutdownPurity(): GuardResult {
  const files = readSourceFiles();
  return {
    violations: scanShutdownPurity(files, SHUTDOWN_PURITY_ROOTS),
    filesScanned: files.length,
  };
}

function main(): void {
  const result = runCheckShutdownPurity();

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`shutdown-purity: ${violation.file} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(`shutdown-purity: ${String(result.filesScanned ?? 0)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
