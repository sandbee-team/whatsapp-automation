/**
 * admin/index.ts (P28 Unit U4, step 9) - the whole `/admin/v1` STAFF
 * surface's re-export barrel and the `adminContract` namespace object.
 *
 * Unit U6 (the admin frontend) consumes ONLY this file, so it is the single
 * wire definition both sides compile against: a projection change that
 * forgot the panel fails to compile rather than rendering `undefined`.
 *
 * `adminContract` is deliberately NOT added to `appContract` in
 * `router.ts` - it is a distinct, staff-only route group served by a
 * SEPARATE process (`admin/backend`), mounted at a separate origin. Mixing
 * the two namespaces would let a tenant-facing client discover admin route
 * shapes from a shared router type.
 */
export {
  paiseStringSchema,
  type PaiseString,
  isoTimestampSchema,
  adminListQuerySchema,
  type AdminListQuery,
  adminPage,
  adminPageOutput,
  staffReadReasonHeaderSchema,
  adminMutationReasonSchema,
  type AdminMutationReason,
  adminMutationHeadersSchema,
  type AdminMutationHeaders,
  adminMutationResultSchema,
  adminMutationOutputSchema,
  type AdminMutationOutput,
} from './common.js';

export {
  staffRoleSchema,
  type StaffRoleContract,
  staffLoginInputSchema,
  type StaffLoginInput,
  staffSessionDataSchema,
  type StaffSessionData,
  staffSessionOutputSchema,
  type StaffSessionOutput,
  staffLoginContract,
  staffRefreshContract,
  staffLogoutOutputSchema,
  staffLogoutContract,
  staffMeDataSchema,
  type StaffMeData,
  staffMeOutputSchema,
  staffMeContract,
  adminAuthContract,
} from './auth.js';

export {
  adminClientStatusSchema,
  adminClientListItemSchema,
  type AdminClientListItem,
  adminListClientsQuerySchema,
  type AdminListClientsQuery,
  adminListClientsOutputSchema,
  type AdminListClientsOutput,
  adminListClientsContract,
  adminPlanLimitsSchema,
  adminClientLimitsSchema,
  adminClientPricingSchema,
  adminImpersonationGrantSchema,
  type AdminImpersonationGrant,
  adminClientDetailSchema,
  type AdminClientDetail,
  adminClientDetailOutputSchema,
  adminGetClientContract,
  adminSuspendClientContract,
  adminReactivateClientContract,
  adminSetClientLimitsInputSchema,
  adminSetClientLimitsContract,
  adminSetClientPricingInputSchema,
  adminSetClientPricingContract,
  adminSetClientPlanInputSchema,
  adminSetClientPlanContract,
  adminClientsContract,
} from './clients.js';

export {
  adminInstanceItemSchema,
  type AdminInstanceItem,
  adminListInstancesQuerySchema,
  type AdminListInstancesQuery,
  adminListInstancesOutputSchema,
  type AdminListInstancesOutput,
  adminListInstancesContract,
  adminPauseInstanceContract,
  adminResumeInstanceContract,
  adminPacingOverrideInputSchema,
  adminPacingOverrideContract,
  adminCancelCampaignContract,
  adminInstancesContract,
} from './instances.js';

export {
  adminQueueSummarySchema,
  type AdminQueueSummary,
  adminQueueSummaryOutputSchema,
  type AdminQueueSummaryOutput,
  adminQueueSummaryContract,
  adminPlanItemSchema,
  type AdminPlanItem,
  adminListPlansOutputSchema,
  type AdminListPlansOutput,
  adminListPlansContract,
  adminQueueContract,
} from './queue.js';

export {
  adminWalletStateSchema,
  adminWalletHeaderSchema,
  type AdminWalletHeader,
  adminWalletLedgerItemSchema,
  type AdminWalletLedgerItem,
  adminWalletLedgerOutputSchema,
  type AdminWalletLedgerOutput,
  adminWalletLedgerContract,
  adminTopupItemSchema,
  type AdminTopupItem,
  adminListTopupsQuerySchema,
  adminListTopupsOutputSchema,
  adminListTopupsContract,
  adminCreditWalletInputSchema,
  adminCreditWalletContract,
  adminAdjustWalletInputSchema,
  adminAdjustWalletContract,
  adminFreezeWalletContract,
  adminUnfreezeWalletContract,
  adminApproveTopupContract,
  adminRejectTopupContract,
  adminWalletContract,
} from './wallet.js';

export {
  adminStaffAuditItemSchema,
  type AdminStaffAuditItem,
  adminListAuditQuerySchema,
  type AdminListAuditQuery,
  adminListAuditOutputSchema,
  type AdminListAuditOutput,
  adminListAuditContract,
  adminAuditContract,
} from './audit.js';

export {
  impersonationScopeSchema,
  type ImpersonationScope,
  adminGrantImpersonationInputSchema,
  type AdminGrantImpersonationInput,
  adminImpersonationTokenDataSchema,
  type AdminImpersonationTokenData,
  adminImpersonationTokenOutputSchema,
  adminGrantImpersonationContract,
  adminMintImpersonationTokenContract,
  adminElevateImpersonationContract,
  adminRevokeImpersonationContract,
  adminImpersonationContract,
} from './impersonation.js';

import { adminAuthContract } from './auth.js';
import { adminClientsContract } from './clients.js';
import { adminInstancesContract } from './instances.js';
import { adminQueueContract } from './queue.js';
import { adminWalletContract } from './wallet.js';
import { adminAuditContract } from './audit.js';
import { adminImpersonationContract } from './impersonation.js';

/** The whole `/admin/v1` surface, grouped by area - what Unit U6's typed client is built from. */
export const adminContract = {
  auth: adminAuthContract,
  clients: adminClientsContract,
  instances: adminInstancesContract,
  queue: adminQueueContract,
  wallet: adminWalletContract,
  audit: adminAuditContract,
  impersonation: adminImpersonationContract,
} as const;
