/**
 * internal/index.ts (P28 Unit U2, step 3) - the whole `/internal/v1` staff
 * surface's re-export barrel, replacing `src/index.ts`'s old 22-line
 * `from './internal/wallet.js'` block (that barrel sat at exactly 300/300
 * lines - same "split into a sibling module" idiom as `contacts-exports.ts`
 * / `broadcasts-exports.ts`, never trim a contract comment to make room).
 * `internalContract` composes every mutation/read group in this directory;
 * it is NOT added to `appContract` in `router.ts` - it is a distinct
 * staff-only route group, mounted separately by the backend.
 */
export {
  internalMutationHeadersSchema,
  type InternalMutationHeaders,
  staffReasonSchema,
  uuidSchema,
  parseActorHeader,
  type ParsedStaffActor,
  internalMutationResultSchema,
} from './common.js';

export {
  creditClientWalletInputSchema,
  type CreditClientWalletInput,
  creditClientWalletOutputSchema,
  type CreditClientWalletOutput,
  creditClientWalletContract,
  adjustClientWalletInputSchema,
  type AdjustClientWalletInput,
  adjustClientWalletOutputSchema,
  type AdjustClientWalletOutput,
  adjustClientWalletContract,
  freezeClientWalletInputSchema,
  type FreezeClientWalletInput,
  freezeClientWalletOutputSchema,
  type FreezeClientWalletOutput,
  freezeClientWalletContract,
  unfreezeClientWalletInputSchema,
  type UnfreezeClientWalletInput,
  unfreezeClientWalletOutputSchema,
  type UnfreezeClientWalletOutput,
  unfreezeClientWalletContract,
  approveTopupInputSchema,
  type ApproveTopupInput,
  decideTopupOutputSchema,
  type DecideTopupOutput,
  approveTopupContract,
  rejectTopupInputSchema,
  type RejectTopupInput,
  rejectTopupContract,
  listTopupsQuerySchema,
  type ListTopupsQuery,
  listTopupsItemSchema,
  type ListTopupsItem,
  listTopupsOutputSchema,
  type ListTopupsOutput,
  listTopupsContract,
  internalWalletMountContract,
} from './wallet.js';

export {
  clientLimitKeySchema,
  type ClientLimitKey,
  clientLimitOverrideSchema,
  type ClientLimitOverride,
  suspendClientInputSchema,
  type SuspendClientInput,
  suspendClientOutputSchema,
  type SuspendClientOutput,
  suspendClientContract,
  reactivateClientInputSchema,
  type ReactivateClientInput,
  reactivateClientOutputSchema,
  type ReactivateClientOutput,
  reactivateClientContract,
  setClientLimitsInputSchema,
  type SetClientLimitsInput,
  setClientLimitsOutputSchema,
  type SetClientLimitsOutput,
  setClientLimitsContract,
  setClientPricingInputSchema,
  type SetClientPricingInput,
  setClientPricingOutputSchema,
  type SetClientPricingOutput,
  setClientPricingContract,
  setClientPlanInputSchema,
  type SetClientPlanInput,
  setClientPlanOutputSchema,
  type SetClientPlanOutput,
  setClientPlanContract,
  internalClientsContract,
} from './clients.js';

export {
  adminRelaxPatchSchema,
  type AdminRelaxPatch,
  pauseInstanceInputSchema,
  type PauseInstanceInput,
  pauseInstanceOutputSchema,
  type PauseInstanceOutput,
  pauseInstanceContract,
  // ALIASED (P28 U3b) - `resumeInstance*` collides with the TENANT
  // `POST /v1/instances/{id}/resume` contract of the same three names in
  // `../instances.ts`, which `src/index.ts` re-exports BY NAME while
  // re-exporting this directory with `export *`. A named export shadows a
  // star re-export, so the unaliased names resolved to the TENANT schema
  // (no `clientId`) for every `@wp/contracts` importer - see
  // `instances.ts`'s own "NAME COLLISION" doc comment for the 400 that
  // caused. Aliasing here (rather than renaming either schema) keeps both
  // route surfaces' own names intact inside their own modules.
  resumeInstanceInputSchema as staffResumeInstanceInputSchema,
  type ResumeInstanceInput as StaffResumeInstanceInput,
  resumeInstanceOutputSchema as staffResumeInstanceOutputSchema,
  type ResumeInstanceOutput as StaffResumeInstanceOutput,
  resumeInstanceContract as staffResumeInstanceContract,
  pacingOverrideInputSchema,
  type PacingOverrideInput,
  pacingOverrideOutputSchema,
  type PacingOverrideOutput,
  pacingOverrideContract,
  internalInstancesContract,
} from './instances.js';

export {
  cancelCampaignInputSchema,
  type CancelCampaignInput,
  cancelCampaignOutputSchema,
  type CancelCampaignOutput,
  cancelCampaignContract,
  internalCampaignsContract,
} from './campaigns.js';

export {
  grantImpersonationInputSchema,
  type GrantImpersonationInput,
  grantImpersonationOutputSchema,
  type GrantImpersonationOutput,
  grantImpersonationContract,
  mintImpersonationTokenInputSchema,
  type MintImpersonationTokenInput,
  mintImpersonationTokenOutputSchema,
  type MintImpersonationTokenOutput,
  mintImpersonationTokenContract,
  elevateImpersonationInputSchema,
  type ElevateImpersonationInput,
  elevateImpersonationOutputSchema,
  type ElevateImpersonationOutput,
  elevateImpersonationContract,
  revokeImpersonationInputSchema,
  type RevokeImpersonationInput,
  revokeImpersonationOutputSchema,
  type RevokeImpersonationOutput,
  revokeImpersonationContract,
  impersonationGrantItemSchema,
  type ImpersonationGrantItem,
  listImpersonationGrantsOutputSchema,
  type ListImpersonationGrantsOutput,
  listImpersonationGrantsContract,
  internalImpersonationContract,
} from './impersonation.js';

export {
  planLimitsSchema,
  type PlanLimits,
  planItemSchema,
  type PlanItem,
  listPlansOutputSchema,
  type ListPlansOutput,
  listPlansContract,
  internalPlansContract,
} from './plans.js';

import { internalClientsContract } from './clients.js';
import { internalWalletMountContract } from './wallet.js';
import { internalInstancesContract } from './instances.js';
import { internalCampaignsContract } from './campaigns.js';
import { internalImpersonationContract } from './impersonation.js';
import { internalPlansContract } from './plans.js';

/** Namespace object for the whole `internal/` staff surface, mounted under `/internal/v1`. */
export const internalContract = {
  clients: internalClientsContract,
  wallet: internalWalletMountContract,
  instances: internalInstancesContract,
  campaigns: internalCampaignsContract,
  impersonation: internalImpersonationContract,
  plans: internalPlansContract,
} as const;
