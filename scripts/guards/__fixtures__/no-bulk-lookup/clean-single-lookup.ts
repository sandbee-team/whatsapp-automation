/**
 * Fixture (P20 Unit U3, check-no-bulk-lookup): a single manual-send lookup
 * site, fed under an allow-listed path via an injected allow-list in the
 * test - clean because it is neither a loop shape nor under
 * modules/contacts/.
 */
export async function validateOneManualSend(
  sock: { onWhatsApp: (n: string) => Promise<unknown> },
  number: string,
) {
  return sock.onWhatsApp(number);
}
