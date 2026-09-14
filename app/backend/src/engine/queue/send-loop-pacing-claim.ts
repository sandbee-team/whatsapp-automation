import type { Rng } from '@wp/domain';
import type { TenantDb } from '@wp/db';
import {
  claimOne as claimOneProd,
  type ClaimOneCtx,
  type ClaimOneInput,
  type ClaimedJob,
} from '../../modules/queue/queue.repo.js';
import { evaluateOneClaimedJob } from './send-loop-claim-evaluation.js';
import { fetchBlockedWordEntries } from '../../modules/pacing/content/blocked-words.js';

/**
 * send-loop-pacing-claim.ts (P13 Unit U4, step 7; P14 Unit U6, step 7) -
 * `claimAndReserve`, the ONE function that combines `claimOne()`, the
 * content-guard pipeline (`modules/pacing/guards/pipeline.ts#evaluateGuards`,
 * via `send-loop-claim-evaluation.ts#evaluateOneClaimedJob`), and
 * `engine/pacing/index.ts#reserve()` inside a SINGLE `tenantDb.withTenant`
 * transaction, per `send-loop.ts`'s own module doc ("PACING (P13)" /
 * insertion comment now updated to point here). Split out of
 * `send-loop-worker-wiring.ts` (and, at P14 Unit U6, further split into
 * `send-loop-claim-evaluation.ts` + `send-loop-guard-pipeline-wiring.ts`)
 * purely for max-lines caps - same established split idiom as
 * `session-worker-discovery-wiring.ts`.
 *
 * ORDER, all inside ONE transaction, one pass:
 *   - Zero rows from `claimOne` itself: nothing to evaluate - the loop ends,
 *     resolves `undefined` (band-empty shape, `send-loop.ts` falls through
 *     to the next band).
 *   - A TERMINAL guard denial (OPT_OUT/BLOCKED_WORD/LINK_IN_FIRST_MESSAGE):
 *     the job is disposed (`dispose-job.sql`) and the loop CLAIMS AGAIN in
 *     the SAME transaction (the disposed row is no longer `'queued'`, so
 *     `claim-jobs.sql` naturally skips it) - up to `MAX_DISPOSALS_PER_PASS`
 *     (25) disposals in one pass, per the phase file's normative shape.
 *   - A non-terminal guard deferral, a pacing NO_LEDGER_ROW, or a pacing
 *     DENIAL: none of these is a rollback (core invariant 5, "pause
 *     preserves work") - the transaction WRITES the deferral (`defer-job.
 *     sql`: `status='queued', next_attempt_at=<retryAt>,
 *     pacing_deny_reason=<reason>, pacing_deferrals + 1`, lease fields
 *     cleared - `attempts` NEVER touched) and COMMITS, then the loop STOPS
 *     (resolves `undefined`, band-empty shape) - a pacing/guard denial is
 *     evaluated per JOB but a pacing denial in particular denies the whole
 *     INSTANCE, so trying another job in the same pass would just re-deny
 *     identically.
 *   - A GRANT from `reserve()`: commits normally, returns the claimed job -
 *     `dispatch()` (outside this transaction, per `dispatch.ts`'s own
 *     two-phase shape) proceeds next.
 */

/**
 * The content-guard pipeline's per-pass disposal cap (P14 Unit U6, phase
 * step 7, normative shape). A single `claimAndReserve` call keeps claiming
 * and disposing TERMINALLY-denied jobs (opted-out / blocked-word / link-
 * in-first-message) within the SAME transaction, up to this many, before
 * giving up the pass and resolving `undefined` (band-empty shape) so the
 * caller's own wake/timer/poll drives the next pass. Unbounded draining
 * inside one transaction would hold the transaction open indefinitely
 * against a large opted-out backlog (e.g. 10,000 queued jobs to a contact
 * who just opted out) - this cap keeps one pass's worst case bounded while
 * still making real forward progress every pass.
 */
const MAX_DISPOSALS_PER_PASS = 25;

export interface ClaimAndReserveDeps {
  tenantDb: TenantDb;
  rng: Rng;
  clock: { now(): number };
  claimOne?: (ctx: ClaimOneCtx, input: ClaimOneInput) => Promise<ClaimedJob | undefined>;
  /** Metrics hook - fired once per pacing denial, labelled by `reason`. Defined locally in this module's caller (see `metrics.ts` in this same directory) - P13a consolidates pacing metrics into `engine/pacing/metrics.ts`, which does not exist yet. */
  onPacingDeny?: (reason: string) => void;
  /** Metrics hook (P14 Unit U6) - fired once per content-guard trip (terminal disposal OR non-terminal defer), labelled by `reason`. Wired to `wp_content_guard_trips_total{reason}` (and, for `OPT_OUT` specifically, also `wp_optout_cancelled_jobs_total`) by the caller - see `metrics.ts`. */
  onGuardTrip?: (reason: string) => void;
}

/**
 * Claims exactly one job for `(ctx.clientId, input.instanceId, input.band)`
 * and, if claimed, evaluates the content-guard pipeline then reserves a
 * pacing unit, all in the SAME transaction - see module doc for the full
 * contract and `send-loop-claim-evaluation.ts#evaluateOneClaimedJob` for
 * the per-job decision itself. `isGroup`/`isNewConversation` are derived
 * from the claimed job's own `recipient_jid`/`is_new_conversation` columns
 * (never re-decided at the pacing layer - the job's own stored
 * classification is authoritative, same discipline as `release()`'s own
 * "read back from the job, never re-derive" rule).
 */
export function claimAndReserve(deps: ClaimAndReserveDeps) {
  const claimOneFn = deps.claimOne ?? claimOneProd;

  return async (ctx: ClaimOneCtx, input: ClaimOneInput): Promise<ClaimedJob | undefined> =>
    deps.tenantDb.withTenant(ctx.clientId, async (tx) => {
      // MINOR 14 (P14 review-fix F2): fetched + compiled ONCE per pass (one
      // instance/client per `claimAndReserve` call - the tenant's own
      // `tenant_blocked_words` rows cannot change mid-pass), reused for
      // every job the disposal loop below evaluates - never re-fetched or
      // re-compiled per job.
      const blockedWordEntries = await fetchBlockedWordEntries(tx, ctx.clientId);

      for (let disposals = 0; disposals < MAX_DISPOSALS_PER_PASS; disposals += 1) {
        const claimed = await claimOneFn({ ...ctx, sql: tx }, input);
        if (!claimed) {
          return undefined;
        }

        const result = await evaluateOneClaimedJob(
          deps,
          tx,
          ctx,
          input,
          claimed,
          blockedWordEntries,
        );
        if (result.kind === 'stop') {
          return result.job;
        }
        // 'disposed': loop again, claiming the next eligible job in this
        // same transaction/pass.
      }

      // Disposal cap reached this pass - the next pass (triggered by the
      // caller's own wake/timer/poll) continues the drain.
      return undefined;
    });
}
