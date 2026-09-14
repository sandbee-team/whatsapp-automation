/**
 * scheduler-queries-lib.ts (P16 gap-closer, item 1) - pure core for
 * check-scheduler-queries.ts, split out to keep the guard file itself
 * mechanically thin (same "pattern/helper module + thin guard file" split as
 * health-writers-lib.ts / single-reserve-lib.ts).
 *
 * The invariant (scope-delta row 4): "CI check: no query in the scheduler
 * module without a LIMIT". A "scheduler module" here means one of the
 * SCHEDULER_LOOP_MODULES pinned paths - the periodic, unbounded-fleet-size
 * scan loops (ADR 0018 S4: no singleton loop may be O(active instances)).
 * Every `.sql` file one of those modules reaches via `loadQuery('<name>')`
 * that can return more than one row (a real SCAN, see
 * `isInherentlySingleRow`) must contain a `LIMIT` clause OR a bounded-batch
 * bind parameter passed to a delegated definer function (see
 * `hasLimitClause`) - string-level checks, matching every other guard's own
 * "read the .sql file's text" idiom (see check-sql-lint.ts).
 */

import {
  extractLoadedNamedQueryRefs,
  resolveNamedSectionText,
} from './scheduler-named-queries-lib.js';
import type { SourceFile } from './scheduler-named-queries-lib.js';

export type { SourceFile };

/** Matches `loadQuery('some-name')` / `loadQuery("some-name")` - the only two quote styles used in this codebase (see db/src/queries.ts's own QUERY_NAME_PATTERN for the name shape). */
const LOAD_QUERY_CALL_PATTERN = /\bloadQuery\(\s*(['"])([a-z0-9-]+)\1\s*\)/g;

/** Extracts every distinct query name a module's source text passes to `loadQuery(...)`, in first-occurrence order. */
export function extractLoadedQueryNames(content: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  LOAD_QUERY_CALL_PATTERN.lastIndex = 0;
  while ((match = LOAD_QUERY_CALL_PATTERN.exec(content)) !== null) {
    const name = match[2]!;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Case-insensitive presence check for a bounded-scan marker anywhere in a
 * `.sql` file's raw text - a string-level check, same proportionate idiom as
 * check-sql-lint.ts's own heuristics for a fail-safe CI guard.
 *
 * TWO accepted shapes, both established conventions in this repo's
 * `db/queries/*.sql` files:
 *   1. a literal `LIMIT` keyword in this file's own statement (e.g.
 *      `health-due.sql`'s `ORDER BY eval_due_at ASC LIMIT $max_rows`).
 *   2. a bounded-batch bind parameter (`$max_rows` / `$p_limit` / `$limit`)
 *      passed into a delegated SECURITY DEFINER scan function (e.g.
 *      `discover-instances.sql`'s `wp_lease_scan_unowned($stale_ms,
 *      $max_rows)`, `reap-expired-leases.sql`'s `wp_reap_expired_leases
 *      ($grace_seconds, $limit)`) - the bound is enforced INSIDE the
 *      function body (verified once per such file at the time this guard
 *      was written), not by a `LIMIT` clause in this wrapper statement
 *      itself.
 */
export function hasLimitClause(sqlText: string): boolean {
  if (/\blimit\b/i.test(sqlText)) return true;
  return /\$(?:max_rows|p_limit|limit)\b/i.test(sqlText);
}

/**
 * True when `sqlText`'s `WHERE` clause contains at least one `<col> =
 * $param` key-equality predicate AND no `IN (SELECT ...)` batch-membership
 * predicate anywhere in the statement. `instance-mark-infra-unavailable.sql`'s
 * `WHERE id = $instance_id AND client_id = $client_id AND deleted_at IS
 * NULL AND (...)` is the canonical shape - the extra idempotency guard
 * predicates do not change that this statement is keyed to at most one row
 * by `id`. `health-due.sql`'s `WHERE instance_id IN (SELECT ...)` is NOT
 * (Fix 2, P16 fix round: an `IN (SELECT ...)` predicate scans/claims a SET
 * of rows sized by the subquery, not one keyed row - exempting it let a
 * LIMIT deletion inside that subquery slip past this guard undetected).
 */
function isKeyEqualityPointWrite(sqlText: string): boolean {
  if (/\bin\s*\(\s*select\b/i.test(sqlText)) return false;
  const whereMatch = /\bwhere\b([\s\S]*?)(?:\breturning\b|;|$)/i.exec(sqlText);
  if (!whereMatch) return false;
  const whereClause = whereMatch[1]!.trim();
  if (whereClause.length === 0) return false;
  return /\b[a-z_][a-z0-9_]*\s*=\s*\$[a-z0-9_]+(?:::\w+)?/i.test(whereClause);
}

/**
 * True when `sqlText` is a `WITH ...` chain whose FIRST CTE is a keyed point
 * read/write (an `UPDATE`/`INSERT ... SELECT`/bare `SELECT` body containing
 * a `<col> = $param` equality, same predicate shape `isKeyEqualityPointWrite`
 * accepts, and no `IN (SELECT ...)` batch-membership subquery anywhere), and
 * every SUBSEQUENT CTE's own `FROM`/`JOIN` targets are either a previously
 * defined CTE name or the SAME keyed table the chain started from - never an
 * unqualified scan of a fresh table. This is the guard-first debit idiom
 * (`debit-send.sql`'s `debit-send`, `wallet-reconcile.sql`'s
 * `wallet-adjustment-debit`): `job`/`guard`/`acct`/`ins` CTEs, each keyed off
 * the ONE `$attempt`/`$client`-scoped row the first CTE selected, chained
 * via `FROM <priorCte>` - by construction, at most one row flows through the
 * whole statement.
 */
function isKeyedCteChain(sqlText: string): boolean {
  if (/\bin\s*\(\s*select\b/i.test(sqlText)) return false;

  const cteNames = new Set<string>();
  const ctePattern = /\b([a-z_][a-z0-9_]*)\s+AS\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = ctePattern.exec(sqlText)) !== null) {
    cteNames.add(match[1]!.toLowerCase());
  }
  if (cteNames.size === 0) return false;

  // The first CTE must itself be a keyed equality point read/write - the
  // same predicate shape isKeyEqualityPointWrite checks for a bare
  // UPDATE/DELETE, applied to the first CTE's own body text. Its own
  // FROM/JOIN targets (e.g. debit-send.sql's `job` CTE: `FROM send_attempts
  // a JOIN message_jobs j`) are real tables, not CTE names - validated here
  // by the equality-keyed WHERE check instead, and excluded from the
  // "subsequent CTEs only reference prior CTEs" scan below by index.
  const firstCteMatch = /\bWITH\s+[a-z_][a-z0-9_]*\s+AS\s*\(([\s\S]*?)\)\s*,/i.exec(sqlText);
  const firstCteBody = firstCteMatch?.[1];
  if (!firstCteBody || !isKeyEqualityPointWrite(firstCteBody)) return false;
  const remainderAfterFirstCte = sqlText.slice(
    (firstCteMatch.index ?? 0) + firstCteMatch[0].length,
  );

  // Every SUBSEQUENT CTE's FROM/JOIN target must be a previously-defined CTE
  // name - never a fresh, unqualified table scan.
  const fromJoinPattern = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi;
  let target: RegExpExecArray | null;
  while ((target = fromJoinPattern.exec(remainderAfterFirstCte)) !== null) {
    const name = target[1]!.toLowerCase().split('.').pop()!;
    if (!cteNames.has(name)) return false;
  }

  return true;
}

/**
 * True when `sqlText` cannot return more than one row BY CONSTRUCTION, so
 * the "no query without a LIMIT" invariant (a fleet-size-scaling SCAN must
 * be bounded, ADR 0018 S4) does not apply to it:
 *
 *   - a single conditional point write (`UPDATE`/`INSERT`/`DELETE ...
 *     WHERE id = $instance_id AND client_id = $client_id`, e.g.
 *     `instance-mark-infra-unavailable.sql`) - keyed by equality predicates
 *     only, never an `IN (SELECT ...)` batch-membership subquery (Fix 2,
 *     see `isKeyEqualityPointWrite` above).
 *   - a `SELECT` with no top-level `FROM` clause (e.g. `fleet-gauges.sql`'s
 *     `SELECT (subquery) AS unowned_count, (subquery) AS
 *     desired_online_count` - each projected column is itself a bounded
 *     aggregate subquery, and the outer statement always returns EXACTLY
 *     one row).
 *   - a `WITH ...` guard-first debit chain keyed throughout by the same
 *     `$attempt`/`$client` equality (see `isKeyedCteChain` above).
 *
 * A `SELECT ... FROM ...` (with or without a nested subquery of its own) is
 * NEVER exempt here - that shape's row count scales with the matched table,
 * exactly the case this guard exists to bound. An `UPDATE`/`DELETE` whose
 * `WHERE` contains an `IN (SELECT ...)` subquery is likewise NEVER exempt -
 * it is a BATCH write (`health-due.sql`, `health-samples-retention.sql`),
 * and must instead satisfy `hasLimitClause` via that subquery's own LIMIT.
 */
export function isInherentlySingleRow(sqlText: string): boolean {
  const withoutComments = sqlText.replace(/--[^\n]*/g, ' ');
  const firstKeywordMatch = /\b(SELECT|UPDATE|INSERT|DELETE|WITH)\b/i.exec(withoutComments);
  if (!firstKeywordMatch) return false;
  const leading = firstKeywordMatch[1]!.toUpperCase();

  if (leading === 'INSERT') {
    return true;
  }
  if (leading === 'UPDATE' || leading === 'DELETE') {
    return isKeyEqualityPointWrite(withoutComments);
  }
  if (leading === 'SELECT') {
    return !hasTopLevelFrom(withoutComments);
  }
  // WITH ... leads into a CTE chain - exempt only when every CTE is keyed
  // off the same point row (isKeyedCteChain); a chain that scans a fresh
  // table anywhere is never exempt.
  return isKeyedCteChain(withoutComments);
}

/**
 * True when a `FROM` keyword appears at paren-nesting depth 0 - i.e. in the
 * OUTER statement itself, not only inside a parenthesized subquery
 * (`fleet-gauges.sql`'s own two `(SELECT count(*) FROM ...)` subqueries each
 * have their OWN `FROM`, but it is nested one paren deep, never at depth 0).
 */
function hasTopLevelFrom(sqlText: string): boolean {
  let depth = 0;
  const pattern = /\(|\)|\bFROM\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sqlText)) !== null) {
    const token = match[0];
    if (token === '(') {
      depth += 1;
    } else if (token === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      return true;
    }
  }
  return false;
}

export interface SchedulerQueryViolation {
  module: string;
  queryName: string;
  queryPath: string;
  message: string;
}

export const UNBOUNDED_QUERY_MESSAGE_PREFIX =
  'check-scheduler-queries: a scheduler-loop module loads a .sql file with no LIMIT clause - ' +
  'ADR 0018 S4 (no singleton loop may be O(active instances)/unbounded)';

/**
 * Pure core - no filesystem access. `modules` are the pinned scheduler-loop
 * source files (already read); `queriesByName` resolves a loaded query name
 * to its `.sql` SourceFile (already read) - `undefined` when the guard's own
 * fixture/tree scan could not find that file (reported as its own
 * violation, never silently skipped).
 */
export function scanSchedulerQueries(
  modules: readonly SourceFile[],
  queriesByName: ReadonlyMap<string, SourceFile>,
): SchedulerQueryViolation[] {
  const violations: SchedulerQueryViolation[] = [];

  for (const module of modules) {
    const queryNames = extractLoadedQueryNames(module.content);
    for (const queryName of queryNames) {
      const query = queriesByName.get(queryName);
      if (!query) {
        violations.push({
          module: module.path,
          queryName,
          queryPath: `db/queries/${queryName}.sql`,
          message: `${UNBOUNDED_QUERY_MESSAGE_PREFIX} - db/queries/${queryName}.sql not found`,
        });
        continue;
      }
      if (!isInherentlySingleRow(query.content) && !hasLimitClause(query.content)) {
        violations.push({
          module: module.path,
          queryName,
          queryPath: query.path,
          message: `${UNBOUNDED_QUERY_MESSAGE_PREFIX}: ${query.path}`,
        });
      }
    }

    const namedRefs = extractLoadedNamedQueryRefs(module.content);
    for (const ref of namedRefs) {
      const query = queriesByName.get(ref.file);
      const queryPath = `db/queries/${ref.file}.sql`;
      if (!query) {
        violations.push({
          module: module.path,
          queryName: `${ref.file}:${ref.section}`,
          queryPath,
          message: `${UNBOUNDED_QUERY_MESSAGE_PREFIX} - ${queryPath} not found`,
        });
        continue;
      }
      const sectionText = resolveNamedSectionText(query, ref.section);
      if (sectionText === undefined) {
        violations.push({
          module: module.path,
          queryName: `${ref.file}:${ref.section}`,
          queryPath: query.path,
          message: `${UNBOUNDED_QUERY_MESSAGE_PREFIX} - ${query.path} has no "-- name: ${ref.section}" section`,
        });
        continue;
      }
      if (!isInherentlySingleRow(sectionText) && !hasLimitClause(sectionText)) {
        violations.push({
          module: module.path,
          queryName: `${ref.file}:${ref.section}`,
          queryPath: query.path,
          message: `${UNBOUNDED_QUERY_MESSAGE_PREFIX}: ${query.path} section "${ref.section}"`,
        });
      }
    }
  }

  return violations;
}
