/**
 * engine.public.ts (P23 Unit U4) - the engine-half public surface: Phase A
 * snapshot worker, Phase B ref-first expansion worker, the expansion token
 * bucket, and the shared audience/limits helpers. Outside callers import
 * from `modules/broadcasts/index.js` only (this file is re-exported there).
 */
export {
  runSnapshotBatch,
  runSnapshotToCompletion,
  runOneBroadcastSnapshotSweep,
  type SnapshotBatchResult,
  type SnapshotBatchDeps,
  type SnapshotSweepDeps,
} from './snapshot.worker.js';

export {
  runExpansionBatch,
  runExpansionToCompletion,
  runOneBroadcastExpansionSweep,
  type ExpansionBatchResult,
  type ExpansionBatchDeps,
  type ExpansionSweepDeps,
} from './expansion.worker.js';

export {
  createExpansionBudget,
  type ExpansionBudget,
  type ExpansionBudgetClock,
  type ExpansionBudgetOptions,
} from './expansion-budget.js';

export { BroadcastLimitError, resolveEffectiveMaxBroadcastRecipients } from './limits.js';
export { audienceMatchParams, type BroadcastAudienceJson } from './audience.js';
