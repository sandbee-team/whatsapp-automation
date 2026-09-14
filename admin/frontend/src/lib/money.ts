/**
 * lib/money.ts (P28 Unit U6, step 9) - paise (decimal string) -> a rupee
 * display string. Every wallet amount on the wire is
 * `paiseStringSchema` (a signed decimal string of PAISE - the backing column
 * is `bigint`), so this NEVER uses `parseFloat`/`Number()` on it (a float
 * cannot represent every paise value exactly). BigInt division gives the
 * rupee/paise split exactly; only the final ratio (a value already bounded
 * to two digits) is formatted as a string.
 */
export function formatPaiseAsRupees(paise: string): string {
  const negative = paise.startsWith('-');
  const digits = negative ? paise.slice(1) : paise;
  const value = BigInt(digits);
  const rupees = value / 100n;
  const remainder = value % 100n;
  const paiseTwoDigits = remainder.toString().padStart(2, '0');
  const sign = negative && value !== 0n ? '-' : '';
  return `${sign}₹${rupees.toString()}.${paiseTwoDigits}`;
}
