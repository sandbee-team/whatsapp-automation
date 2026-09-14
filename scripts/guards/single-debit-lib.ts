import { literalSpans, stripComments } from './single-claim-spans.js';
import type { GuardViolation } from './scan-config.js';

/**
 * single-debit-lib.ts (P18 Unit U7) - pure scan core for
 * `check-single-debit.ts`. Modelled directly on `single-reserve-lib.ts`:
 * same comment/literal-span sanitizer (reused unchanged via
 * `single-claim-spans.js`, not re-implemented), same bounded-gap UPDATE...SET
 * pattern idiom, same brace-balanced Drizzle scan. See
 * `check-single-debit.ts`'s own header for the three bypass shapes this
 * guard bans and why `db/queries/debit-send.sql`, `db/queries/refund-send.sql`
 * and `db/queries/wallet-reconcile.sql` are the only sanctioned writers
 * (core invariant 3; ADR 0019 section 2).
 */

export interface SourceFile {
  path: string;
  content: string;
}

export const SANCTIONED_FILES_MESSAGE =
  'the only sanctioned writers are debit-send.sql / refund-send.sql / wallet-reconcile.sql ' +
  '(core invariant 3; ADR 0019 §2)';

const BALANCE_MINOR_COLUMN = ['balance', '_minor'].join('');
const WALLET_ACCOUNTS_TABLE = ['wallet', '_accounts'].join('');
const WALLET_LEDGER_TABLE = ['wallet', '_ledger'].join('');

const WALLET_ACCOUNTS_TOKEN = new RegExp(`\\b${WALLET_ACCOUNTS_TABLE}\\b|\\bwalletAccounts\\b`);

/**
 * Shape 1: `UPDATE wallet_accounts [alias] SET ... balance_minor = ...`,
 * bounded to one statement span (never crosses `WHERE` or `;`) - identical
 * bounded-gap idiom to `single-reserve-lib.ts`'s COLUMN_WRITE_PATTERN, just
 * retargeted at wallet_accounts.balance_minor. An optional single alias
 * token between the table name and SET is allowed (`w SET`, not required).
 */
const DEBIT_UPDATE_PATTERN = new RegExp(
  `\\bUPDATE\\b\\s+${WALLET_ACCOUNTS_TABLE}\\b(?:\\s+\\w+)?[^;]*?\\bSET\\b(?:(?!\\bWHERE\\b)[^;])*?\\b${BALANCE_MINOR_COLUMN}\\s*=`,
  'i',
);

/** Shape 2: `INSERT INTO wallet_ledger` - word boundary excludes wallet_ledger_ext_refs. */
const LEDGER_INSERT_PATTERN = new RegExp(`\\bINSERT\\s+INTO\\s+${WALLET_LEDGER_TABLE}\\b`, 'i');

export function sanitizeForBoundedScan(text: string): string {
  return text.replace(/--[^\n]*|'(?:[^']|'')*'/g, (span) =>
    span.startsWith('--') ? ' '.repeat(span.length) : span.replace(/;/g, ' '),
  );
}

export function hasDebitUpdate(text: string): boolean {
  if (!WALLET_ACCOUNTS_TOKEN.test(text)) return false;
  return DEBIT_UPDATE_PATTERN.test(sanitizeForBoundedScan(text));
}

export function hasLedgerInsert(text: string): boolean {
  return LEDGER_INSERT_PATTERN.test(text);
}

/**
 * Shape 3: Drizzle `.update(walletAccounts)...set({ ... balanceMinor: ... })`
 * (brace-balanced, top-level key only - mirrors
 * `findDrizzleSecondReserveSetBrace`) and `.insert(walletLedger)`.
 */
const DRIZZLE_UPDATE_SET_PATTERN = /\bupdate\s*\(\s*walletAccounts\s*\)[^;]*?\.set\s*\(\s*\{/gi;
const DRIZZLE_INSERT_LEDGER_PATTERN = /\binsert\s*\(\s*walletLedger\s*\)/gi;

function objectLiteralHasBalanceMinorKey(text: string, openBraceIndex: number): boolean {
  let depth = 0;
  let topLevelText = '';
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) topLevelText += ch;
  }
  return new RegExp(`\\bbalanceMinor\\s*:`).test(topLevelText);
}

export function findDrizzleDebitSetBrace(content: string): number | undefined {
  const pattern = new RegExp(DRIZZLE_UPDATE_SET_PATTERN.source, DRIZZLE_UPDATE_SET_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const braceIndex = match.index + match[0].length - 1;
    if (objectLiteralHasBalanceMinorKey(content, braceIndex)) return braceIndex;
  }
  return undefined;
}

export function findDrizzleLedgerInsert(content: string): number | undefined {
  const pattern = new RegExp(
    DRIZZLE_INSERT_LEDGER_PATTERN.source,
    DRIZZLE_INSERT_LEDGER_PATTERN.flags,
  );
  const match = pattern.exec(content);
  return match === undefined || match === null ? undefined : match.index;
}

export function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

const EXEMPT_SUFFIXES = ['db/tests/', '__tests__/'];

export function isExemptDebitPath(filePath: string, exemptFiles: readonly string[]): boolean {
  if (exemptFiles.includes(filePath)) return true;
  if (filePath.endsWith('.test.ts')) return true;
  return EXEMPT_SUFFIXES.some((prefix) => filePath.includes(prefix));
}

/**
 * Pure core - no filesystem access. `.sql` files are checked whole-content;
 * every other file is checked per string/template-literal span (comments
 * stripped first), mirroring `scanSingleReserveColumns`.
 */
export function scanSingleDebit(
  files: SourceFile[],
  exemptPaths: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (isExemptDebitPath(file.path, exemptPaths)) continue;

    if (file.path.endsWith('.sql')) {
      if (hasDebitUpdate(file.content)) {
        violations.push({ file: file.path, message: debitMessage('raw SQL UPDATE') });
      }
      if (hasLedgerInsert(file.content)) {
        violations.push({ file: file.path, message: debitMessage('raw SQL INSERT') });
      }
      continue;
    }

    for (const span of literalSpans(file.content)) {
      if (hasDebitUpdate(span.text)) {
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, span.index),
          message: debitMessage('SQL UPDATE literal'),
        });
      }
      if (hasLedgerInsert(span.text)) {
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, span.index),
          message: debitMessage('SQL INSERT literal'),
        });
      }
    }

    const stripped = stripComments(file.content);
    const drizzleSetIndex = findDrizzleDebitSetBrace(stripped);
    if (drizzleSetIndex !== undefined) {
      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, drizzleSetIndex),
        message: debitMessage('Drizzle update().set()'),
      });
    }
    const drizzleInsertIndex = findDrizzleLedgerInsert(stripped);
    if (drizzleInsertIndex !== undefined) {
      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, drizzleInsertIndex),
        message: debitMessage('Drizzle insert()'),
      });
    }
  }

  return violations;
}

function debitMessage(shape: string): string {
  return `check-single-debit: ${shape} writes wallet_accounts.balance_minor or inserts wallet_ledger - ${SANCTIONED_FILES_MESSAGE}`;
}
