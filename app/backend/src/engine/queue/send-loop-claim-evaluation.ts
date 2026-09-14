import {
  drawGapMs,
  isExemptOrigin,
  type PreparedBlockedWordEntry,
  type Rng,
  type SendOrigin,
} from '@wp/domain';
import type { TenantQueryable } from '@wp/db';
import { reserve } from '../pacing/index.js';
import { evaluateGuards } from '../../modules/pacing/guards/pipeline.js';
import { computeFingerprint } from '../../modules/pacing/content/fingerprint.js';
import { notify } from '../../modules/notifications/index.js';
import type { ClaimOneCtx, ClaimOneInput, ClaimedJob } from '../../modules/queue/queue.repo.js';
import { deferJob, disposeJob, readGuardPipelineState } from './send-loop-guard-pipeline-wiring.js';

/**
 * send-loop-claim-evaluation.ts (P14 Unit U6, phase step 7) -
 * `evaluateOneClaimedJob`, ONE claimed job's guard-then-pacing evaluation.
 * Split out of `send-loop-pacing-claim.ts` purely for that file's own
 * max-lines cap (same established split idiom as
 * `session-worker-discovery-wiring.ts`) - `claimAndReserve` there owns only
 * the claim-loop shape (claim -> evaluate -> continue-or-stop, up to the
 * disposal cap); this module owns the per-job decision itself.
 *
 * ORDER inside ONE already-open transaction: guard pipeline -> (terminal
 * denial: dispose and let the caller's loop try the next job) -> (non-
 * terminal denial: defer and stop) -> pacing reserve -> (grant: return the
 * claimed job) -> (denial: defer and stop).
 */

export interface ClaimEvaluationDeps {
  rng: Rng;
  clock: { now(): number };
  onPacingDeny?: (reason: string) => void;
  onGuardTrip?: (reason: string) => void;
}

interface PacingStateRow extends Record<string, unknown> {
  eff_gap_min_ms: number;
  eff_gap_max_ms: number;
  eff_window_start_local: string;
  eff_window_end_local: string;
  pacing_timezone: string;
}

async function readPacingState(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<PacingStateRow | undefined> {
  const result = await tx.query<PacingStateRow>(
    `SELECT eff_gap_min_ms, eff_gap_max_ms, eff_window_start_local, eff_window_end_local, pacing_timezone
       FROM instance_pacing_state WHERE instance_id = $1 AND client_id = $2`,
    [instanceId, clientId],
  );
  return result.rows[0];
}

/**
 * FINDING-1 FIX (P13 C1 review): writes the AUTHORITATIVE `ledger_date`
 * `reserve-pacing.sql` itself just computed and RETURNED (from
 * `instance_pacing_state.pacing_timezone`, the instance's LOCAL calendar
 * date) back onto the claimed job's own `pacing_ledger_date`, inside the
 * SAME transaction, immediately after a GRANT. The reserve statement is the
 * ONE authority for what "today" means for pacing; this is a plain,
 * single-row conditional UPDATE, not a second grantor - it never touches
 * any `pacing_ledger`/`client_daily_usage` counter column.
 */
/**
 * Mirrors `pipeline.ts`'s own "BODY EXTRACTION" doc - the exact wire
 * projection dispatch.ts uses, never a re-derived shape. A media job's
 * `caption` counts as the body (P34, 2026-09-14): it is tenant-written text
 * that reaches the recipient, so it faces the same guards as `text`. These
 * two extractors must stay identical - if one learns a new body field the
 * other has to as well, or a guard silently applies on one path only.
 */
function extractBody(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.text === 'string') return payload.text;
  return typeof payload.caption === 'string' ? payload.caption : undefined;
}

/**
 * The SAME fingerprint identity `evaluateDuplicateFanout` (`content/
 * fingerprint.ts`) just evaluated against - re-derived here (never a second
 * DB read) purely to build the `duplicate_fanout_ack_required` notify's
 * transitionId. `undefined` when the job carries no text body (pipeline.ts's
 * own guard never runs the duplicate-fanout check in that case either, so
 * this is unreachable for that job shape).
 */
function fingerprintHexFor(claimed: ClaimedJob): string | undefined {
  if (claimed.contentFingerprint) {
    return claimed.contentFingerprint.toString('hex');
  }
  const body = extractBody(claimed.payload as Record<string, unknown>);
  if (body === undefined) return undefined;
  return computeFingerprint(body).toString('hex');
}

async function writeLedgerDateToJob(
  tx: TenantQueryable,
  clientId: string,
  jobId: string,
  ledgerDate: string,
): Promise<void> {
  await tx.query(
    `UPDATE message_jobs SET pacing_ledger_date = $3 WHERE id = $1 AND client_id = $2`,
    [jobId, clientId, ledgerDate],
  );
}

/**
 * FINDING 3b (P13 C1 review): the bounded, non-alerting hold for a
 * genuinely-missing `instance_pacing_state` row (no ledger row exists to
 * read a real `next_eligible_at` from) - short enough that a job is
 * retried promptly once provisioning has caught up, long enough that this
 * shape never hot-loops the claim.
 */
const NO_LEDGER_ROW_HOLD_MS = 60_000;

export type ClaimEvaluationResult =
  { kind: 'disposed' } | { kind: 'stop'; job: ClaimedJob | undefined };

/**
 * ONE claimed job's guard-then-pacing evaluation, run inside the caller's
 * open transaction. Returns `'disposed'` (a terminal guard denial was
 * written - the caller's own loop should try claiming the NEXT job in the
 * same pass, up to its own disposal cap), or `'stop'` (a non-terminal guard
 * deferral, a pacing deferral, or a genuine grant - the caller's own pass
 * ends here either way: a pacing denial is whole-INSTANCE, not per-band, so
 * there is nothing to gain from trying another job in the same pass).
 */
export async function evaluateOneClaimedJob(
  deps: ClaimEvaluationDeps,
  tx: TenantQueryable,
  ctx: ClaimOneCtx,
  input: ClaimOneInput,
  claimed: ClaimedJob,
  /** MINOR 14 (P14 review-fix F2) - the caller's (`claimAndReserve`'s) ONE fetch+compile per pass, reused for every job in that pass; `undefined` falls back to `evaluateGuards`'s own per-call fetch (see that module's own doc). */
  blockedWordEntries?: readonly PreparedBlockedWordEntry[],
): Promise<ClaimEvaluationResult> {
  const guardState = await readGuardPipelineState(tx, ctx.clientId, input.instanceId);
  // A missing instance_pacing_state row is handled identically to the
  // pre-existing pacing NO_LEDGER_ROW path below (the pacing reserve would
  // hit the exact same missing row) - the guard pipeline needs the SAME row
  // for warmup_tier/thresholds, so there is nothing guard-specific to
  // evaluate yet either. Falls through to the pacing NO_LEDGER_ROW branch.
  if (guardState) {
    const guardResult = await evaluateGuards(tx, {
      clientId: ctx.clientId,
      instanceId: input.instanceId,
      job: {
        id: claimed.id,
        recipientJid: claimed.recipientJid,
        recipientHash: claimed.recipientHash,
        sendOrigin: (claimed.sendOrigin ?? 'api_send') as SendOrigin,
        contentFingerprint: claimed.contentFingerprint,
        payload: claimed.payload as Record<string, unknown>,
        payloadKind: claimed.payloadKind,
        isNewConversation: claimed.isNewConversation,
      },
      state: guardState,
      now: new Date(deps.clock.now()),
      blockedWordEntries,
    });

    if (!guardResult.ok) {
      deps.onGuardTrip?.(guardResult.denial.reason);
      if (guardResult.denial.jobOutcome === 'queued') {
        await deferJob(tx, {
          id: claimed.id,
          clientId: ctx.clientId,
          reason: guardResult.denial.reason,
          retryAt: guardResult.denial.retryAt,
          leaseId: claimed.leaseId,
        });

        // P17 U6 (step 5) - duplicate_fanout_ack_required: mandatory notify
        // on the SAME tx as the defer above. transitionId is the content
        // fingerprint identity + local_date (task's own instruction,
        // verbatim: "that IS the transition - one notification per
        // fingerprint per day, not per held job") - `dedupeScope: 'transition'`
        // (kinds.ts), so the day bucket is folded into transitionId itself
        // (this kind has no separate `bucket` param, unlike plan_cap_reached).
        if (guardResult.denial.reason === 'NEEDS_HUMAN_ACK' && guardState) {
          const fingerprintHex = fingerprintHexFor(claimed);
          if (fingerprintHex) {
            await notify(tx, {
              clientId: ctx.clientId,
              instanceId: input.instanceId,
              kind: 'duplicate_fanout_ack_required',
              transitionId: `${fingerprintHex}:${guardState.localDate}`,
              payload: { instanceId: input.instanceId },
              requiresUserAction: true,
            });
          }
        }

        return { kind: 'stop', job: undefined };
      }

      await disposeJob(tx, {
        id: claimed.id,
        clientId: ctx.clientId,
        leaseId: claimed.leaseId,
        outcome: guardResult.denial.jobOutcome,
        reason: guardResult.denial.reason,
      });
      return { kind: 'disposed' };
    }
  }

  const state = await readPacingState(tx, ctx.clientId, input.instanceId);

  if (!state) {
    deps.onPacingDeny?.('NO_LEDGER_ROW');
    await deferJob(tx, {
      id: claimed.id,
      clientId: ctx.clientId,
      reason: 'NO_LEDGER_ROW',
      retryAt: new Date(deps.clock.now() + NO_LEDGER_ROW_HOLD_MS),
      leaseId: claimed.leaseId,
    });
    return { kind: 'stop', job: undefined };
  }

  const gapMs = drawGapMs(state.eff_gap_min_ms, state.eff_gap_max_ms, deps.rng);
  const isGroup = claimed.recipientJid.endsWith('@g.us');

  // reserve-pacing.sql point (5), verbatim: "is_new_conversation is false
  // for group sends (scope delta) ... a group send is never a cold DM, so
  // the claimed job's own stored classification is force-false whenever
  // `isGroup` is true, even if `message_jobs.is_new_conversation` was
  // itself set true.
  const isNewConversation = claimed.isNewConversation && !isGroup;
  // `reserve()` re-derives this SAME value internally from `sendOrigin`
  // (`isExemptOrigin(sendOrigin ?? 'api_send')`) - computed here too so a
  // later refund (`release-pacing.sql`'s own `$is_exempt`, Finding 9) can
  // be given the EXACT original value without re-deriving it a second time
  // at refund time.
  const isExempt = isExemptOrigin((claimed.sendOrigin ?? 'api_send') as SendOrigin);

  const outcome = await reserve({
    sql: tx,
    clientId: ctx.clientId,
    instanceId: input.instanceId,
    isNewConversation,
    isGroup,
    gapMs,
    // `claimAndReserve` threads `origin` from the claimed row into
    // `reserve()` - `reserve()` itself defaults a null/missing column (a
    // pre-P14 row) to `'api_send'` (see its own doc comment).
    sendOrigin: claimed.sendOrigin as SendOrigin | null,
    clock: deps.clock,
    timeZone: state.pacing_timezone,
    windowStartLocal: state.eff_window_start_local,
    windowEndLocal: state.eff_window_end_local,
  });

  if (outcome.granted) {
    await writeLedgerDateToJob(tx, ctx.clientId, claimed.id, outcome.ledgerDate);
    // Attach the ORIGINAL reserve's own bind values onto the returned job -
    // a later pre-send precheck failure (dispatch.ts) needs these EXACT
    // values to refund correctly (release-pacing.sql's own header: never
    // re-derive them).
    return {
      kind: 'stop',
      job: {
        ...claimed,
        pacingReserve: {
          ledgerDate: outcome.ledgerDate,
          gapMs,
          isNewConversation,
          isGroup,
          isExempt,
        },
      },
    };
  }

  deps.onPacingDeny?.(outcome.reason);
  await deferJob(tx, {
    id: claimed.id,
    clientId: ctx.clientId,
    reason: outcome.reason,
    retryAt: outcome.retryAt,
    leaseId: claimed.leaseId,
  });
  return { kind: 'stop', job: undefined };
}
