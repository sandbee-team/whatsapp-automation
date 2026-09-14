import type { TenantQueryable } from '@wp/db';
import {
  DENY_REASON_EFFECTS,
  type GuardDecision,
  type PreparedBlockedWordEntry,
  type SendOrigin,
} from '@wp/domain';
import { evaluateOptOutGate } from './optout-gate.js';
import { evaluateBlockedWords, evaluateBlockedWordsPrepared } from '../content/blocked-words.js';
import { evaluateLinkGuard } from '../content/link-guard.js';
import { computeFingerprint, evaluateDuplicateFanout } from '../content/fingerprint.js';
import { evaluateRecipientFrequency } from '../content/recipient-frequency.js';

/**
 * pipeline.ts (P14 Unit U6, phase step 7) - `evaluateGuards`, the ONE
 * function `claimAndReserve` (`engine/queue/send-loop-pacing-claim.ts`)
 * calls, inside the SAME claim transaction, for every job it claims -
 * `send-loop.ts`'s own insertion comment ("P14: contentGuards.evaluate()
 * here") now points here.
 *
 * ORDER (first `{ok:false}` wins, matches the phase file verbatim): opt-out
 * gate -> blocked words -> link guard -> duplicate fan-out -> recipient
 * frequency. All-ok -> `{ok:true}`.
 *
 * GROUP JOBS: opt-out/link/frequency already self-skip internally (see each
 * evaluator's own doc comment) - blocked words and duplicate fan-out still
 * run for a group job. The sending WINDOW (in/outside pacing hours) is
 * reserve()'s own concern, untouched by this pipeline.
 *
 * EXEMPT ORIGINS ARE STILL CONTENT-GUARDED: this pipeline applies no origin
 * check of its own beyond what `evaluateOptOutGate` itself already does
 * (the one `opt_out_confirmation` pass-through) - a `system_reply`/
 * `opt_out_confirmation` job runs every guard exactly like a tenant send.
 *
 * BODY EXTRACTION: mirrors `dispatch.ts`'s own wire-projection shape - the
 * job's `text`, or a media job's `caption` (P34, 2026-09-14), whichever is
 * present. A caption is tenant-written text that reaches the recipient, so it
 * faces the same body-based guards as `text` (blocked words, link guard,
 * duplicate fan-out); reading only `payload.text` would have made "put the
 * words in the caption" a guard bypass. A payload with NEITHER (a captionless
 * image) genuinely has no text to evaluate and skips those three; recipient
 * frequency and the opt-out gate are body-independent and always run.
 */

export interface GuardPipelineJob {
  id: string;
  recipientJid: string;
  recipientHash: Buffer | null;
  sendOrigin: SendOrigin;
  contentFingerprint: Buffer | null;
  payload: Record<string, unknown>;
  payloadKind: string;
  isNewConversation: boolean;
}

export interface GuardPipelineState {
  warmupTier: number;
  localDate: string;
  dupFanoutWarn: number;
  dupFanoutAck: number;
  perRecipient24h: number;
  perRecipient7d: number;
}

export interface EvaluateGuardsInput {
  clientId: string;
  instanceId: string;
  job: GuardPipelineJob;
  state: GuardPipelineState;
  now: Date;
  onWarn?: (kind: 'link' | 'duplicate_fanout') => void;
  /** MINOR 14 (P14 review-fix F2): the tenant's own blocked-word entries, already fetched + compiled by the caller (`fetchBlockedWordEntries`, `@wp/domain`'s `prepareBlockedWordEntries`) - a per-pass caller (`send-loop-claim-evaluation.ts`) fetches this ONCE per `claimAndReserve` pass and passes it here for every job in that pass, never re-fetching/re-compiling per job. `undefined` falls back to `evaluateBlockedWords`'s own per-call fetch+compile - `evaluateGuards`'s standalone signature keeps working unchanged for any other caller/test. */
  blockedWordEntries?: readonly PreparedBlockedWordEntry[];
}

/**
 * Extracts the text body from a claimed job's payload - see this module's own
 * doc ("BODY EXTRACTION") for why this mirrors dispatch.ts's wire projection
 * exactly rather than re-deriving a second shape.
 *
 * A media job's `caption` IS a body (P34, 2026-09-14): it is tenant-written
 * text that reaches the recipient exactly like `text` does, so it must face
 * the same blocked-word, link and duplicate-fan-out guards. Reading only
 * `payload.text` here would have let every guard be bypassed by moving the
 * words into a caption.
 */
function extractBody(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.text === 'string') return payload.text;
  return typeof payload.caption === 'string' ? payload.caption : undefined;
}

/**
 * FINDING-3b-STYLE HOLD (documented, phase step 7 normative shape):
 * `NEEDS_HUMAN_ACK`'s own `retryAtRule` is `{kind: 'none'}` - the evaluator
 * itself has no clock-independent retry moment to offer (an ack is a human
 * decision, not a timer). Substituting `now` directly (as `defer-job.sql`'s
 * `$retry_at` would then be `<= now()`) would make this job the FIRST
 * result of every future `claim-jobs.sql` scan (`ORDER BY next_attempt_at,
 * id`) until a human acks the fingerprint - starving every OTHER queued job
 * on the same instance, since this guard re-fires identically on every
 * reclaim. This bounded hold is only the no-ack RE-CHECK cadence; the ack
 * path (a later unit) resets `next_attempt_at = now()` and publishes a wake
 * so an ack takes effect immediately, without waiting out this hold.
 */
const NEEDS_HUMAN_ACK_RECHECK_HOLD_MS = 300_000;

function resolveRetryAt(reason: string, retryAt: Date | null, now: Date): Date {
  if (retryAt) return retryAt;
  if (reason === 'NEEDS_HUMAN_ACK') {
    return new Date(now.getTime() + NEEDS_HUMAN_ACK_RECHECK_HOLD_MS);
  }
  return now;
}

/** Resolved deny shape - `retryAt` is ALWAYS a concrete Date (never null) once resolved, per `resolveRetryAt`'s own doc. */
export interface ResolvedGuardDenial {
  reason: string;
  retryAt: Date;
  /** `DENY_REASON_EFFECTS[reason].jobOutcome` - 'cancelled'/'failed' are terminal, 'queued' is a defer. */
  jobOutcome: 'queued' | 'cancelled' | 'failed';
}

export type EvaluateGuardsResult = { ok: true } | { ok: false; denial: ResolvedGuardDenial };

export async function evaluateGuards(
  tx: TenantQueryable,
  input: EvaluateGuardsInput,
): Promise<EvaluateGuardsResult> {
  const { clientId, instanceId, job, state, now } = input;
  const isGroup = job.recipientJid.endsWith('@g.us');
  const body = extractBody(job.payload);

  const decisions: (() => Promise<GuardDecision>)[] = [
    () =>
      evaluateOptOutGate(tx, {
        clientId,
        instanceId,
        recipientHash: job.recipientHash,
        isGroup,
        sendOrigin: job.sendOrigin,
      }),
    () => {
      if (body === undefined) return Promise.resolve<GuardDecision>({ ok: true });
      // MINOR 14: prefer the caller's already-fetched+compiled entries
      // (no DB read, no regex compilation) when supplied; fall back to the
      // standalone per-call fetch+compile otherwise (own doc, above).
      return input.blockedWordEntries
        ? Promise.resolve(evaluateBlockedWordsPrepared(body, input.blockedWordEntries))
        : evaluateBlockedWords(tx, { clientId, body });
    },
    () =>
      body !== undefined && job.recipientHash !== null
        ? evaluateLinkGuard(tx, {
            clientId,
            instanceId,
            recipientHash: job.recipientHash,
            body,
            warmupTier: state.warmupTier,
            isGroup,
            now,
            onWarn: () => input.onWarn?.('link'),
          })
        : Promise.resolve<GuardDecision>({ ok: true }),
    async () => {
      if (body === undefined || job.recipientHash === null) return { ok: true };
      const fingerprint = job.contentFingerprint ?? computeFingerprint(body);
      return evaluateDuplicateFanout(tx, {
        clientId,
        localDate: state.localDate,
        fingerprint,
        recipientHash: job.recipientHash,
        warnAt: state.dupFanoutWarn,
        ackAt: state.dupFanoutAck,
        jobId: job.id,
        now,
        onWarn: () => input.onWarn?.('duplicate_fanout'),
      });
    },
    () =>
      job.recipientHash !== null
        ? evaluateRecipientFrequency(tx, {
            clientId,
            phoneHash: job.recipientHash,
            isGroup,
            limits: {
              perRecipient24h: state.perRecipient24h,
              perRecipient7d: state.perRecipient7d,
            },
            now,
          })
        : Promise.resolve<GuardDecision>({ ok: true }),
  ];

  // Sequential, never Promise.all: the FIRST denial wins, so a later guard
  // must never run once an earlier one has already denied.
  for (const evaluate of decisions) {
    const decision = await evaluate();
    if (!decision.ok) {
      const retryAt = resolveRetryAt(decision.reason, decision.retryAt, now);
      return {
        ok: false,
        denial: {
          reason: decision.reason,
          retryAt,
          jobOutcome: DENY_REASON_EFFECTS[decision.reason].jobOutcome,
        },
      };
    }
  }

  return { ok: true };
}
