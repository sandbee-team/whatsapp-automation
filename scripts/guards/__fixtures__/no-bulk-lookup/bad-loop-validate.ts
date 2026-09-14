/**
 * Fixture (P20 Unit U3, check-no-bulk-lookup): a loop feeding a WhatsApp
 * membership check - the exact shape ADR 0017/scope-delta Refused #2 bans.
 */
export async function validateNumbers(
  sock: { onWhatsApp: (n: string) => Promise<unknown> },
  numbers: string[],
) {
  const results = [];
  for (const number of numbers) {
    results.push(await sock.onWhatsApp(number));
  }
  return results;
}
