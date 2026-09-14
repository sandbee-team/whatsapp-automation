/**
 * preflight.public.ts (P23a Unit U1a, step 2) - the pre-flight-quote public
 * surface (repo, service). Pre-created empty by the main session so
 * parallel units never edit one shared barrel; U1a fills it. Outside
 * callers import from `modules/broadcasts/index.js` only.
 */
export {
  preflightBroadcast,
  computeEstimate,
  computeQuoteMinor,
  computeBillable,
  type ComputeEstimateInput,
  type EstimateResult,
  type ComputeBillableInput,
  type BillableResult,
  type PreflightBroadcastInput,
} from './preflight.service.js';
export {
  PreflightNotAllowedError,
  PreflightAudienceOverLimitError,
  PreflightNoPlanError,
} from './broadcasts.errors.js';
