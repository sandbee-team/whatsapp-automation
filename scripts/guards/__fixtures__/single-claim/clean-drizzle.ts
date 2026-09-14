// Fixture: legitimate Drizzle writes that must stay clean.
//  - `update(messageJobs).set(...)` that touches OTHER columns only (no
//    `status` key at all).
//  - `update(someOtherTable).set({ status: ... })` - only `update(messageJobs)`
//    itself is governed by this guard, an unrelated table's status column is
//    none of its business.
//  - `update(messageJobs).set({ payload: {...} })` (P03 close, finding 3a) -
//    a NESTED object value with no top-level `status` key must stay clean
//    even under brace-balanced scanning, not just the single-level `[^}]*`
//    scan it replaced.
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };
declare const messageJobs: unknown;
declare const someOtherTable: unknown;

export function bumpLeaseOwner(): unknown {
  return db.update(messageJobs).set({ leaseOwner: 'w1' });
}

export function unrelatedTableStatusWrite(): unknown {
  return db.update(someOtherTable).set({ status: 'archived' });
}

export function updateNestedPayloadWithoutStatus(): unknown {
  return db.update(messageJobs).set({ payload: { a: 1, nested: { deeper: true } } });
}
