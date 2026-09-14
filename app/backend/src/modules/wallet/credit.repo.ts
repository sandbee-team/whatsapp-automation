import { bindQueryParams, loadNamedQuery, type TenantQueryable } from '@wp/db';

/**
 * credit.repo.ts (P19 Unit U2, step 4) - the guard-first credit's
 * TypeScript half, wired over `db/queries/wallet-credit.sql` (see that
 * file's own header for the full lock-order/idempotency contract; this
 * module owns none of that logic itself, only the two-statement call
 * sequence + the replay-read fallback). SQL-only, no policy - mirrors
 * `charge.ts`'s shape: takes a `TenantQueryable` as its first arg, never
 * opens its own transaction. NOT wired into `modules/wallet/index.ts` here
 * - a later unit owns the service layer on top of this repo function.
 */

export const CREDIT_KINDS = ['topup_manual', 'promo_credit', 'adjustment_credit'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

/** Thrown when `kind` is not one of `CREDIT_KINDS` - `refund_send` belongs to `refund-send.sql`, never here. */
export class InvalidCreditKindError extends Error {
  constructor(kind: string) {
    super(
      `creditWallet: invalid credit kind "${kind}" - must be one of ${CREDIT_KINDS.join(', ')}`,
    );
    this.name = 'InvalidCreditKindError';
  }
}

export interface CreditWalletInput {
  clientId: string;
  /** PAISE, bigint - bound straight to a `bigint` SQL parameter; never a JS number round-trip (a caller reading from `topup_requests.amount_minor` may exceed `Number.MAX_SAFE_INTEGER`). */
  amountMinor: bigint;
  kind: CreditKind;
  reason: string;
  externalRef: string;
  staffId: string;
}

export interface CreditWalletResult {
  seq: string;
  replayed: boolean;
}

/**
 * Runs `wallet-credit-ext-ref` (the guard-first credit, chained off the
 * `wallet_ledger_ext_refs` placeholder-row `RETURNING`); when a ledger row
 * was actually written (`seq !== null`), stamps the ext-ref row's real
 * `seq` in a second statement, same transaction
 * (`wallet-credit-stamp-ext-ref`). On replay (`seq === null` from the
 * credit statement - the ext-ref INSERT hit `ON CONFLICT DO NOTHING`),
 * reads the already-stamped seq via the separate read-only
 * `wallet-credit-existing-seq` statement and returns it with
 * `replayed: true`. Throws `InvalidCreditKindError` before touching the
 * database for any `kind` outside `CREDIT_KINDS`.
 */
export async function creditWallet(
  tx: TenantQueryable,
  input: CreditWalletInput,
): Promise<CreditWalletResult> {
  if (!CREDIT_KINDS.includes(input.kind)) {
    throw new InvalidCreditKindError(input.kind);
  }

  const creditQuery = await loadNamedQuery('wallet-credit', 'wallet-credit-ext-ref');
  const creditResult = await tx.query<{
    ext_ref_rows: number;
    acct_rows: number;
    seq: string | null;
  }>(
    creditQuery.text,
    bindQueryParams(creditQuery, {
      client: input.clientId,
      amount: input.amountMinor,
      kind: input.kind,
      reason: input.reason,
      external_ref: input.externalRef,
      staff_id: input.staffId,
    }),
  );
  const row = creditResult.rows[0];
  const seq = row?.seq ?? null;

  if (seq !== null) {
    const stampQuery = await loadNamedQuery('wallet-credit', 'wallet-credit-stamp-ext-ref');
    await tx.query(
      stampQuery.text,
      bindQueryParams(stampQuery, {
        seq,
        client: input.clientId,
        external_ref: input.externalRef,
      }),
    );
    return { seq, replayed: false };
  }

  const existingQuery = await loadNamedQuery('wallet-credit', 'wallet-credit-existing-seq');
  const existingResult = await tx.query<{ seq: string }>(
    existingQuery.text,
    bindQueryParams(existingQuery, {
      client: input.clientId,
      external_ref: input.externalRef,
    }),
  );
  const existingSeq = existingResult.rows[0]?.seq;
  if (existingSeq === undefined) {
    throw new Error(
      `creditWallet: replay detected (no new seq) but no existing wallet_ledger_ext_refs row for client=${input.clientId} external_ref=${input.externalRef}`,
    );
  }

  return { seq: existingSeq, replayed: true };
}
