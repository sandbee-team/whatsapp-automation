/**
 * lifecycle.public.ts (P23 Unit U5) - the lifecycle-half public surface:
 * repo, lifecycle service (create/start/pause/resume/cancel + read paths),
 * cancel bookkeeping, and route registration. Outside callers import from
 * `modules/broadcasts/index.js` only (this file is re-exported there).
 */
export {
  createCampaign,
  readCampaign,
  listCampaigns,
  transition,
  readCounters,
  countDeferredRecipients,
  findInstanceForClient,
  type CreateCampaignInput,
  type CampaignSummaryRow,
  type ListCampaignsInput,
  type TransitionInput,
  type CountersRow,
} from './broadcasts.repo.js';

export {
  BroadcastNotFoundError,
  InstanceNotFoundError,
  BroadcastActorForbiddenError,
  IllegalBroadcastTransitionError,
  IdempotencyKeyRequiredError,
} from './broadcasts.errors.js';

export {
  runCancelBookkeepingBatch,
  runOneCancelBookkeepingSweep,
  type CancelBookkeepingResult,
  type CancelBookkeepingSweepDeps,
} from './cancel-bookkeeping.js';

export type { BroadcastDetail, LifecycleDeps, ListBroadcastsResult } from './lifecycle-detail.js';

export {
  assertUserActor,
  createBroadcast,
  startBroadcast,
  pauseBroadcast,
  resumeBroadcast,
  cancelBroadcast,
  getBroadcast,
  listBroadcasts,
  type BroadcastActor,
  type BroadcastActorKind,
  type CreateBroadcastServiceInput,
} from './lifecycle.service.js';

export { registerBroadcastRoutes, type BroadcastRoutesDeps } from './broadcasts.routes.js';

// P28 U3b: the caller's-transaction half of a cancel, shared by the tenant
// route and the staff `/internal/v1/campaigns/:id/cancel` route (which runs
// it inside `withStaffMutation`'s own transaction). `assertUserOrStaffActor`
// is exported for CANCEL's use only - every other lifecycle mutation still
// goes through `assertUserActor`; see `lifecycle-cancel-in-tx.ts`'s header.
export {
  cancelBroadcastInTx,
  assertUserOrStaffActor,
  STAFF_CANCEL_REASON,
  type CancelBroadcastInTxInput,
} from './lifecycle-cancel-in-tx.js';
