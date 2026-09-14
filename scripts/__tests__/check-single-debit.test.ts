import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runCheckSingleDebit,
  SINGLE_DEBIT_EXEMPT_PATHS,
  SINGLE_DEBIT_GLOBS,
} from '../check-single-debit.js';
import { scanSingleDebit } from '../guards/single-debit-lib.js';
import { REPO_ROOT, resolveFiles } from '../guards/scan-config.js';

/**
 * check-single-debit.ts (P18 Unit U7) - proves the guard flags any second
 * writer of `wallet_accounts.balance_minor` or `INSERT INTO wallet_ledger`
 * outside the three sanctioned files, across raw `.sql` files, TS/TSX string
 * literals, and Drizzle calls - modelled on check-single-claim.test.ts /
 * check-single-reserve's own fixtures, using inline SourceFile content
 * (planted directly in this file) rather than separate fixture files.
 */

describe('check-single-debit (P18 Unit U7)', () => {
  it('a_second_statement_updating_balance_minor_fails_the_guard', () => {
    const filePath = 'app/backend/src/modules/x/y.ts';
    const content = `
      export async function rogueDebit(clientId: string) {
        await pool.query(
          "UPDATE wallet_accounts SET balance_minor = balance_minor - 5 WHERE client_id = $1",
          [clientId],
        );
      }
    `;
    const violations = scanSingleDebit([{ path: filePath, content }], SINGLE_DEBIT_EXEMPT_PATHS);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(filePath);
  });

  it('a_planted_ledger_insert_in_a_raw_sql_file_is_rejected', () => {
    const filePath = 'db/queries/topup.sql';
    const content = `
      -- rogue topup, not one of the sanctioned three
      INSERT INTO wallet_ledger (client_id, amount_minor, kind)
      VALUES ($1, $2, 'topup');
    `;
    const violations = scanSingleDebit([{ path: filePath, content }], SINGLE_DEBIT_EXEMPT_PATHS);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('a_multiline_aliased_update_is_caught', () => {
    const filePath = 'db/queries/rogue-debit.sql';
    const content = `
      UPDATE wallet_accounts w SET
        balance_minor = balance_minor - $2,
        updated_at = now()
      WHERE w.client_id = $1;
    `;
    const violations = scanSingleDebit([{ path: filePath, content }], SINGLE_DEBIT_EXEMPT_PATHS);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('wallet_ledger_ext_refs_is_not_a_match', () => {
    const filePath = 'db/queries/ext-refs.sql';
    const content = `
      INSERT INTO wallet_ledger_ext_refs (ledger_id, external_ref)
      VALUES ($1, $2);
    `;
    const violations = scanSingleDebit([{ path: filePath, content }], SINGLE_DEBIT_EXEMPT_PATHS);

    expect(violations).toEqual([]);
  });

  it('the_five_sanctioned_files_are_exempt_and_the_same_content_elsewhere_is_not', () => {
    expect(SINGLE_DEBIT_EXEMPT_PATHS).toEqual([
      'db/queries/debit-send.sql',
      'db/queries/refund-send.sql',
      'db/queries/wallet-reconcile.sql',
      'db/queries/wallet-signup-credit.sql',
      'db/queries/wallet-credit.sql',
    ]);

    const content = `
      UPDATE wallet_accounts SET balance_minor = balance_minor - $2 WHERE client_id = $1;
      INSERT INTO wallet_ledger (client_id, amount_minor, kind) VALUES ($1, $2, 'debit');
    `;

    for (const exemptPath of SINGLE_DEBIT_EXEMPT_PATHS) {
      const violations = scanSingleDebit(
        [{ path: exemptPath, content }],
        SINGLE_DEBIT_EXEMPT_PATHS,
      );
      expect(violations).toEqual([]);
    }

    const rogueViolations = scanSingleDebit(
      [{ path: 'db/queries/debit-send-copy.sql', content }],
      SINGLE_DEBIT_EXEMPT_PATHS,
    );
    expect(rogueViolations.length).toBeGreaterThan(0);
  });

  it('a_drizzle_set_balance_minor_is_rejected', () => {
    const filePath = 'app/backend/src/modules/wallet/rogue.ts';
    const content = `
      await db
        .update(walletAccounts)
        .set({ balanceMinor: newBalance, updatedAt: new Date() })
        .where(eq(walletAccounts.clientId, clientId));
    `;
    const violations = scanSingleDebit([{ path: filePath, content }], SINGLE_DEBIT_EXEMPT_PATHS);

    expect(violations.some((violation) => violation.file === filePath)).toBe(true);
  });

  it('test_fixture_paths_are_exempt', () => {
    const filePath = 'db/tests/helpers/isolation-fixtures.ts';
    const content = `
      export async function seedLedgerRow(pool: Pool) {
        await pool.query("INSERT INTO wallet_ledger (client_id, amount_minor) VALUES ($1, $2)", [
          'client-1',
          100,
        ]);
      }
    `;
    const violations = scanSingleDebit([{ path: filePath, content }], SINGLE_DEBIT_EXEMPT_PATHS);

    expect(violations).toEqual([]);
  });

  it('an_empty_file_list_flags_nothing', () => {
    expect(scanSingleDebit([], SINGLE_DEBIT_EXEMPT_PATHS)).toEqual([]);
  });

  it('the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count', () => {
    const result = runCheckSingleDebit();

    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('resolving_single_debit_globs_actually_returns_files_under_db_tests', () => {
    const resolved = resolveFiles(SINGLE_DEBIT_GLOBS);

    expect(resolved.some((file) => file.startsWith('db/tests/'))).toBe(true);
  });

  it('this_guards_own_source_files_never_trip_the_scan', () => {
    const ownFiles = [
      {
        path: 'scripts/check-single-debit.ts',
        content: readFileSync(path.join(REPO_ROOT, 'scripts/check-single-debit.ts'), 'utf8'),
      },
      {
        path: 'scripts/guards/single-debit-lib.ts',
        content: readFileSync(path.join(REPO_ROOT, 'scripts/guards/single-debit-lib.ts'), 'utf8'),
      },
    ];

    expect(scanSingleDebit(ownFiles, SINGLE_DEBIT_EXEMPT_PATHS)).toEqual([]);
  });
});
