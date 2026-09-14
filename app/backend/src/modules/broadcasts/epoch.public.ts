/**
 * epoch.public.ts (P23 Unit U6) - the epoch-half public surface: the
 * epoch-stranding sweep, its fleet-wide gauge recount, and
 * `POST /v1/broadcasts/:id/restamp`. Outside callers import from
 * `modules/broadcasts/index.js` only (this file is re-exported there).
 * `RestampRoutesDeps.tenantDb` stays required (U5 calls
 * `registerRestampRoutes` with `{ tenantDb }` only); every other field is
 * optional so that call site keeps compiling unchanged.
 */
export {
  runEpochStrandingSweep,
  countStrandedEpochJobs,
  type EpochSweepDeps,
  type EpochGaugePool,
  type RunEpochStrandingSweepInput,
  type RunEpochStrandingSweepResult,
} from './epoch-sweep.js';

export {
  restampBroadcast,
  assertRestampUserActor,
  RestampCountMismatchError,
  type RestampActor,
  type RestampActorKind,
  type RestampBroadcastDeps,
  type RestampBroadcastInput,
  type RestampBroadcastResult,
} from './restamp.service.js';

export { registerRestampRoutes, type RestampRoutesDeps } from './restamp.routes.js';
