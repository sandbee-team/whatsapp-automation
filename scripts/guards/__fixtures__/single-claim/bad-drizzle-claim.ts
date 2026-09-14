// Fixture (finding 4a, P03 close): Drizzle ORM claim-style write - no
// UPDATE/SET SQL string literal anywhere, so neither the literal-status nor
// the parameterized-status pattern (which only scan string/template-literal
// spans) can see it. `messageJobs`/`db` stand in for the real
// `db/schema/message-jobs.ts` export and a real Drizzle handle - the guard
// matches on source text, not a resolved import, so no real import is
// needed to prove the pattern (this file is excluded from typecheck, see
// `scripts/tsconfig.json`'s `exclude`).
declare const messageJobs: unknown;
declare const db: { update(table: unknown): { set(values: Record<string, unknown>): unknown } };

export function rogueDrizzleClaim(): unknown {
  return db.update(messageJobs).set({ status: 'processing' });
}
