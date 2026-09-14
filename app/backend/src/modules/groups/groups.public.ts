/**
 * groups.public.ts (P24 Unit U3) - the tenant-facing groups surface's public
 * export set: HTTP route registration, its deps type, the worker-side sync/
 * leave entry points and timer factory, and the typed error classes.
 * Re-exported through `modules/groups/index.ts`'s barrel alongside U4a's
 * `send-lookup.public.ts` and U4b's `forbidden.public.ts`.
 */
export { registerGroupsRoutes, type GroupRoutesDeps } from './groups.routes.js';
export {
  listGroupsForInstance,
  requestGroupLeave,
  type GroupsServiceDeps,
  type ListGroupsResult,
} from './groups.service.js';
export { setGroupSendEnabled } from './groups-send-enabled.service.js';
export {
  requestGroupSync,
  type GroupsSyncRequestServiceDeps,
  type RequestGroupSyncResult,
} from './groups-sync-request.service.js';
export {
  GroupInstanceNotFoundError,
  GroupNotFoundError,
  GroupNotSendableError,
  GroupSyncRateLimitedError,
  IdempotencyKeyRequiredError as GroupIdempotencyKeyRequiredError,
} from './groups.errors.js';
export { runGroupSyncForInstance, type RunGroupSyncDeps, type GroupSocketPort } from './sync.js';
export { runPendingGroupLeaves } from './sync-worker.js';
// `buildGroupsSyncTimer` lives in `engine/session/session-groups-sync-timer.ts`
// (it needs `SessionRunnerRegistry`, an `engine/session` concept) - NOT
// re-exported from this module's own barrel to avoid a circular import
// (`engine/session/session-groups-sync-timer.ts` itself imports from
// `modules/groups/index.js`); `roles/session-worker.ts` imports it directly.
