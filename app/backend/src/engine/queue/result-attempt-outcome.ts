import type { TenantQueryable } from '@wp/db';

/**
 * result-attempt-outcome.ts - split out of `result.ts` at the max-lines cap
 * (mechanical extraction only; no logic change): the `send_attempts`
 * attempt-state write (`markAttempt`) and the shared zero-row job-outcome
 * guard (`assertJobRowTouched`/`ClaimLostDuringSend`) both `resolveAck` and
 * `resolveFailure` use. See `result.ts`'s own module header for the full
 * retry-matrix routing this supports.
 */

/** Thrown when the job-outcome UPDATE matches zero rows - another worker owns the job now. The outcome stays on the send_attempts row; nothing here re-sends. */
export class ClaimLostDuringSend extends Error {
  constructor(jobId: string) {
    super(
      `result: message_jobs ${jobId} was not 'processing' under this lease - claim lost during send`,
    );
    this.name = 'ClaimLostDuringSend';
  }
}

/**
 * Thrown by `resolveAck` when `markAttempt`'s UPDATE matches zero rows - no
 * `send_attempts` row means the dispatch transaction never committed, so
 * nothing was ever sent. Raised BEFORE any job/money write: the reaper's
 * no-attempt -> requeue contract is the correct recovery for this state,
 * not a job-outcome write from here.
 */
export class SendAttemptRowMissing extends Error {
  constructor(jobId: string, attemptNo: number) {
    super(`result: no send_attempts row for job ${jobId} attempt ${String(attemptNo)}`);
    this.name = 'SendAttemptRowMissing';
  }
}

export async function markAttempt(
  tx: TenantQueryable,
  input: {
    clientId: string;
    jobId: string;
    attemptNo: number;
    state: 'acked' | 'failed';
    providerMsgId?: string;
    errorClass?: string;
  },
): Promise<{ attemptId: string | null }> {
  const result = await tx.query<{ id: string }>(
    `UPDATE send_attempts SET state = $1, provider_msg_id = $2, error_class = $3, resolved_at = now()
      WHERE message_job_id = $4 AND attempt_no = $5 AND client_id = $6
      RETURNING id`,
    [
      input.state,
      input.providerMsgId ?? null,
      input.errorClass ?? null,
      input.jobId,
      input.attemptNo,
      input.clientId,
    ],
  );
  return { attemptId: result.rows[0]?.id ?? null };
}

/** A zero-row job-outcome UPDATE result: throws ClaimLostDuringSend, calls onClaimLost, never re-sends. */
export function assertJobRowTouched(
  rowCount: number | null,
  jobId: string,
  onClaimLost?: () => void,
): void {
  if (rowCount === 0 || rowCount === null) {
    onClaimLost?.();
    throw new ClaimLostDuringSend(jobId);
  }
}
