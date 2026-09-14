import { createHash } from 'node:crypto';
import { bindQueryParams, loadQuery, type TenantQueryable } from '@wp/db';
import { normaliseForFingerprint, type GuardDecision } from '@wp/domain';

/**
 * fingerprint.ts (P14 Unit U5, phase step 6) - the duplicate-fanout content
 * guard: `computeFingerprint` (the server-side hash half of `@wp/domain`'s
 * browser-pure `normaliseForFingerprint`) and `evaluateDuplicateFanout` (the
 * `db/queries/count-fingerprint-recipient.sql` wrapper + threshold decision).
 *
 * Threshold semantics (documented decision - the phase task's canon says
 * "ack 500" / "ack-required at 500", read as "count EXCEEDING 500 requires
 * ack"): `recipient_count > ackAt` denies, so the 500th distinct recipient
 * is still `{ok:true}` and the 501st is the first to see NEEDS_HUMAN_ACK.
 * Same `>` reading for `warnAt`: the (warnAt+1)-th distinct recipient is the
 * first to fire `onWarn`.
 */

export function computeFingerprint(body: string): Buffer {
  return createHash('sha256').update(normaliseForFingerprint(body), 'utf8').digest();
}

export interface EvaluateDuplicateFanoutInput {
  clientId: string;
  localDate: string;
  fingerprint: Buffer;
  recipientHash: Buffer;
  warnAt: number;
  ackAt: number;
  jobId?: string | null;
  now: Date;
  /** Fired when `recipient_count` crosses above `warnAt` but is still `<= ackAt` - metrics wiring belongs to a later unit. */
  onWarn?: () => void;
}

export type EvaluateDuplicateFanoutResult = GuardDecision & { inserted?: boolean };

/**
 * Records this (fingerprint, recipientHash) evaluation (idempotent per
 * distinct recipient - see the SQL file's own R-27w note) and returns the
 * resulting decision. An already-acked fingerprint (`ack_at IS NOT NULL`)
 * is always `{ok:true}`, even above `ackAt` - an ack is a standing decision
 * to keep sending, not a one-time bypass of a single evaluation.
 */
export async function evaluateDuplicateFanout(
  tx: TenantQueryable,
  input: EvaluateDuplicateFanoutInput,
): Promise<EvaluateDuplicateFanoutResult> {
  const query = await loadQuery('count-fingerprint-recipient');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    local_date: input.localDate,
    fingerprint: input.fingerprint,
    recipient_hash: input.recipientHash,
    now: input.now,
  });
  const result = await tx.query<{ recipient_count: number; ack_at: Date | null }>(
    query.text,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('evaluateDuplicateFanout: count-fingerprint-recipient returned no row');
  }

  if (row.ack_at !== null) {
    return { ok: true };
  }

  if (row.recipient_count > input.ackAt) {
    return { ok: false, reason: 'NEEDS_HUMAN_ACK', retryAt: null };
  }

  if (row.recipient_count > input.warnAt) {
    input.onWarn?.();
    return { ok: true };
  }

  return { ok: true };
}
