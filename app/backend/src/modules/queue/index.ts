/**
 * modules/queue - the canonical claim module (P03 Unit B, step 6). Barrel
 * export only; no logic lives here.
 */
export {
  claimOne,
  type ClaimedJob,
  type ClaimOneCtx,
  type ClaimOneInput,
  type QueueQueryable,
} from './queue.repo.js';

export { registerUnresolvedRoutes, type UnresolvedRoutesDeps } from './unresolved.routes.js';

export {
  retryUnresolved,
  discardUnresolved,
  assertUserActor,
  UnresolvedActorForbiddenError,
  UnresolvedJobNotFoundError,
  type UnresolvedActor,
  type UnresolvedActorKind,
  type UnresolvedActionDeps,
  type UnresolvedActionInput,
  type RetryUnresolvedResult,
  type DiscardUnresolvedResult,
} from './unresolved.service.js';

export {
  createCountingNoOpRepairedSendSink,
  type RepairedSendSink,
  type CountingRepairedSendSink,
} from './repaired-send-sink.js';
