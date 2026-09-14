import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult } from './guards/scan-config.js';
import { scanSingleDebit } from './guards/single-debit-lib.js';
import type { SourceFile } from './guards/single-debit-lib.js';

/**
 * check-single-debit.ts (P18 Unit U7; U7b adds `wallet-signup-credit.sql`
 * as the fourth exempt file; P19 Unit U2 adds `wallet-credit.sql` as the
 * fifth) - enforces that `db/queries/debit-send.sql`,
 * `db/queries/refund-send.sql`, `db/queries/wallet-reconcile.sql`,
 * `db/queries/wallet-signup-credit.sql` and `db/queries/wallet-credit.sql`
 * are the ONLY statements in the system allowed to write
 * `wallet_accounts.balance_minor` or insert into `wallet_ledger` (core
 * invariant 3, idempotency at the storage layer; ADR 0019 §2). Modelled
 * directly on `check-single-reserve.ts` - same bounded-gap raw-SQL pattern,
 * same brace-balanced Drizzle scan, same exempt-path idiom.
 *
 * Scans TS/TSX source and every raw `.sql` file across the five ADR 0014
 * source trees (`app`, `admin`, `website`, `packages`, `db`) for THREE
 * independent bypass shapes:
 *
 *   1. Raw SQL `UPDATE wallet_accounts [alias] SET ... balance_minor = ...`
 *      (any case, any whitespace/newlines, bounded to one statement span) -
 *      in `.sql` files AND inside TS string/template literals.
 *   2. Raw SQL `INSERT INTO wallet_ledger` (word boundary - `wallet_ledger_
 *      ext_refs` is not a match).
 *   3. Drizzle `.update(walletAccounts)....set({ balanceMinor: ... })` and
 *      `.insert(walletLedger)`.
 *
 * The five sanctioned files are exempt by path. Test fixtures (`db/tests/**`,
 * `**\/__tests__/**`, `*.test.ts`) are exempt too - they seed ledger rows
 * directly as superuser. This guard's own three source files
 * (`single-debit-lib.ts`, this file, its test) never contain a banned token
 * as a contiguous literal (every table/column name is built by
 * concatenation in `single-debit-lib.ts`), so they cannot trip their own
 * scan without a path-based exemption.
 */

/** The five files allowed to write wallet_accounts.balance_minor or insert wallet_ledger rows. */
export const SINGLE_DEBIT_EXEMPT_PATHS = [
  'db/queries/debit-send.sql',
  'db/queries/refund-send.sql',
  'db/queries/wallet-reconcile.sql',
  // P18 Unit U7b: the signup-credit ledger row (ADR 0019 §1) - see that file's own header.
  'db/queries/wallet-signup-credit.sql',
  // P19 Unit U2: the guard-first credit statement (topup_manual/promo_credit/
  // adjustment_credit) - see that file's own header.
  'db/queries/wallet-credit.sql',
];

/** Same five ADR 0014 source trees, every raw `.sql` file under db/queries, db/migrations, db/seeds, db/tests. */
export const SINGLE_DEBIT_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'website/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'db/src/**/*.{ts,tsx}',
  'db/tests/**/*.{ts,tsx}',
  'db/schema/**/*.{ts,tsx}',
  'db/queries/**/*.sql',
  'db/migrations/**/*.sql',
  'db/seeds/**/*.sql',
  'db/tests/**/*.sql',
  'app/**/*.sql',
  'admin/**/*.sql',
  'infra/**/*.sql',
  'packages/**/*.sql',
  'website/**/*.sql',
];

function readSourceFiles(): SourceFile[] {
  return resolveFiles(SINGLE_DEBIT_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckSingleDebit(): GuardResult {
  const files = readSourceFiles();
  return {
    violations: scanSingleDebit(files, SINGLE_DEBIT_EXEMPT_PATHS),
    filesScanned: files.length,
  };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanSingleDebit(files, SINGLE_DEBIT_EXEMPT_PATHS);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `single-debit: ${violation.file}:${String(violation.line ?? '?')} - ${violation.message}`,
      );
    }
    console.log(
      `single-debit: ${String(files.length)} files scanned, ${String(violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`single-debit: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
