/**
 * broadcast/index.ts (P23 Unit U2, step 3) - the module's public re-export
 * surface, per the layering convention every other `@wp/domain` submodule
 * follows (see `contacts/index.ts`, `inbound/index.ts`).
 *
 * `BROADCAST_DISCLOSURE` is NOT re-exported here - it already lives in
 * `copy/disclosures.ts` and is exported once from the package root
 * (`packages/domain/src/index.ts`); a second export of the same name from
 * this barrel would collide when both are star-exported from the root.
 */
export {
  nextCampaignState,
  IllegalCampaignTransitionError,
  CLAIMABLE_CAMPAIGN_STATUSES,
  isTerminalCampaignStatus,
  type CampaignEvent,
  type NextCampaignStateContext,
} from './state.js';

export {
  TEMPLATE_TOKEN_RE,
  extractTemplateTokens,
  freezeVars,
  renderVars,
  missingVarSkipReason,
  type FreezeVarsResult,
  type RenderVarsResult,
} from './vars.js';
