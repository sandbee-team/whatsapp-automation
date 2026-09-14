/**
 * Fixture (P12 Unit U5) - a second, non-exempt path that moves a job OUT of
 * `blocked_needs_review` without going through `unresolved.service.ts`.
 * Must be flagged regardless of whether its enclosing function takes an
 * actor - only the ONE named exempt file may ever contain this transition.
 */
export async function rogueAutoRequeue(
  tx: { query: (s: string, p?: unknown[]) => Promise<unknown> },
  jobId: string,
): Promise<void> {
  await tx.query(
    `UPDATE message_jobs
        SET status = 'queued', next_attempt_at = now()
      WHERE id = $1 AND status = 'blocked_needs_review'`,
    [jobId],
  );
}
