/**
 * scheduler-named-queries-lib.ts (P18 U8b) - `loadNamedQuery('<file>',
 * '<section>')` support for `scheduler-queries-lib.ts`, split out purely for
 * that file's own max-lines cap (same split idiom as
 * `session-worker-discovery-wiring.ts`). A multi-statement `.sql` file
 * (`db/queries/wallet-reconcile.sql`) mixes bounded cross-tenant scans with
 * per-tenant upsert/insert sections - `resolveNamedSectionText` scopes
 * `hasLimitClause`/`isInherentlySingleRow` to ONE section's own text, never
 * the whole file, so one section's LIMIT can never cover for another
 * section's missing one.
 */

export interface SourceFile {
  path: string;
  content: string;
}

/** Matches `loadNamedQuery('file', 'section')` / with double quotes - `db/src/queries.ts`'s multi-statement-file loader. */
const LOAD_NAMED_QUERY_CALL_PATTERN =
  /\bloadNamedQuery\(\s*(['"])([a-z0-9-]+)\1\s*,\s*(['"])([\w-]+)\3\s*\)/g;

export interface NamedQueryRef {
  file: string;
  section: string;
}

/** Extracts every distinct `(file, section)` pair a module's source text passes to `loadNamedQuery(...)`, in first-occurrence order. */
export function extractLoadedNamedQueryRefs(content: string): NamedQueryRef[] {
  const refs: NamedQueryRef[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  LOAD_NAMED_QUERY_CALL_PATTERN.lastIndex = 0;
  while ((match = LOAD_NAMED_QUERY_CALL_PATTERN.exec(content)) !== null) {
    const file = match[2]!;
    const section = match[4]!;
    const key = `${file}:${section}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ file, section });
    }
  }
  return refs;
}

/**
 * Matches a `-- name: <label>` section marker - mirrors `db/src/queries.ts`'s
 * own `splitNamedSections` exactly (that function cannot be imported here:
 * `scripts/` has no dependency edge onto `@wp/db`, same class of restriction
 * as `db/src/queries.ts`'s own header explains for the reverse direction).
 */
const NAMED_SECTION_MARKER_PATTERN = /^-- name: (\w[\w-]*)\s*$/gm;

/**
 * Splits `sqlFile.content` into its `-- name: <label>` sections and returns
 * just `sectionName`'s own body text (marker line excluded) - `undefined`
 * when no section with that name exists. Used to scope `hasLimitClause`/
 * `isInherentlySingleRow` to THAT section only, not the whole multi-statement
 * file (a file like `wallet-reconcile.sql` mixes bounded scans with the
 * per-tenant upsert/insert sections, which must never be flagged against
 * each other's LIMIT).
 */
export function resolveNamedSectionText(
  sqlFile: SourceFile,
  sectionName: string,
): string | undefined {
  const markers: Array<{ index: number; end: number; name: string }> = [];
  let match: RegExpExecArray | null;
  NAMED_SECTION_MARKER_PATTERN.lastIndex = 0;
  while ((match = NAMED_SECTION_MARKER_PATTERN.exec(sqlFile.content)) !== null) {
    const name = match[1];
    if (name) {
      markers.push({ index: match.index, end: match.index + match[0].length, name });
    }
  }

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]!;
    if (marker.name !== sectionName) continue;
    const nextIndex = markers[i + 1]?.index ?? sqlFile.content.length;
    return sqlFile.content.slice(marker.end, nextIndex).trim();
  }
  return undefined;
}
