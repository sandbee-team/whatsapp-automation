/**
 * Fixture (P12 Unit U5) - proves the actor requirement: EVEN when scanned
 * as if it were the exempt path, a transition inside a function that takes
 * NO actor parameter must still be flagged. The exemption covers "this
 * file may contain the transition", not "this file may contain it
 * anywhere".
 */
export async function sweepWithoutActor(tx: {
  query: (s: string, p?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  await tx.query(
    `UPDATE message_jobs
        SET status = 'queued', next_attempt_at = now()
      WHERE status = 'blocked_needs_review'`,
  );
}
