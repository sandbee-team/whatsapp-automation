/**
 * funnel.public.ts (P23a Unit U2, step 4) - the progress-funnel public
 * surface (counter recompute, `completed` writer, `campaign.progress` emit,
 * the cross-tenant recompute sweep). Pre-created empty by the main session so
 * parallel units never edit one shared barrel; U2 fills it. Outside callers
 * import from `modules/broadcasts/index.js` only.
 */
export {
  recountRecipients,
  reconcileCounters,
  completeIfDrained,
  progressPayloadFor,
  emitProgress,
  recomputeCampaignFunnel,
  type ReconcileResult,
  type RecomputeCampaignFunnelInput,
  type RecomputeCampaignFunnelResult,
} from './funnel.repo.js';
export {
  runOneFunnelRecomputeSweep,
  createFunnelActiveCursor,
  type FunnelRecomputeSweepPool,
  type FunnelActiveCursor,
  type RunOneFunnelRecomputeSweepDeps,
} from './funnel.sweep.js';
