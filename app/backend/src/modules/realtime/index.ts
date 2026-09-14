/**
 * modules/realtime - the ONLY public surface of this module (layering rule
 * §3.2: another module imports only this file, never a sibling directly;
 * enforced by dependency-cruiser's no-deep-module-import).
 */
export { registerRealtimeRoutes, type RealtimeRoutesDeps } from './routes.js';
export {
  createRealtimeHub,
  type RealtimeHub,
  type RealtimeConnectionInput,
  type RealtimeConnectionSnapshot,
  type DropReason,
  type PublishInput,
  type ReplayResult,
  type SseFrameLike,
} from './hub.js';
export {
  type InstanceOwnershipPort,
  failClosedInstanceOwnership,
  type RealtimeCtx,
  TooManyConnectionsError,
} from './service.js';
export { loadAuthzSnapshot, type AuthzSnapshotRow, type ClientStatus } from './authz.repo.js';
export {
  createAuthzTick,
  type AuthzTick,
  type AuthzTickLoggerPort,
  type AuthzTickMetricsPort,
  type CreateAuthzTickOptions,
  type TickResult,
} from './authz-tick.js';
export { bindRealtimeMetrics, type RealtimeMetricsHandles } from './metrics.js';
