import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * db/src/queries.ts (P03 Unit B, step 5; P18 U1 adds `loadNamedQuery`) - the
 * shared hand-written-SQL loader for `db/queries/*.sql`. Converts named
 * `$param` placeholders to pg positional binds (`$1..$n`) in memory; the
 * on-disk `.sql` file is never rewritten - it stays byte-exact (see
 * `db/queries/claim-jobs.sql`'s own canon-body comment). `loadQuery` is for
 * single-statement query files (one file, one statement); `loadNamedQuery`
 * is for a multi-statement file split into `-- name: <label>` sections (the
 * same marker convention `db/src/partitions.ts`'s own parser for
 * `ensure-partitions.sql` and `scripts/check-tenant-scope.ts`'s SQL-span
 * scanner already use), for files like `db/queries/wallet-reconcile.sql`
 * (P18) that hold several related statements together.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUERIES_DIR = path.resolve(HERE, '..', 'queries');

/** A loaded, positionally-bound query - `paramNames[i]` names bind `$${i + 1}`. */
export interface LoadedSqlQuery {
  /** File base name (no `.sql` extension), e.g. `"claim-jobs"`. */
  name: string;
  /** SQL text with `$1..$n` positional placeholders. */
  text: string;
  /** Ordered unique param names, by first occurrence in the source file. */
  paramNames: readonly string[];
}

/** Matches a named placeholder like `$client_id` - never `$1`, `$2`, ... (digits only after `$`). */
const NAMED_PARAM_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * FINDING-2 FIX (P13 C1 review): masks SQL `--` line comments, `/* ... *`+`/`
 * block comments, and `'...'` string literals (doubled `''` escape aware)
 * with equal-length whitespace, BEFORE `NAMED_PARAM_PATTERN` ever scans the
 * text - so a literal `$word` appearing only in prose (a header comment
 * explaining `$name`, or a quoted example) is never mistaken for a real
 * bind parameter. Without this, `db/queries/reserve-pacing.sql`'s own
 * header - which contains the literal example text `` `$name` `` while
 * documenting this very function - was harvested as a spurious FIRST bind
 * parameter, shifting every real positional bind by one for any caller
 * using this shared loader (only `modules/pacing/pacing.repo.ts`'s private,
 * duplicate `loadQueryStrippingComments` avoided the bug, by stripping
 * `--` comments only, and only for its own three query files).
 *
 * Equal-length replacement preserves every other character's byte offset,
 * so `text.replace` positions and any caller doing line/column diagnostics
 * on the ORIGINAL raw text stay valid. Newlines inside a masked span are
 * preserved (never collapsed) for the same reason.
 *
 * This is a deliberate MIRROR of `scripts/guards/single-claim-spans.ts`'s
 * `stripComments`/`literalSpans` (SQL comment syntax, not JS - `--`/`/* *`+`/`
 * here vs `//`/`/* *`+`/` there, plus SQL `'...'` string literals here vs JS
 * template/quote literals there), not a shared import: `db/src/queries.ts`
 * (package `@wp/db`) has no dependency edge onto `scripts/` (a standalone,
 * unreferenced root `tsc` project, not a workspace package `db` can import
 * from - see `.claude/rules/core-invariants.md`'s "Composite tsconfig"
 * note). Keep both in sync by hand if either's masking rule changes.
 */
const SQL_COMMENT_OR_STRING_PATTERN = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g;

function maskCommentsAndStrings(raw: string): string {
  return raw.replace(SQL_COMMENT_OR_STRING_PATTERN, (span) => span.replace(/[^\n]/g, ' '));
}

/**
 * Pure in-memory conversion: replaces every `$name` occurrence with its
 * positional bind (`$1`, `$2`, ...), assigning positions in first-occurrence
 * order. A name repeated later in the text reuses its first position -
 * matching pg's own semantics for a positional parameter used more than
 * once. Scans a COMMENT-AND-STRING-MASKED copy of `raw` (see
 * `maskCommentsAndStrings` above) so `$name`-shaped text inside a `--`/
 * `/* *`+`/` comment or a `'...'` string literal is never harvested as a
 * real bind parameter - the returned `text` is built from the ORIGINAL
 * `raw` (masking is scan-only, never applied to the SQL actually sent to
 * Postgres).
 */
export function convertNamedParams(raw: string): { text: string; paramNames: string[] } {
  const paramNames: string[] = [];
  const positions = new Map<string, number>();
  const masked = maskCommentsAndStrings(raw);
  let cursor = 0;
  let result = '';

  NAMED_PARAM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_PARAM_PATTERN.exec(masked)) !== null) {
    const name = match[1]!;
    let position = positions.get(name);
    if (position === undefined) {
      paramNames.push(name);
      position = paramNames.length;
      positions.set(name, position);
    }
    result += raw.slice(cursor, match.index) + `$${String(position)}`;
    cursor = match.index + match[0].length;
  }
  result += raw.slice(cursor);

  return { text: result, paramNames };
}

/**
 * Binds `params` (by name) to the positional array `query.text` expects -
 * `result[i]` is the value for `query.paramNames[i]` (bind `$${i + 1}`).
 * Throws if any required name is missing from `params`, rather than
 * silently binding `undefined` into a hot claim/send query.
 */
export function bindQueryParams(
  query: LoadedSqlQuery,
  params: Readonly<Record<string, unknown>>,
): unknown[] {
  return query.paramNames.map((name) => {
    if (!(name in params)) {
      throw new Error(
        `bindQueryParams: missing bind parameter "${name}" for query "${query.name}"`,
      );
    }
    return params[name];
  });
}

const cache = new Map<string, LoadedSqlQuery>();
const namedSectionsCache = new Map<string, Map<string, string>>();

/**
 * Matches a `-- name: <label>` section marker - the same convention used by
 * `db/queries/ensure-partitions.sql` and parsed by `db/src/partitions.ts`
 * and `scripts/check-tenant-scope.ts`. Labels may contain hyphens (unlike
 * `db/src/partitions.ts`'s own `\w+`-only parser), matching this loader's
 * `QUERY_NAME_PATTERN` kebab-case convention for file base names.
 */
const NAMED_SECTION_MARKER_PATTERN = /^-- name: (\w[\w-]*)\s*$/m;

/**
 * Pure split of a multi-statement `.sql` file's raw text into its named
 * `-- name: <label>` sections, keyed by label, value = the section body
 * (marker line excluded, trimmed). Header prose before the first marker is
 * ignored (it documents the file, it is not a statement). A file with no
 * markers at all yields an empty map.
 */
export function splitNamedSections(raw: string): Map<string, string> {
  const pattern = new RegExp(NAMED_SECTION_MARKER_PATTERN.source, 'gm');
  const markers: Array<{ index: number; end: number; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1];
    if (name) {
      markers.push({ index: match.index, end: match.index + match[0].length, name });
    }
  }

  const sections = new Map<string, string>();
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]!;
    const nextIndex = markers[i + 1]?.index ?? raw.length;
    sections.set(marker.name, raw.slice(marker.end, nextIndex).trim());
  }
  return sections;
}

async function loadNamedSections(fileName: string): Promise<Map<string, string>> {
  const cached = namedSectionsCache.get(fileName);
  if (cached) {
    return cached;
  }

  if (!QUERY_NAME_PATTERN.test(fileName)) {
    throw new Error(
      `loadNamedQuery: invalid file name "${fileName}" - must match ${String(QUERY_NAME_PATTERN)}`,
    );
  }

  const filePath = path.join(QUERIES_DIR, `${fileName}.sql`);
  const raw = await readFile(filePath, 'utf8');
  const sections = splitNamedSections(raw);
  namedSectionsCache.set(fileName, sections);
  return sections;
}

/**
 * Loads one `-- name: <sectionName>` section out of `db/queries/<fileName>
 * .sql`, converting its named params to positional binds - same conversion
 * `loadQuery` applies, scoped to just that section's body. Cached per
 * `(fileName, sectionName)` for the life of the process. Throws a clear
 * error when the file has no section with that name.
 */
export async function loadNamedQuery(
  fileName: string,
  sectionName: string,
): Promise<LoadedSqlQuery> {
  const cacheKey = `${fileName}:${sectionName}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sections = await loadNamedSections(fileName);
  const body = sections.get(sectionName);
  if (body === undefined) {
    throw new Error(
      `loadNamedQuery: db/queries/${fileName}.sql has no "-- name: ${sectionName}" section`,
    );
  }

  const { text, paramNames } = convertNamedParams(body);
  const query: LoadedSqlQuery = { name: cacheKey, text, paramNames };
  cache.set(cacheKey, query);
  return query;
}

/**
 * `name` is joined straight into a filesystem path below (`QUERIES_DIR/
 * <name>.sql`) - unvalidated, a name like `"../../secrets/whatever"` could
 * escape `db/queries/` entirely (P03 close, note 9). Query names in this
 * codebase are always a plain kebab-case file base name (`"claim-jobs"`),
 * so this is deliberately narrow, not a general path-traversal denylist.
 */
const QUERY_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Loads `db/queries/<name>.sql`, converting its named params to positional
 * binds. Cached per `name` for the life of the process - the file is read
 * from disk at most once.
 */
export async function loadQuery(name: string): Promise<LoadedSqlQuery> {
  if (!QUERY_NAME_PATTERN.test(name)) {
    throw new Error(
      `loadQuery: invalid query name "${name}" - must match ${String(QUERY_NAME_PATTERN)}`,
    );
  }

  const cached = cache.get(name);
  if (cached) {
    return cached;
  }

  const filePath = path.join(QUERIES_DIR, `${name}.sql`);
  const raw = await readFile(filePath, 'utf8');
  const { text, paramNames } = convertNamedParams(raw);

  const query: LoadedSqlQuery = { name, text, paramNames };
  cache.set(name, query);
  return query;
}
