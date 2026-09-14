/**
 * broadcasts-exports.ts (P23 Unit U2, step 3) - the broadcast/campaign
 * re-export block split out of `index.ts` (that barrel breached the
 * `max-lines: 300` cap once this block was added inline). Sibling-module
 * split, same idiom as `contacts-exports.ts` / `packages/domain/src/
 * enums-exports.ts` - never trim a contract comment to make room, split
 * instead.
 */
export {
  broadcastAudienceSchema,
  type BroadcastAudience,
  broadcastMessageSchema,
  type BroadcastMessage,
  createBroadcastInputSchema,
  type CreateBroadcastInput,
  broadcastStatusSchema,
  type BroadcastStatusContract,
  broadcastRecipientStatusSchema,
  type BroadcastRecipientStatusContract,
  campaignCountersSchema,
  type CampaignCounters,
  broadcastSummarySchema,
  type BroadcastSummary,
  broadcastDetailSchema,
  type BroadcastDetail,
  listBroadcastsQuerySchema,
  type ListBroadcastsQuery,
  cancelBroadcastInputSchema,
  type CancelBroadcastInput,
  restampInputSchema,
  type RestampInput,
  broadcastMutationHeadersSchema,
  type BroadcastMutationHeaders,
  createBroadcastOutputSchema,
  type CreateBroadcastOutput,
  createBroadcastContract,
  listBroadcastsOutputSchema,
  type ListBroadcastsOutput,
  listBroadcastsContract,
  getBroadcastInputSchema,
  type GetBroadcastInput,
  getBroadcastOutputSchema,
  type GetBroadcastOutput,
  getBroadcastContract,
  cancelBroadcastOutputSchema,
  type CancelBroadcastOutput,
  cancelBroadcastContract,
  restampOutputSchema,
  type RestampOutput,
  restampContract,
  broadcastsContract,
} from './app/broadcasts.js';
// P23a step 2 - the pre-flight quote (sibling file, `broadcasts.ts` sits near the cap).
export {
  BROADCAST_PREFLIGHT_OPTIONS,
  broadcastPreflightOptionSchema,
  type BroadcastPreflightOption,
  broadcastPreflightSkipReasonSchema,
  type BroadcastPreflightSkipReason,
  broadcastPreflightSchema,
  type BroadcastPreflight,
  preflightBroadcastInputSchema,
  type PreflightBroadcastInput,
  preflightBroadcastOutputSchema,
  type PreflightBroadcastOutput,
  preflightBroadcastContract,
} from './app/broadcasts-preflight.js';
