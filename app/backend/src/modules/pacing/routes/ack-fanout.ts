import type { TenantDb } from '@wp/db';

/**
 * ack-fanout.ts (P14 Unit U7, step 8) - `ackFanout`, the duplicate fan-out
 * ack surface (blueprint "ack-required at 500" / ADR 0015 decision 4: the
 * ack is a human decision, never automatic). ONE `withTenant` transaction:
 *
 *   1. `UPDATE content_fingerprints SET ack_by=$user, ack_at=now() WHERE
 *      client_id AND local_date AND fingerprint AND ack_at IS NULL` - 0 rows
 *      back (already acked, or no such fingerprint) is STILL a successful,
 *      idempotent no-op (`acked: true`), never an error: a repeat ack call
 *      (e.g. a retried click) must never fail.
 *   2. `audit_logs` row - same INSERT shape `modules/pacing/optout/
 *      restore.ts#restoreOptOut` uses (inlined here rather than importing
 *      `modules/tenancy`'s `insertAuditLog`, for the SAME reason that file's
 *      own doc comment gives: `insertAuditLog`'s `ALLOWED_AUDIT_METADATA_KEYS`
 *      allow-list only carries `'reason'/'source'/'code'` - widening it is
 *      out of this unit's scope, so the required localDate/fingerprint-hex/
 *      recipient-count detail travels inside the allow-listed `reason`
 *      field as a short structured string, never as new metadata keys, and
 *      NEVER the message body itself (PII/copy discipline, task instruction
 *      verbatim).
 *   3. `UPDATE message_jobs SET next_attempt_at=now() WHERE client_id AND
 *      status='queued' AND pacing_deny_reason='NEEDS_HUMAN_ACK' AND
 *      content_fingerprint=$fp RETURNING instance_id` - releases EVERY held
 *      job across every instance sharing this fingerprint, not just one.
 *      Postgres has no `RETURNING DISTINCT` (a real syntax error) - the
 *      one-row-per-updated-row result is deduped to distinct instance ids
 *      in JS below, before the wake loop.
 *
 * WAKE (delta's normative rule, verbatim): AFTER the transaction commits
 * (the `messages.service.ts#createMessage` `onEnqueued` idiom - never
 * inside the callback, since a wake published before commit risks a
 * subscriber waking to a row it cannot yet see under its own read), publish
 * exactly ONE wake per affected instance. Without this, an acked job would
 * otherwise wait out the guard pipeline's own bounded re-check hold
 * (`pipeline.ts`'s `NEEDS_HUMAN_ACK_RECHECK_HOLD_MS`, 300s) or the ≤42s
 * safety poll - both survivable, but "ack did nothing" for up to 5 minutes
 * is not the intended UX for a human-in-the-loop action.
 */

export interface AckFanoutDeps {
  tenantDb: TenantDb;
  /** `engine/queue/wake.ts#publishWake`, bound by the caller - invoked once per DISTINCT affected instance_id, strictly after the transaction below has committed. */
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
}

export interface AckFanoutInput {
  clientId: string;
  /** The acking user (session-auth only - route enforces this, never an API key). */
  actorUserId: string;
  localDate: string;
  fingerprint: Buffer;
}

export interface AckFanoutResult {
  acked: boolean;
}

export async function ackFanout(
  deps: AckFanoutDeps,
  input: AckFanoutInput,
): Promise<AckFanoutResult> {
  const affectedInstanceIds = await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const fpResult = await tx.query<{ recipient_count: number }>(
      `UPDATE content_fingerprints SET ack_by = $2, ack_at = now()
        WHERE client_id = $1 AND local_date = $3 AND fingerprint = $4 AND ack_at IS NULL
        RETURNING recipient_count
        -- client_id = $1`,
      [input.clientId, input.actorUserId, input.localDate, input.fingerprint],
    );

    const recipientCountRow = fpResult.rows[0];
    // MINOR 10 FIX (P14 review-fix F2): the fingerprint UPDATE above matched
    // zero rows for a repeat/no-op ack call (already acked, or no such
    // fingerprint) - that call still writes an audit row (an ack attempt is
    // always worth recording), but under a DISTINCT action
    // ('pacing.fanout_ack.noop') so an auditor can tell a replay from the
    // real ack, never the same action for both.
    const isNoop = recipientCountRow === undefined;
    const action = isNoop ? 'pacing.fanout_ack.noop' : 'pacing.fanout_ack';
    // recipientCount is best-effort audit context only (undefined on the
    // no-op path above) - never blocks the ack itself. Carried inside
    // `reason` (the one allow-listed metadata key - see module doc), never
    // the message body.
    const reason = `duplicate fan-out fingerprint acked for ${input.localDate}, recipient_count=${String(recipientCountRow?.recipient_count ?? 'unknown')}`;
    await tx.query(
      `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.clientId,
        'user',
        input.actorUserId,
        action,
        'content_fingerprint',
        input.fingerprint.toString('hex'),
        JSON.stringify({ reason }),
      ],
    );

    // Postgres has no `RETURNING DISTINCT` (a syntax error, verified live
    // against this exact statement) - RETURNING projects one row per
    // updated row, so the dedupe to "one wake per affected instance" runs
    // in JS below instead.
    const releasedRows = await tx.query<{ instance_id: string }>(
      `UPDATE message_jobs SET next_attempt_at = now()
        WHERE client_id = $1
          AND status = 'queued'
          AND pacing_deny_reason = 'NEEDS_HUMAN_ACK'
          AND content_fingerprint = $2
        RETURNING instance_id
        -- client_id = $1`,
      [input.clientId, input.fingerprint],
    );

    return [...new Set(releasedRows.rows.map((row) => row.instance_id))];
  });

  for (const instanceId of affectedInstanceIds) {
    await deps.publishWake(input.clientId, instanceId);
  }

  return { acked: true };
}

export interface PendingFanoutAckItem {
  localDate: string;
  fingerprintHex: string;
  recipientCount: number;
}

/**
 * The panel's "confirm these duplicate sends" list - every unacked
 * `content_fingerprints` row for this client. Counts only, per this
 * contract's own doc comment: no message body/text ever leaves this query.
 */
export async function listPendingFanoutAcks(
  tenantDb: TenantDb,
  clientId: string,
): Promise<PendingFanoutAckItem[]> {
  return tenantDb.withTenant(clientId, async (tx) => {
    const result = await tx.query<{
      local_date: string;
      fingerprint: Buffer;
      recipient_count: number;
    }>(
      `SELECT local_date::text AS local_date, fingerprint, recipient_count
         FROM content_fingerprints
        WHERE client_id = $1 AND ack_at IS NULL
        ORDER BY local_date DESC, recipient_count DESC
        -- client_id = $1`,
      [clientId],
    );
    return result.rows.map((row) => ({
      localDate: row.local_date,
      fingerprintHex: row.fingerprint.toString('hex'),
      recipientCount: row.recipient_count,
    }));
  });
}
