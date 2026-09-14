import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-sql-lint.ts (MAJOR 4, core invariant 4: tenant isolation via the
 * shared SET/OFFSET bans) - scans raw SQL text under `db/**\/*.sql`
 * (queries, migrations, seeds) for the same two forbidden shapes the
 * ESLint guard already bans inside TS string/template literals
 * (`packages/config/eslint.config.js`'s `SET_ENTRIES`/`OFFSET_ENTRIES`):
 *
 *   - plain `SET ` (not `SET LOCAL ...` / `set_config(key, value, true)`) -
 *     transaction pooling makes a session-scoped SET a cross-tenant leak.
 *   - `OFFSET` pagination - lists are keyset-paginated, never offset-counted.
 *
 * The OFFSET_PATTERN below is this guard's intentional TWIN of
 * `OFFSET_ENTRIES[0].selector` in `packages/config/eslint.config.js`,
 * duplicated rather than imported: ESLint's `no-restricted-syntax` entries
 * are AST-selector strings scoped to a JS/TS `Literal`/`TemplateElement`
 * node's already-unescaped `.value`, not reusable `RegExp` objects - sharing
 * them directly with a plain-text `.sql` scanner is not practical. Keep the
 * two patterns in sync by hand if either changes. SET checking has diverged
 * from a plain regex twin - see the note above `findSetViolations`.
 *
 * `db/**\/*.sql` files exist today (db/migrations has real migrations 0001+)
 * - see the `sql-lint` guard registry entry (`scripts/guards/registry.ts`),
 * which no longer carries an `activatesIn` phase now that this guard matches
 * real files.
 *
 * SET is checked differently from OFFSET (P03 fix): a plain source-text
 * regex cannot tell a banned session-scoped `SET x = y` statement apart from
 * the `SET col = val` assignment clause of a conditional `UPDATE` statement
 * (the canonical claim pattern - .claude/rules/database.md, `db/queries/
 * claim-jobs.sql`) - both are literally the token "SET" preceded by
 * whitespace/newline. Unlike the ESLint twin (which scans opaque JS string
 * literals with no reliable statement structure to lean on), this scanner
 * reads real, fully-structured `.sql` files, so it can and does track SQL
 * statement structure instead of relying on a start/`;`/newline anchor - see
 * `findSetViolations` below.
 */

const SET_MESSAGE =
  'sql-lint/no-plain-set (twin of wp/no-plain-set): plain SET is banned in raw SQL - ' +
  'transaction pooling makes a session-scoped SET a cross-tenant leak. Accepted forms ' +
  'only: "SET LOCAL ..." and set_config(key, value, true).';

// The product-name-style token below is built by concatenation, not as a
// contiguous "OFFSET " literal, on purpose - mirrors check-copy.ts's
// PACING_FEATURE_TOKEN/BROADCAST_FEATURE_TOKEN comment: a contiguous
// "OFFSET " + whitespace literal would make this guard's own source file
// trip the ESLint OFFSET_ENTRIES selector it is the sql-lint twin of
// (`Literal[value=/\bOFFSET\s+/i]` also matches this message string, not
// just real query code) - a self-referential trap unrelated to real SQL.
const OFFSET_WORD = ['OFF', 'SET'].join('');
const OFFSET_MESSAGE =
  `sql-lint/no-offset-pagination (twin of wp/no-offset-pagination): ${OFFSET_WORD} ` +
  'pagination is banned in raw SQL - lists are keyset-paginated (WHERE id > $1 ORDER BY ' +
  'id LIMIT n), never counted by page offset.';

/** Twin of eslint.config.js's OFFSET_ENTRIES[0].selector value regex. */
const OFFSET_PATTERN = /\bOFFSET\s+/gi;

/**
 * Single left-to-right token pass over a `.sql` file's structure, used only
 * to decide whether a `SET` occurrence is a banned session-scoped statement
 * or the legitimate assignment clause of an `UPDATE` statement.
 *
 * Tracks, per paren-nesting depth, which DML/DDL statement is "open" at
 * that depth: the most recent depth-local leading keyword out of
 * WITH/SELECT/INSERT/UPDATE/DELETE/CREATE, reset to `undefined` at every
 * top-level `;` and pushed fresh on `(`/popped on `)`. A `SET` is a
 * violation only when the statement open at ITS OWN depth is neither
 * `UPDATE` nor `CREATE FUNCTION`/`CREATE PROCEDURE`:
 *
 *   - `WITH eligible AS (SELECT ... FOR UPDATE OF j SKIP LOCKED) UPDATE ...
 *     SET ...` (the claim shape, `db/queries/claim-jobs.sql`) is clean - the
 *     CTE's own SELECT closes with the paren before the outer UPDATE opens;
 *     `FOR UPDATE` is matched as one locking-clause token, never as the
 *     bare UPDATE keyword.
 *   - `CREATE FUNCTION ... SECURITY DEFINER SET search_path = ...` (the
 *     search_path-pinning pattern `db/migrations/0006` uses on every
 *     SECURITY DEFINER function) is clean - `SET` here is a per-invocation
 *     function attribute Postgres itself scopes and reverts around each
 *     call, the same class of safety `SET LOCAL` already gets elsewhere,
 *     not a persistent session-scoped leak. `FUNCTION`/`PROCEDURE` only
 *     upgrade the kind when the statement's own leading keyword was
 *     `CREATE` (an unrelated `ALTER FUNCTION ...` statement never gets this
 *     exemption, and has no SET clause to exempt anyway).
 *   - `ALTER TABLE ... SET (fillfactor = ...)` (table storage parameters -
 *     `db/migrations/0010`'s `whatsapp_instances` table already uses this
 *     shape) is clean (P03 close, note 12) - `SET` here reconfigures a
 *     table's on-disk storage parameters, a DDL attribute Postgres persists
 *     on the relation itself, not a session-scoped `SET` a pooled connection
 *     could leak to the next tenant. `ALTER` alone is NOT SET-exempt (P03
 *     close, finding 1): a bare `ALTER` exemption would also cover `ALTER
 *     ROLE ... SET search_path = ...` / `ALTER DATABASE ... SET ...`, which
 *     persist a cross-session default and are strictly worse than the plain
 *     session `SET` this guard exists to ban. `TABLE` is tracked the same
 *     way `FUNCTION`/`PROCEDURE` upgrade a `CREATE` kind: only when the
 *     statement's own leading keyword was `ALTER` does a following `TABLE`
 *     upgrade the kind to `ALTER_TABLE`, the one SET-exempt `ALTER` variant.
 *
 * A standalone `SET x = y;` anywhere - including right after an unrelated
 * UPDATE or CREATE FUNCTION statement's own `;` - still violates.
 *
 * A THIRD, statement-kind-independent exemption (P14 C5) handles `ALTER
 * TABLE ... ALTER COLUMN col SET NOT NULL, ALTER COLUMN col SET DEFAULT
 * ..., ...` (`db/migrations/0040`'s applied shape): each `ALTER COLUMN`
 * re-matches the bare `ALTER` keyword, downgrading the enclosing depth's
 * kind from `ALTER_TABLE` back to plain `ALTER` (not SET-exempt) before the
 * clause's own `SET` is reached - the kind tracker alone can't tell these
 * apart from a real `ALTER ROLE ... SET ...`. Rather than broaden the kind
 * heuristic (which would also swallow the `ALTER ROLE`/`ALTER DATABASE`
 * leaks this guard bans), `isColumnAttributeSet` below checks the token
 * immediately following `SET` against the fixed, exhaustive list of `ALTER
 * COLUMN` attribute forms - `NOT NULL`, `DEFAULT`, `DATA TYPE`,
 * `STATISTICS` - none of which can ever be `SET <name> = <value>` /
 * `SET <name> TO <value>` grammar, so it needs no statement-kind context
 * and can't be mistakenly widened to cover `ALTER ROLE`/`ALTER DATABASE`.
 *
 * Line comments (`-- ...`), single-quoted string literals, and
 * dollar-quoted bodies (`$$...$$` / `$tag$...$tag$`, e.g. a `DO $$ ... $$;`
 * block or a function's `AS $$ ... $$` body) are matched as opaque tokens
 * and skipped whole, so none of them can be mistaken for real top-level SQL
 * structure (a comment mentioning "SET", a string or procedural body
 * containing `(`/`)`/`;`/keywords of its own).
 */
const SET_TOKEN_PATTERN =
  /--[^\n]*|'(?:[^']|'')*'|\$(\w*)\$[\s\S]*?\$\1\$|\(|\)|;|\bFOR\s+UPDATE\b|\b(?:WITH|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|FUNCTION|PROCEDURE|TABLE)\b|\bSET\s+(?!LOCAL\b)/gi;

/** The fixed, exhaustive set of `ALTER COLUMN col SET <attribute>` forms - see the module doc above. */
const COLUMN_ATTRIBUTE_SET_FOLLOW_PATTERN = /^(?:NOT\s+NULL|DEFAULT\b|DATA\s+TYPE\b|STATISTICS\b)/i;

/** True when the `SET\s+` token ending at `afterSetIndex` is an `ALTER COLUMN ... SET <attribute>` DDL form, never a session-variable assignment. */
function isColumnAttributeSet(content: string, afterSetIndex: number): boolean {
  return COLUMN_ATTRIBUTE_SET_FOLLOW_PATTERN.test(content.slice(afterSetIndex));
}

const STATEMENT_KEYWORDS = new Set([
  'WITH',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
]);
const SET_EXEMPT_KINDS = new Set(['UPDATE', 'CREATE_FUNCTION', 'ALTER_TABLE']);

function findSetViolations(content: string): number[] {
  const indices: number[] = [];
  const kindStack: Array<string | undefined> = [undefined];
  const pattern = new RegExp(SET_TOKEN_PATTERN.source, SET_TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const text = match[0];
    const upper = text.toUpperCase();

    if (text.startsWith('--') || text.startsWith("'") || text.startsWith('$')) {
      // comment / string literal / dollar-quoted body - opaque, no
      // structural effect.
    } else if (text === '(') {
      kindStack.push(undefined);
    } else if (text === ')') {
      if (kindStack.length > 1) kindStack.pop();
    } else if (text === ';') {
      kindStack[kindStack.length - 1] = undefined;
    } else if (/^FOR\s+UPDATE$/i.test(text)) {
      // locking clause (`FOR UPDATE OF ... SKIP LOCKED`) - not a statement
      // keyword, must never flip the enclosing depth's kind to UPDATE.
    } else if (upper === 'FUNCTION' || upper === 'PROCEDURE') {
      if (kindStack[kindStack.length - 1] === 'CREATE') {
        kindStack[kindStack.length - 1] = 'CREATE_FUNCTION';
      }
    } else if (upper === 'TABLE') {
      if (kindStack[kindStack.length - 1] === 'ALTER') {
        kindStack[kindStack.length - 1] = 'ALTER_TABLE';
      }
    } else if (STATEMENT_KEYWORDS.has(upper)) {
      kindStack[kindStack.length - 1] = upper;
    } else {
      // The SET token itself.
      const currentKind = kindStack[kindStack.length - 1];
      const isExempt =
        SET_EXEMPT_KINDS.has(currentKind ?? '') ||
        isColumnAttributeSet(content, match.index + text.length);
      if (!isExempt) {
        indices.push(match.index);
      }
    }

    if (pattern.lastIndex === match.index) {
      pattern.lastIndex += 1;
    }
  }

  return indices;
}

/** `db/**\/*.sql` files (queries, migrations, seeds) - see the module doc above. */
export const SQL_LINT_GLOBS = [
  'db/queries/**/*.sql',
  'db/migrations/**/*.sql',
  'db/seeds/**/*.sql',
];

export interface SourceFile {
  path: string;
  content: string;
}

function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/** Same-length-whitespace masking of the module doc's opaque spans (comments, quoted strings, dollar bodies): keyword scans then see only executable SQL, and surviving matches keep their index/line (P17: a comment documenting compliance is not a violation). */
const OPAQUE_SPAN_PATTERN = /--[^\n]*|'(?:[^']|'')*'|\$(\w*)\$[\s\S]*?\$\1\$/g;
function maskOpaqueSql(content: string): string {
  return content.replace(OPAQUE_SPAN_PATTERN, (span) => span.replace(/[^\n]/g, ' '));
}

/** All match start indices for a global-flagged `pattern` in `content`. */
function matchIndices(content: string, pattern: RegExp): number[] {
  const indices: number[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    indices.push(match.index);
    if (re.lastIndex === match.index) {
      re.lastIndex += 1;
    }
  }
  return indices;
}

/** Pure core - no filesystem access. */
export function scanSqlLint(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    for (const index of findSetViolations(file.content)) {
      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, index),
        message: SET_MESSAGE,
      });
    }
    for (const index of matchIndices(maskOpaqueSql(file.content), OFFSET_PATTERN)) {
      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, index),
        message: OFFSET_MESSAGE,
      });
    }
  }

  return violations;
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(SQL_LINT_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckSqlLint(): GuardResult {
  const files = readSourceFiles();
  return { violations: scanSqlLint(files) };
}

function main(): void {
  const files = readSourceFiles();

  if (files.length === 0) {
    console.log(
      'sql-lint: 0 files scanned — db/**/*.sql files exist as of P02; this branch is a defensive leftover for an empty scan',
    );
    return;
  }

  const violations = scanSqlLint(files);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`sql-lint: ${violation.file}:${String(violation.line)} - ${violation.message}`);
    }
    process.exit(1);
  }
  console.log(`sql-lint: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
