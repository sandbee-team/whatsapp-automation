/**
 * module-graph.ts (P09 Unit U5, step 8) - a tiny, pure static import-graph
 * walker shared by `check-shutdown-purity.ts` and
 * `check-placement-neutrality.ts`. Deliberately hand-rolled rather than
 * `dependency-cruiser`: both guards need to walk a FIXED PAIR of roots
 * (`engine/fleet/drain.ts`, `engine/fleet/shed.ts`) and answer "can this
 * root's transitive relative-import graph reach X" over already-read file
 * content, so a fixture can inject a fake edge into a root file without
 * touching the real filesystem (dependency-cruiser's `cruise()` API needs a
 * real `baseDir` tree on disk - see `depcruise.test.ts`'s fixture-tree
 * idiom - which does not fit "one root file gains one new import line" as
 * cleanly as a pure in-memory graph).
 *
 * Only RELATIVE import specifiers (`./x`, `../x`) are resolved into further
 * graph nodes - that is the repo's own internal module graph. Bare
 * specifiers (`baileys`, `@wp/db`, ...) are never resolved to a file (they
 * are external packages); callers that need to detect a bare-specifier
 * import (e.g. the pinned `baileys` package) match `ImportEdge.specifier`
 * directly instead.
 */

const IMPORT_PATTERN =
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

export interface ModuleFile {
  /** Repo-relative, posix-separated path (e.g. "app/backend/src/engine/fleet/drain.ts"). */
  path: string;
  content: string;
}

export interface ImportEdge {
  /** The raw specifier text as written, e.g. "./foo.js", "../bar/baz.js", "baileys". */
  specifier: string;
  /** The resolved graph-node path, present only for relative specifiers that resolve inside `graph`. */
  resolvedPath?: string;
}

/** Extracts every import/export-from/require specifier in `content`, in source order. */
export function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const pattern = new RegExp(IMPORT_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Resolves a relative specifier (`./foo.js`, `../bar/baz.js`) against
 * `fromPath` (the importing file's own repo-relative path) into a
 * repo-relative path, trying the common TS/JS extension + index shapes
 * against the known `graph` keys. Returns `undefined` for a bare specifier
 * (no `./` or `../` prefix) or a relative specifier that resolves to
 * nothing in `graph` (external to the scanned subtree - e.g. a sibling
 * module this walker was not given).
 */
function resolveRelativeSpecifier(
  fromPath: string,
  specifier: string,
  graph: ReadonlyMap<string, string>,
): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return undefined;
  }

  const fromDir = fromPath.split('/').slice(0, -1);
  const parts = specifier.split('/');
  const stack = [...fromDir];
  for (const part of parts) {
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
    `${joined}/index.tsx`,
  ];

  for (const candidate of candidates) {
    if (graph.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** All import edges out of one file, relative-specifier ones carrying their resolved graph-node path when resolvable. */
export function importEdgesOf(file: ModuleFile, graph: ReadonlyMap<string, string>): ImportEdge[] {
  return extractImportSpecifiers(file.content).map((specifier) => ({
    specifier,
    resolvedPath: resolveRelativeSpecifier(file.path, specifier, graph),
  }));
}

export interface TraverseResult {
  /** Every graph-node path reached, INCLUDING the roots themselves. */
  visited: Set<string>;
  /** Every import edge seen anywhere in the traversal (roots + every reached node), bare specifiers included. */
  edges: ImportEdge[];
}

/**
 * Breadth-first walk of the relative-import graph starting at `roots`
 * (repo-relative paths, must be keys of `graph`). `graph` maps a
 * repo-relative path to that file's content - build it once from
 * already-read `ModuleFile[]` via `buildGraph`.
 */
export function traverseModuleGraph(
  roots: readonly string[],
  graph: ReadonlyMap<string, string>,
): TraverseResult {
  const visited = new Set<string>();
  const edges: ImportEdge[] = [];
  const queue: string[] = [...roots];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    const content = graph.get(current);
    if (content === undefined) continue;

    const fileEdges = importEdgesOf({ path: current, content }, graph);
    edges.push(...fileEdges);

    for (const edge of fileEdges) {
      if (edge.resolvedPath !== undefined && !visited.has(edge.resolvedPath)) {
        queue.push(edge.resolvedPath);
      }
    }
  }

  return { visited, edges };
}

/** Builds the `path -> content` map `traverseModuleGraph` walks, from an already-read file list. */
export function buildGraph(files: readonly ModuleFile[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.content]));
}
