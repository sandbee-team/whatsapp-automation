import {
  DEFAULT_BAND_WEIGHTS,
  createDwrrSelector,
  type Band,
  type DwrrSelector,
  type Rng,
} from '@wp/domain';
import type { ClaimOneCtx, ClaimOneInput, ClaimedJob } from '../../modules/queue/queue.repo.js';
import { TransportSendError } from '../../provider/provider.types.js';
import { ClaimLostBeforeDispatch, type DispatchInput, type DispatchResult } from './dispatch.js';
import type { QueueMetricsHandles } from './metrics.js';
import { recordSendFailure } from './send-failure-metrics.js';
import {
  ClaimLostDuringSend,
  type ResolveAckInput,
  type ResolveFailureInput,
  type ResultDeps,
} from './result.js';

/** Minimal clock port - injected, never `Date.now()` directly. Previously imported from the now-deleted `engine/queue/interim-gap.ts` (P13 - see this file's own module doc). */
export interface Clock {
  now(): number;
}

/**
 * send-loop.ts (P11 Unit U5, step 9; P13 pacing wiring) - wires wake/timer/
 * poll -> `dwrr.pick()` band -> `claimOne()` -> `dispatch()` -> `result()`,
 * per-instance concurrency 1 (one `runOneSendLoopIteration` call in flight
 * per leased instance at a time - the caller, `roles/session-worker.ts`,
 * enforces this by never overlapping its own per-instance timer/wake
 * callbacks; this module has no internal concurrency of its own to bound).
 *
 * TIMEOUTS (fixed 2026-09-14): a `timed_out` dispatch resolves as category
 * `'unknown'`, never `'transient'`. `transient` maps to RETRY_BACKOFF, so
 * the job used to be requeued and SENT AGAIN - but a timeout means the
 * provider did not answer, not that nothing was delivered. Retrying is a
 * guaranteed double-send and breaks core invariant 2 (fail-safe).
 * `dispatch.ts`'s header states the contract: "A send timeout is
 * `dispatched`/unknown, never a retry decision made HERE." `unknown` maps to
 * PAUSE_INSTANCE and is non-overridable by any injected table; the reaper
 * reconciles the attempt from `send_attempts.state`.
 *
 * PACING (P13): the real durable pacing reserve (`engine/pacing/index.ts#
 * reserve()`) runs INSIDE `deps.claimOne` itself, sharing the SAME
 * transaction as the claim (`send-loop-worker-wiring.ts#
 * buildSendLoopWorkerWiring`'s `claimOneUnderTenant` wraps both calls in one
 * `tenantDb.withTenant` block: claim -> reserve -> commit; a pacing DENIAL
 * commits normally, only a losing CLAIM rolls back).
 * `deps.claimOne` returns `ClaimedJob | undefined` precisely so the
 * band-fallthrough needs no pacing-specific branch: a pacing denial and an
 * empty band both resolve to `undefined`, both meaning "nothing claimable on
 * this band right now". Pacing denies the whole INSTANCE, so falling through
 * after a denial is wasted work, not a correctness bug - and it is bounded
 * by `claimAcrossBands`'s own "try up to 3 times" cap.
 *
 * BAND SELECTION: `createDwrrSelector` (deficit-weighted, HIGH:NORMAL:LOW =
 * 6:3:1, [R-39]: per-worker, in-memory, per LEASED instance, REBUILT on
 * lease acquisition - never a shared/global selector) picks a band, and
 * `claimOne` is tried against that band's `priority_rank`
 * (`DEFAULT_BAND_WEIGHTS[band]`, the SAME table `priorityRankFor` derives
 * from - a band's weight IS its `priority_rank`). A miss means THAT band was
 * empty, not the whole instance, so the loop falls through the remaining
 * bands before conceding. Absolute-priority scanning is the starvation shape
 * DWRR exists to prevent; `claim-jobs.sql` stays the one eligibility
 * authority (never duplicated here, and there is no cheap "peek").
 *
 * A wake is a hint, never an authority (phase gotcha): every eligibility
 * predicate this loop relies on lives inside `db/queries/claim-jobs.sql`
 * (via `claimOne`) - nothing here inspects why an iteration was triggered
 * (wake / `next_eligible_at` timer / mandatory safety poll) to decide
 * whether to trust a claim result differently; the wake/timer/poll only
 * ever decide WHEN to call `runOneSendLoopIteration`, never WHETHER a claim
 * is valid.
 */

/** `Band -> priority_rank` - the DWRR weight table doubles as the numeric band value `claim-jobs.sql` matches on (see module doc). */
function bandRank(band: Band): number {
  return DEFAULT_BAND_WEIGHTS[band];
}

const BAND_ORDER: readonly Band[] = ['HIGH', 'NORMAL', 'LOW'];

export interface SendLoopDeps {
  clientId: string;
  instanceId: string;
  workerId: string;
  /** Must equal `instance_lease_state.current_fence` - proves this call currently owns the session (same contract as `ClaimOneInput.fence`). */
  fence: number | bigint;
  claimOne: (ctx: ClaimOneCtx, input: ClaimOneInput) => Promise<ClaimedJob | undefined>;
  dispatch: (input: DispatchInput, deps: unknown) => Promise<DispatchResult>;
  resolveAck: (input: ResolveAckInput, deps: unknown) => Promise<void>;
  resolveFailure: (input: ResolveFailureInput, deps: ResultDeps) => Promise<void>;
  /** Reads `message_jobs.max_attempts` for the claimed job (migration 0025's narrow `SELECT (max_attempts)` grant) - `ClaimedJob` itself does not carry this column (`claim-jobs.sql`'s RETURNING list omits it), so the loop reads it separately rather than widening the claim statement's own return shape. */
  readMaxAttempts: (jobId: string) => Promise<number>;
  metrics: QueueMetricsHandles;
  rng: Rng;
  clock: Clock;
  /** Overrides the DWRR selector - defaults to a fresh one per call (tests only; production callers build ONE selector per lease and reuse it across iterations, per [R-39]). */
  dwrr?: DwrrSelector;
  /** The tenant-scoped query context `claimOne` runs against - optional so unit tests (which stub `claimOne` entirely) never need a real connection; production wiring always supplies it. */
  ctx?: ClaimOneCtx;
  /** `dispatch`/`resolveAck`/`resolveFailure`'s own real dependency bags - optional for the same reason as `ctx`; production wiring always supplies them. */
  dispatchDeps?: unknown;
  resultDeps?: ResultDeps;
  claimExpiryMs?: number;
}

export interface SendLoopIterationResult {
  claimed: boolean;
}

function jobToDispatchInput(
  deps: SendLoopDeps,
  job: ClaimedJob,
  maxAttempts: number,
): DispatchInput & { maxAttempts: number } {
  return {
    clientId: deps.clientId,
    instanceId: deps.instanceId,
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    leaseId: job.leaseId,
    attempts: job.attempts,
    recipientJid: job.recipientJid,
    payloadKind: job.payloadKind,
    payload: job.payload as Record<string, unknown>,
    publicId: job.id,
    fence: deps.fence,
    maxAttempts,
    // P14 Unit U4: threaded through to dispatch()'s pre-send opt-out
    // precheck (see dispatch-optout-precheck.ts) - null for a pre-P14 row
    // or a claim that never went through claimAndReserve (ClaimedJob's own
    // doc comments).
    recipientHash: job.recipientHash,
    sendOrigin: job.sendOrigin,
    pacingReserve: job.pacingReserve,
  };
}

/** Claims exactly one job across the DWRR-selected band order, falling through empty bands - never absolute priority. Returns `undefined` once every band has been tried and found empty. */
async function claimAcrossBands(
  deps: SendLoopDeps,
  dwrr: DwrrSelector,
): Promise<ClaimedJob | undefined> {
  const available: Record<Band, boolean> = { HIGH: true, NORMAL: true, LOW: true };
  const ctx = deps.ctx ?? ({ clientId: deps.clientId, sql: undefined as never } as ClaimOneCtx);

  for (let tried = 0; tried < BAND_ORDER.length; tried += 1) {
    const band = dwrr.next(available);
    if (band === null) {
      return undefined;
    }

    const claimed = await deps.claimOne(ctx, {
      instanceId: deps.instanceId,
      band: bandRank(band),
      fence: deps.fence,
      workerId: deps.workerId,
      claimExpiryMs: deps.claimExpiryMs ?? 90_000,
    });

    if (claimed) {
      return claimed;
    }

    available[band] = false;
  }

  return undefined;
}

/**
 * Runs `dispatch()` then routes the outcome to `resolveAck`/`resolveFailure`.
 * A `ClaimLostDuringSend` thrown by either resolver, OR a
 * `ClaimLostBeforeDispatch` thrown by `dispatch()` itself, is a NORMAL
 * outcome (another worker owns the job now) - caught here, never rethrown;
 * the respective `onClaimLost` port (both wired to `wp_claim_lost_total.inc()`
 * below) already fired before either threw.
 */
async function dispatchAndResolve(deps: SendLoopDeps, job: ClaimedJob): Promise<void> {
  const stopTimer = deps.metrics.sendDurationSeconds.startTimer();
  const maxAttempts = await deps.readMaxAttempts(job.id);
  const dispatchInput = jobToDispatchInput(deps, job, maxAttempts);

  // `resultDeps` is optional only for tests (`SendLoopDeps.resultDeps` doc) - production always supplies it.
  const resultDeps: ResultDeps = {
    ...(deps.resultDeps as ResultDeps),
    onClaimLost: () => {
      deps.metrics.claimLostTotal.inc();
      deps.resultDeps?.onClaimLost?.();
    },
  };
  const dispatchDeps = {
    ...(deps.dispatchDeps as object | undefined),
    onClaimLost: () => deps.metrics.claimLostTotal.inc(),
  };

  try {
    const dispatchResult = await deps.dispatch(dispatchInput, dispatchDeps);

    // P14 Unit U4: opt-out precheck cancellation - nothing to resolve, no
    // metrics 'sent'. P34: same for 'deferred_media_unavailable' (defer-job.sql already ran inside dispatch()).
    if (
      dispatchResult.outcome === 'cancelled_pre_send' ||
      dispatchResult.outcome === 'deferred_media_unavailable'
    ) {
      return;
    }

    if (dispatchResult.outcome === 'settled' && !dispatchResult.sendError) {
      await deps.resolveAck(
        {
          clientId: deps.clientId,
          instanceId: deps.instanceId,
          jobId: job.id,
          jobCreatedAt: job.createdAt,
          leaseId: job.leaseId,
          attemptNo: dispatchResult.attemptNo,
          publicId: dispatchInput.publicId,
          outcome: dispatchResult.sendOutcome!,
          payloadKind: job.payloadKind,
          recipientHash: job.recipientHash,
          recipientJid: job.recipientJid,
          campaignId: job.campaignId,
        },
        resultDeps,
      );
      deps.metrics.sendAttemptsTotal.inc({ result: 'sent' });
      return;
    }

    // 'unknown', NEVER 'transient' - see this module's own TIMEOUTS note.
    const error =
      dispatchResult.outcome === 'timed_out'
        ? new TransportSendError('unknown', 'send timed out')
        : (dispatchResult.sendError as TransportSendError);

    await deps.resolveFailure(
      {
        clientId: deps.clientId,
        instanceId: deps.instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId: job.leaseId,
        attemptNo: dispatchResult.attemptNo,
        publicId: dispatchInput.publicId,
        attempts: job.attempts,
        maxAttempts,
        error,
        recipientJid: job.recipientJid,
      },
      resultDeps,
    );
    const outcome = dispatchResult.outcome === 'timed_out' ? 'timed_out' : 'failed';
    recordSendFailure(deps.metrics, outcome, error);
  } catch (err) {
    if (err instanceof ClaimLostDuringSend || err instanceof ClaimLostBeforeDispatch) {
      // Already counted via onClaimLost above (resultDeps or dispatchDeps,
      // whichever fired) - a normal outcome, not a loop failure.
      return;
    }
    throw err;
  } finally {
    stopTimer();
  }
}

/**
 * Runs exactly one send-loop iteration for one leased instance: pick a
 * band -> claim (which now also reserves a pacing unit, same transaction -
 * see module doc) -> dispatch -> resolve. Concurrency 1 is the CALLER's
 * responsibility (never overlap two iterations for the same instance);
 * this function does not serialize against itself.
 *
 * (P13's own insertion point, `// P13: pacing.reserve() here`, is now this
 * whole module doc's "PACING (P13)" section - the reserve lives inside
 * `deps.claimOne` itself, not as a separate call here, precisely so it
 * shares ONE transaction with the claim. The P14 successor insertion point,
 * `// P14: contentGuards.evaluate() here`, is likewise now real code, not a
 * comment: `modules/pacing/guards/pipeline.ts#evaluateGuards`, called from
 * `send-loop-claim-evaluation.ts#evaluateOneClaimedJob` - itself called
 * from `send-loop-pacing-claim.ts#claimAndReserve`'s own disposal loop -
 * strictly BEFORE the pacing reserve, inside the SAME `deps.claimOne`
 * transaction. Nothing here changes as a result: `deps.claimOne`'s return
 * type (`ClaimedJob | undefined`) is unchanged, so a content-guard denial,
 * a pacing denial, and an empty band all still resolve to `undefined` here
 * and all correctly mean "nothing claimable on this band right now".)
 */
export async function runOneSendLoopIteration(
  deps: SendLoopDeps,
): Promise<SendLoopIterationResult> {
  const dwrr = deps.dwrr ?? createDwrrSelector();
  const job = await claimAcrossBands(deps, dwrr);
  if (!job) {
    return { claimed: false };
  }

  await dispatchAndResolve(deps, job);
  return { claimed: true };
}
