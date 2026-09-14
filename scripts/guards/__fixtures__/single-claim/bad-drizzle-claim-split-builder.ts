// Fixture (P03 close, finding 3b): the Drizzle builder is assigned to a
// variable in one statement and `.set(...)` is called on that variable in a
// LATER statement - a same-expression-only chain match never sees this.
declare const messageJobs: unknown;
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };

export function rogueDrizzleClaimSplitBuilder(): unknown {
  const builder = db.update(messageJobs);
  builder.set({ status: 'processing' });
  return builder;
}
