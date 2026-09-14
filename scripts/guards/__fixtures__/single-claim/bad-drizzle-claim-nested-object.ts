// Fixture (P03 close, finding 3a): a claim-style `.set({...})` call whose
// object literal has a NESTED object value (`payload: { a: 1 }`) before the
// real `status` key - a single-level `[^}]*` object-body scan ends at the
// inner `}` and never reaches `status`; brace-balanced scanning must not.
declare const messageJobs: unknown;
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };

export function rogueDrizzleClaimNestedObject(): unknown {
  return db.update(messageJobs).set({ payload: { a: 1 }, status: 'processing' });
}
