/**
 * modules/pacing - the ONLY public surface of this module (layering rule
 * §3.2, enforced by dependency-cruiser's no-deep-module-import). P14 Unit
 * U7: the duplicate fan-out ack surface (`POST /v1/pacing/fanout-acks`,
 * `GET /v1/pacing/fanout-acks/pending`).
 */
export { registerAckFanoutRoutes, type AckFanoutRoutesDeps } from './routes/ack-fanout.routes.js';

export {
  ackFanout,
  listPendingFanoutAcks,
  type AckFanoutDeps,
  type AckFanoutInput,
  type AckFanoutResult,
  type PendingFanoutAckItem,
} from './routes/ack-fanout.js';

// P14 opt-out registry public surface (C5 depcruise fix: sibling modules
// import through THIS index, never modules/pacing/optout/* directly).
// `internal/system-send.ts` is deliberately NOT re-exported here: its
// exempt-origin identifiers may only be referenced under pacing/internal/
// (check-send-origin clause (a)), and nothing outside the engine wiring may
// construct an exempt send.
//
// `hashRecipient` MOVED to `platform/crypto/phone-hash.ts` in P20 Unit U2
// (step 3) - it is no longer re-exported here; callers import it directly
// from its new home (it is not a `modules/pacing` concern, it is a shared
// crypto primitive several modules join through).
export {
  cancelOptOutJobs,
  encodeOptOutSealedBlob,
  isOptedOut,
  recordOptOut,
  sealPhoneForOptOut,
  type OptOutScope,
  type OptOutMirrorPort,
  type RecordOptOutDeps,
} from './optout/registry.js';
export {
  restoreOptOut,
  ForbiddenRestoreActorError,
  OptOutNotFoundError,
} from './optout/restore.js';
// P16: the ONLY paused-exit writer, re-exported so modules/instances' resume
// route reaches it through this barrel (depcruise no-deep-module-import).
export {
  humanResume,
  type HumanResumeInput,
  type HumanResumeResult,
} from './health/human-resume.js';
// P28 U3b: the ONE staff-initiated pause writer, re-exported so
// `modules/internal`'s instance routes reach it through this barrel
// (depcruise no-deep-module-import). `UserActor` travels with it because the
// internal resume route must CONSTRUCT a `{type:'staff_user'}` actor for
// `humanResume`, and that type lives under `health/` too.
export { staffPause, type StaffPauseInput, type StaffPauseResult } from './health/staff-pause.js';
export type { UserActor } from './health/transitions.js';
// C1 review round 2 MINOR fix: `staffPause` no longer sets the gauge itself
// (see that module's own doc) - `modules/internal/routes/instances.ts` sets
// it in `tx.afterCommit` instead, and needs this re-export to reach it
// (depcruise no-deep-module-import).
export { setInstanceHealthStateGauge } from './health/metrics.js';

// P28 U3b: the `instance_pacing_overrides` admin-relax writer/readers - used
// by `modules/internal/routes/pacing.ts` (the write path) through this
// barrel. `engine/pacing/admin-relax-expiry.ts` (the expiry sweep) deep-
// imports `./pacing-overrides.repo.js` / `./pacing.repo.js` directly instead
// (same precedent as every other `engine/pacing/**` and `engine/queue/**`
// caller of `modules/pacing/**` - see e.g. `engine/pacing/config-service.ts`,
// `engine/queue/dispatch-optout-precheck.ts`): going through THIS barrel
// would pull in every other re-export's transitive graph too (notably
// `system-send.ts` -> `modules/messages` -> `modules/instances`, which
// reaches `provider/baileys/auth-state/**` and `engine/session/metrics.ts`)
// and the cron process must never reach either (ADR 0014,
// `engine/cron/cron-loop-shape.test.ts`).
export {
  insertAdminRelaxOverride,
  selectExpiredAdminRelaxOverrides,
  markAdminRelaxExpiryApplied,
  readActiveAdminRelaxOverride,
  type InsertAdminRelaxOverrideInput,
  type ExpiredAdminRelaxRow,
  type ActiveAdminRelaxRow,
} from './pacing-overrides.repo.js';
export type { PacingQueryable as PacingSweepQueryable } from './pacing.repo.js';

// P17 Unit U4 (step 8): the "why?" drawer read model.
export { registerWhyRoutes, type WhyRoutesDeps } from './health/why.routes.js';
export {
  readHealthWhy,
  HealthWhyNotFoundError,
  type ReadHealthWhyInput,
} from './health/why.service.js';

// P21 Unit U4 (step 5): `bindOptOutConfirmationSender` is the post-commit
// `onOptedOut` port the inbound handler wires - re-exported (types + the one
// binder function ONLY) because `no-deep-module-import` forbids reaching
// into `modules/pacing/internal/` from `modules/inbound`. The exempt-origin
// identifiers (`SYSTEM_REPLY`/`OPT_OUT_CONFIRMATION`) and `sendOptOutConfirmation`
// itself are deliberately NOT re-exported here (`scripts/check-send-origin.ts`
// clause (a) - they may only be referenced under `modules/pacing/internal/`).
export {
  bindOptOutConfirmationSender,
  type SendOptOutConfirmationDeps,
  type SendOptOutConfirmationInput,
  type SendOptOutConfirmationResult,
  type OnOptedOutPort,
  type SystemSendLogger,
} from './internal/system-send.js';
