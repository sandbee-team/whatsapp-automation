/**
 * Fixture (P12 Unit U5) - mirrors the REAL exempt file's shape: the
 * transition lives inside an inner `async (tx) => { ... }` callback, but
 * the OUTER enclosing function declares a top-level `actor` parameter. Must
 * NOT be flagged when scanned as if it were the exempt path.
 */
export interface FixtureActor {
  kind: 'user' | 'api_key' | 'system';
  userId?: string;
}

export interface FixtureDeps {
  tenantDb: { withTenant<T>(clientId: string, fn: (tx: unknown) => Promise<T>): Promise<T> };
}

export async function retryUnresolvedFixture(
  deps: FixtureDeps,
  actor: FixtureActor,
  input: { clientId: string; jobId: string },
): Promise<void> {
  if (actor.kind !== 'user') throw new Error('forbidden');

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const client = tx as { query: (s: string, p?: unknown[]) => Promise<unknown> };
    await client.query(
      `UPDATE message_jobs
          SET status = 'queued', next_attempt_at = now()
        WHERE id = $1 AND status = 'blocked_needs_review'`,
      [input.jobId],
    );
  });
}
