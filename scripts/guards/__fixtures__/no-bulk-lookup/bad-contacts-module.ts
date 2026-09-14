/**
 * Fixture (P20 Unit U3, check-no-bulk-lookup): a single (non-loop) lookup,
 * but fed under the path `app/backend/src/modules/contacts/validate.ts` in
 * the test - clause (b) makes ANY match under modules/contacts/ a violation
 * even though it is not a loop shape and could otherwise be allow-listed.
 */
export async function validateOne(
  sock: { onWhatsApp: (n: string) => Promise<unknown> },
  number: string,
) {
  return sock.onWhatsApp(number);
}
