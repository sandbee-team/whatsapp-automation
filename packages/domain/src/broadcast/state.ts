import type { BroadcastStatus } from '../enums/index.js';

/**
 * broadcast/state.ts (P23 Unit U2, step 3) - the ONE transition table for
 * `campaigns.status`. Modelled as an explicit event-driven function (not a
 * bare edge list like `job/state-machine.ts`'s `canTransition`) because one
 * event - `resume` - has two legal destinations depending on context
 * (`ctx.expansionComplete`), which a plain `Record<Status, Status[]>` cannot
 * express without losing the "which event got you there" information the
 * caller needs to log.
 *
 * Table (verbatim from the P23 dispatch):
 *   draft            -schedule->     scheduled
 *   draft|scheduled  -start->        snapshotting
 *   snapshotting     -snapshot_done-> expanding
 *   expanding        -expand_done->  running
 *   running|expanding -pause->       paused
 *   paused           -resume->       ctx.expansionComplete ? running : expanding
 *                                    (throws if ctx is missing - the caller
 *                                    MUST know whether expansion had already
 *                                    finished before asking to resume)
 *   draft|scheduled|snapshotting|expanding|running|paused -cancel-> cancelled
 *   running          -complete->     completed
 *   snapshotting|expanding -fail->   failed
 *
 * `completed`, `cancelled` and `failed` are ABSORBING: no event leaves them,
 * ever (proved exhaustively - full cartesian product of state x event x ctx
 * variant - by `broadcast-state.test.ts`'s
 * `cancelled_and_completed_are_absorbing_states`).
 *
 * EVERY (state, event) pair not listed above throws
 * `IllegalCampaignTransitionError` - there is no silent no-op and no
 * fallthrough default state, matching the same fail-closed posture as
 * `job/state-machine.ts`.
 */

export type CampaignEvent =
  | 'schedule'
  | 'start'
  | 'snapshot_done'
  | 'expand_done'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'complete'
  | 'fail';

export interface NextCampaignStateContext {
  /** Required only for the `resume` event - whether Phase B had already finished before the pause. */
  expansionComplete?: boolean;
}

export class IllegalCampaignTransitionError extends Error {
  readonly from: BroadcastStatus;
  readonly event: CampaignEvent;

  constructor(from: BroadcastStatus, event: CampaignEvent) {
    super(`illegal campaign transition: event "${event}" is not valid from state "${from}"`);
    this.name = 'IllegalCampaignTransitionError';
    this.from = from;
    this.event = event;
  }
}

/** Mirrors the claim predicate's allow-list (`db/queries/claim-jobs.sql`) exactly - never restate it there. */
export const CLAIMABLE_CAMPAIGN_STATUSES = Object.freeze(['running', 'expanding'] as const);

const ABSORBING_STATUSES: ReadonlySet<BroadcastStatus> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

export function isTerminalCampaignStatus(status: BroadcastStatus): boolean {
  return ABSORBING_STATUSES.has(status);
}

export function nextCampaignState(
  current: BroadcastStatus,
  event: CampaignEvent,
  ctx?: NextCampaignStateContext,
): BroadcastStatus {
  if (isTerminalCampaignStatus(current)) {
    throw new IllegalCampaignTransitionError(current, event);
  }

  switch (event) {
    case 'schedule':
      if (current === 'draft') return 'scheduled';
      break;
    case 'start':
      if (current === 'draft' || current === 'scheduled') return 'snapshotting';
      break;
    case 'snapshot_done':
      if (current === 'snapshotting') return 'expanding';
      break;
    case 'expand_done':
      if (current === 'expanding') return 'running';
      break;
    case 'pause':
      if (current === 'running' || current === 'expanding') return 'paused';
      break;
    case 'resume':
      if (current === 'paused') {
        if (ctx?.expansionComplete === undefined) {
          throw new IllegalCampaignTransitionError(current, event);
        }
        return ctx.expansionComplete ? 'running' : 'expanding';
      }
      break;
    case 'cancel':
      if (
        current === 'draft' ||
        current === 'scheduled' ||
        current === 'snapshotting' ||
        current === 'expanding' ||
        current === 'running' ||
        current === 'paused'
      ) {
        return 'cancelled';
      }
      break;
    case 'complete':
      if (current === 'running') return 'completed';
      break;
    case 'fail':
      if (current === 'snapshotting' || current === 'expanding') return 'failed';
      break;
  }

  throw new IllegalCampaignTransitionError(current, event);
}
