// Fixture: a clean Drizzle update on pacingLedger that never sets a
// tracked column, paired with an unrelated update on some other table that
// DOES set one of the tracked-sounding keys - only a `.set(` actually
// reachable from a pacingLedger update may ever be flagged (mirrors
// clean-drizzle.ts in the single-claim fixtures).
declare const pacingLedger: unknown;
declare const someOtherTable: unknown;
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };

export function cleanReserveTouch(): unknown {
  return db.update(pacingLedger).set({ last_reserved_at: new Date() });
}

export function unrelatedTableWrite(): unknown {
  return db.update(someOtherTable).set({ consumed_count: 1 });
}
