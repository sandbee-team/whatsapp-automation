/**
 * features/wallet/money.ts (P19 Unit U5, step 7; P19 C2 fix round) - the ONE
 * function that converts a rupees string (the top-up form's own text input)
 * to integer paise. Never `parseFloat` (binding correction #9) - a float can
 * silently misround (`0.1 + 0.2 !== 0.3` class of bug) on money. Instead:
 * split on `.`, left-pad/truncate the fractional part to exactly 2 digits,
 * and combine as BIGINT throughout (never `Number(wholePart) * 100`, which
 * is the same silent-precision-loss class the backend's `amount_minor`
 * round-trip bug was - see `.memory/lessons/2026-09-05-bigint-paise-through-js-number.md`).
 *
 * This function's own RETURN type stays `number`: its sole caller
 * (`topup-request-form.tsx`) feeds `createTopupRequestInputSchema.amountMinor`,
 * which is `z.number().int().positive()` (the tenant-typed rupee amount is
 * bounded to a realistic top-up size, unlike a `SUM()` over a ledger or a
 * staff adjustment - ADR 0019 §9 v1 scope). The computation is bigint-exact
 * and only narrows to `number` at the very end, via `Number()` on a value
 * already proven to be within `Number.MAX_SAFE_INTEGER` - never a silent
 * narrowing: an amount whose paise value would not survive that narrowing
 * throws `InvalidRupeeAmountError` instead of returning a wrong number.
 */
export class InvalidRupeeAmountError extends Error {
  constructor(raw: string) {
    super(`rupeesToPaise: "${raw}" is not a valid rupee amount`);
    this.name = 'InvalidRupeeAmountError';
  }
}

const RUPEES_PATTERN = /^\d+(\.\d{1,2})?$/;

/** "12.34" -> 1234. "12" -> 1200. "12.3" -> 1230. Throws `InvalidRupeeAmountError` on anything else (negative, more than 2 decimal places, non-numeric, or too large to narrow to `number` exactly). */
export function rupeesToPaise(raw: string): number {
  const trimmed = raw.trim();
  if (!RUPEES_PATTERN.test(trimmed)) {
    throw new InvalidRupeeAmountError(raw);
  }

  // RUPEES_PATTERN already guarantees wholePart exists (^\d+); the default
  // is only to satisfy TypeScript's array-destructure typing.
  const [wholePart = '0', fractionalPart = ''] = trimmed.split('.');
  const paddedFractional = fractionalPart.padEnd(2, '0');
  const paiseMinor = BigInt(wholePart) * 100n + BigInt(paddedFractional);
  if (paiseMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidRupeeAmountError(raw);
  }
  return Number(paiseMinor);
}

/**
 * The display inverse of `rupeesToPaise`: integer paise -> "₹" + rupees with
 * exactly 2 decimal places, BIGINT throughout (never a float division) - the
 * ONE shared implementation (P23a C1 fix round NOTE 8), replacing the three
 * identical local copies previously kept in `broadcast-list.tsx`, `funnel.tsx`
 * and `preflight-panel.tsx`.
 */
export function paiseToRupees(paiseMinor: number): string {
  const negative = paiseMinor < 0;
  const absPaise = BigInt(Math.abs(paiseMinor));
  const rupees = absPaise / 100n;
  const paise = absPaise % 100n;
  const paddedPaise = paise.toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${rupees.toString()}.${paddedPaise}`;
}
