import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * wallet-gate-source-scan.integration.test.ts (P19 Unit U3, split from
 * `wallet-gate.integration.test.ts` at the max-lines cap - same idiom as
 * `session-worker-discovery-wiring.ts`) - a pure static source scan, no DB
 * needed: proves the ADR 0019 S4 wallet-STOP GATE predicate (the claim
 * eligibility check `w.balance_minor >= w.max_rate_minor`) exists ONLY in
 * `db/queries/claim-jobs.sql` and is never re-derived or re-checked as a
 * gating predicate anywhere else (core invariant: every eligibility
 * predicate lives INSIDE the one claim statement). Named `*.integration.
 * test.ts` (not `*.test.ts`) purely so it stays co-located with its sibling
 * under `app/backend/vitest.config.ts`'s claimed pattern and env - it needs
 * no real Postgres/Redis itself.
 *
 * KNOWN, LEGITIMATE OTHER USES OF THE COLUMN NAME (excluded below, not
 * silently ignored): every statement that mutates `wallet_accounts.
 * balance_minor` (`debit-send.sql`, `refund-send.sql`, `wallet-credit.sql`,
 * `wallet-reconcile.sql`) also references `max_rate_minor` - as the
 * THRESHOLD in that same statement's own post-mutation `wallet_accounts.
 * state` CASE derivation (e.g. `balance_minor - rate < max_rate_minor THEN
 * 'empty'`). That is `wallet_accounts` computing its OWN resulting state
 * after a balance change - the same value the claim gate later reads - not
 * a second copy of the claim's eligibility check; every balance-mutating
 * statement in this repo re-derives `state` this same way, by design, so
 * `state` never drifts out of sync with `balance_minor` between mutations.
 * A literal "the column name appears nowhere else" assertion would false-
 * positive on this legitimate, distinct usage - reported here rather than
 * silently narrowing the scan to make the test pass.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const KNOWN_STATE_DERIVATION_FILES = new Set([
  'debit-send.sql',
  'refund-send.sql',
  'wallet-credit.sql',
  'wallet-reconcile.sql',
]);

describe('wallet gate predicates are declared exactly once', () => {
  it('the_wallet_predicates_exist_only_in_claim_jobs_sql', () => {
    const dbSourceRoot = path.join(REPO_ROOT, 'db');
    const claimJobsPath = path.join(dbSourceRoot, 'queries', 'claim-jobs.sql');
    const claimJobsText = readFileSync(claimJobsPath, 'utf8');
    expect(claimJobsText).toContain('max_rate_minor');

    // Scan every OTHER db/queries/*.sql file (excluding the known legitimate
    // wallet-state-derivation writers above) for the wallet predicate column
    // name - it must appear nowhere else as a gating predicate.
    const queriesDir = path.join(dbSourceRoot, 'queries');
    const otherQueryFiles = readdirSync(queriesDir).filter(
      (name) =>
        name.endsWith('.sql') &&
        name !== 'claim-jobs.sql' &&
        !KNOWN_STATE_DERIVATION_FILES.has(name),
    );
    expect(otherQueryFiles.length).toBeGreaterThan(0);
    for (const fileName of otherQueryFiles) {
      const text = readFileSync(path.join(queriesDir, fileName), 'utf8');
      expect(text, `db/queries/${fileName} must not reference max_rate_minor`).not.toContain(
        'max_rate_minor',
      );
    }

    // Pacing engine/source files - the wallet gate must not be re-derived or
    // re-checked in application code either.
    const pacingDir = path.join(REPO_ROOT, 'app', 'backend', 'src', 'engine', 'pacing');
    const pacingFiles = readdirSync(pacingDir).filter((name) => name.endsWith('.ts'));
    expect(pacingFiles.length).toBeGreaterThan(0);
    for (const fileName of pacingFiles) {
      const text = readFileSync(path.join(pacingDir, fileName), 'utf8');
      expect(text, `engine/pacing/${fileName} must not reference max_rate_minor`).not.toContain(
        'max_rate_minor',
      );
    }
  });
});
