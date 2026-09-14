/**
 * modules/inbound - the ONLY public surface of this module (layering rule
 * §3.2, enforced by dependency-cruiser's no-deep-module-import). P21: the
 * headless inbound listener (delivery receipts, STOP/opt-out detection,
 * dead letters, admission shedding). U6b (engine/session wiring) imports
 * ONLY from this index, never a sibling file directly.
 */

// U6a, step 7: the headless dispatcher + the dead-letter writer + metrics.
export {
  createInboundDispatcher,
  type InboundDispatcherDeps,
  type InboundDispatcher,
} from './handler.js';
export {
  writeInboundDeadLetter,
  classifyInboundError,
  approximateRawSize,
  type DeadLetterDeps,
  type DeadLetterInput,
} from './dead-letter.js';
export { bindInboundMetrics, type InboundMetricsHandles } from './metrics.js';

// C1 fix round: the per-worker bounded in-flight limiter guarding the
// socket handlers from an unbounded fire-and-forget burst.
export {
  createInflightLimiter,
  type InflightLimiter,
  type InflightLimiterDeps,
  type InflightKind,
} from './inflight-limiter.js';

// U5, step 6: the per-instance inbound admission token bucket.
export {
  createInboundAdmission,
  bindInboundBucketCommand,
  readInboundLimitFromDb,
  type InboundAdmission,
  type InboundAdmissionDeps,
  type InboundBucketPort,
  type AdmissionDecision,
} from './admission.js';

// U4, step 5: the message-signals transaction (contact touch + opt-out).
export {
  handleInboundMessageSignals,
  resolveLidFromContacts,
  type InboundMessageSignal,
  type MessageSignalsDeps,
  type MessageSignalsOutcome,
} from './message-signals.js';

// U3, step 4: delivery receipts parsed from Baileys events + recorded.
export {
  recordInboundReceipt,
  receiptsFromMessagesUpdate,
  receiptsFromReceiptUpdate,
  type InboundReceipt,
  type RecordReceiptDeps,
  type RecordReceiptOutcome,
  type ReceiptEventType,
} from './receipts.js';

// P14 opt-out keyword detection (this phase's caller is message-signals.ts;
// re-exported here so anything outside modules/inbound reaches it through
// this barrel too).
export {
  detectInboundOptOut,
  type DetectInboundOptOutDeps,
  type DetectInboundOptOutInput,
  type DetectInboundOptOutResult,
} from './optout-detect.js';

// P25 Unit U3 (observability-and-runbook) - the hourly per-client opt-out
// rate check. Re-exported here for API completeness; `engine/cron/cron-
// wiring-rollups.ts` imports the file directly instead (this barrel
// transitively reaches `modules/groups` -> `provider/baileys`/`engine/
// session` via `message-signals.ts`, which `cron-loop-shape.test.ts`
// structurally forbids for anything `roles/cron.ts` reaches).
export {
  runOptoutRateCheck,
  OPTOUT_RATE_THRESHOLD_PER_THOUSAND,
  OPTOUT_RATE_MIN_SENDS,
  OPTOUT_RATE_MAX_CLIENTS_PER_RUN,
  type RunOptoutRateCheckDeps,
  type RunOptoutRateCheckResult,
  type OptoutRateCheckPool,
} from './optout-rate-check.js';
