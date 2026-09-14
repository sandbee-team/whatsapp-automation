// Fixture: Drizzle ORM claim-style write against pacingLedger - no
// UPDATE/SET SQL string literal anywhere, so only findDrizzleSecondReserveSetBrace
// can see it.
declare const pacingLedger: unknown;
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };

export function rogueDrizzleReserve(): unknown {
  return db.update(pacingLedger).set({ consumed_count: 1 });
}
