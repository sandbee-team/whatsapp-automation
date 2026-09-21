/**
 * modules/instances - the ONLY public surface of this module (layering rule
 * §3.2: another module imports only this file, never a sibling directly;
 * enforced by dependency-cruiser's no-deep-module-import). P04b Unit UB1b
 * shipped only the stub Connect-WhatsApp route; P08 Unit U4 adds the real
 * fence-guarded instance state-transition repo/service/ownership port.
 */
export { registerInstancesRoutes, type InstancesRoutesDeps } from './instances.routes.js';

export {
  type InstanceQueryable,
  type InstanceCtx,
  StateWriteLostFenceError,
  createInstance,
  type CreateInstanceInput,
  beginPairingIntent,
  setDesiredState,
  resetPairingWindow,
  softDelete,
  type EngineWriteMeta,
  markLinkedConnected,
  type MarkLinkedConnectedInput,
  incrementQrAttempts,
  type IncrementQrAttemptsResult,
  markPairingExpired,
  markLoggedOut,
  applyTransitionWrite,
  type ApplyTransitionInput,
  readSessionEpoch,
} from './repo.js';

export {
  readLinkStatus,
  type LinkStatus,
  countRegisteredInstances,
  countOnlineInstances,
  listOnlineHolders,
  type OnlineHolder,
  readPlanLimits,
  type PlanLimits,
} from './instance-reads.repo.js';

export {
  setOnlineWithSlotCheck,
  type OnlineSlotPool,
  type OnlineSlotDbClient,
  type SetOnlineWithSlotCheckResult,
} from './instance-online-slot.repo.js';

export {
  applyEngineTransition,
  type ApplyEngineTransitionMeta,
  type InstanceServiceDeps,
  runLoggedOutFlow,
  type LoggedOutFlowInput,
  beginPairing,
  type BeginPairingInput,
} from './service.js';

export { createInstanceOwnership, type InstanceOwnershipDb } from './ownership.js';

export { registerResumeRoute, type ResumeRoutesDeps } from './resume.routes.js';
export { resumeInstance, type ResumeInstanceDeps, type ResumeInstanceInput } from './resume.js';

// 2026-09-15 founder request: DELETE /v1/instances/:id (soft delete).
export { registerDeleteInstanceRoute } from './delete.routes.js';

// 2026-09-17 "QR takes 3-12s to appear" fix: POST /v1/instances/:id/link,
// split out of instances.routes.ts (max-lines cap) so it could gain the new
// `publishDiscoveryWake` call - see link.routes.ts's own doc comment.
export { registerLinkRoute } from './link.routes.js';

// P17 Unit U4 (step 7): the instance card read model.
export { registerCardRoutes, type CardRoutesDeps } from './card.routes.js';
export {
  readInstanceCard,
  InstanceCardNotFoundError,
  type CardServiceCtx,
  type CardServiceRedis,
  type ReadInstanceCardInput,
} from './card.service.js';
