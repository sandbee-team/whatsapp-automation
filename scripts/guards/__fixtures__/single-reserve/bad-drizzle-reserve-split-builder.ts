// Fixture: the Drizzle builder is assigned to a variable in one statement
// and `.set(...)` is called on that variable in a LATER statement - a
// same-expression-only chain match never sees this (mirrors
// bad-drizzle-claim-split-builder.ts in the single-claim fixtures).
declare const pacingLedger: unknown;
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };

export function rogueDrizzleReserveSplitBuilder(): unknown {
  const builder = db.update(pacingLedger);
  builder.set({ sent_this_hour: 1 });
  return builder;
}
