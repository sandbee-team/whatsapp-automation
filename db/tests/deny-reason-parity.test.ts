import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENY_REASONS } from '@wp/domain';
import { describe, expect, it } from 'vitest';

/**
 * `deny_reason_parity_sql_vs_domain` - every deny label
 * `db/queries/pacing-deny-reason.sql` can return MUST exist in
 * `@wp/domain`'s `DENY_REASONS` union, which backs `DENY_REASON_EFFECTS`.
 *
 * WHY THIS TEST EXISTS (P13 close - a real crash, caught by a test written
 * to prove something else). `pacing-deny-reason.sql` had always been able to
 * return `'PLAN_CAP'`, but the label was unreachable dead code because
 * `client_daily_usage.sent_count` was never incremented, so the plan-cap
 * predicate could never deny. The C1 review's Finding 4 fixed the counter -
 * and the very first time the plan cap actually fired,
 * `engine/pacing/index.ts#reserve()` did:
 *
 *     const effect = DENY_REASON_EFFECTS[denyRow.reason];   // undefined
 *     resolveRetryAt({ rule: effect.retryAtRule, ... });    // TypeError
 *
 * i.e. a cap that enforces itself by CRASHING the send loop, leaving the job
 * claimed-then-abandoned with no deny reason and no advanced
 * `next_attempt_at` - the exact deny-and-requeue contract the pacing module
 * exists to provide. A unit test of the domain table alone cannot catch this
 * (both sides are internally consistent); only a cross-artifact parity check
 * can, which is why it lives here in `db/tests` (the `db` package may import
 * `@wp/domain`; `@wp/domain` may not read `db/queries/**`). Same shape and
 * same reasoning as `enum_parity_db_vs_domain` (blueprint mandatory test 23).
 *
 * This is a TEXT scan, deliberately: it needs no database, and the failure it
 * guards against is a label added to the SQL without a matching row in the
 * domain table - a diff-time mistake, not a runtime state.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DENY_REASON_SQL = path.join(REPO_ROOT, 'db', 'queries', 'pacing-deny-reason.sql');

/**
 * Pulls every single-quoted UPPER_SNAKE literal out of the statement body,
 * ignoring `--` comments (the header documents reasons in prose, and a
 * comment mention must not count as a returnable label).
 */
function denyLabelsInSql(sql: string): string[] {
  const body = sql
    .split('\n')
    .map((line) => {
      const commentAt = line.indexOf('--');
      return commentAt === -1 ? line : line.slice(0, commentAt);
    })
    .join('\n');

  const labels = new Set<string>();
  for (const match of body.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) {
    const label = match[1];
    if (label !== undefined) {
      labels.add(label);
    }
  }
  return [...labels].sort();
}

describe('deny-reason parity', () => {
  it('deny_reason_parity_sql_vs_domain', () => {
    const sql = readFileSync(DENY_REASON_SQL, 'utf8');
    const sqlLabels = denyLabelsInSql(sql);

    // Guard against the scan silently matching nothing (a vacuous pass) - the
    // statement is a CASE over every pacing predicate, so it always returns
    // several labels.
    expect(sqlLabels.length).toBeGreaterThan(5);

    const domainReasons = new Set<string>(DENY_REASONS);
    const missingFromDomain = sqlLabels.filter((label) => !domainReasons.has(label));

    expect(
      missingFromDomain,
      `db/queries/pacing-deny-reason.sql can return ${JSON.stringify(missingFromDomain)}, ` +
        'which has no row in @wp/domain DENY_REASON_EFFECTS - reserve() would throw a ' +
        'TypeError instead of deferring the job. Add the reason to packages/domain/src/' +
        'pacing/deny-reasons.ts in the same change.',
    ).toEqual([]);
  });
});
