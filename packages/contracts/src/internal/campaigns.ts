import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import { staffReasonSchema, uuidSchema, internalMutationResultSchema } from './common.js';

/**
 * internal/campaigns.ts (P28 Unit U2, step 3) - the staff broadcast-cancel
 * mutation. `clientId` travels in the body so the handler can verify tenant
 * scoping before touching the campaign (core invariant 4).
 */

export const cancelCampaignInputSchema = z
  .object({ clientId: uuidSchema, reason: staffReasonSchema })
  .strict();
export type CancelCampaignInput = z.infer<typeof cancelCampaignInputSchema>;

export const cancelCampaignOutputSchema = successEnvelope(
  internalMutationResultSchema({
    campaignId: uuidSchema,
    status: z.literal('cancelled'),
  }),
);
export type CancelCampaignOutput = z.infer<typeof cancelCampaignOutputSchema>;

export const cancelCampaignContract = oc
  .route({ method: 'POST', path: '/internal/v1/campaigns/{id}/cancel' })
  .input(cancelCampaignInputSchema)
  .output(cancelCampaignOutputSchema);

export const internalCampaignsContract = {
  cancel: cancelCampaignContract,
} as const;
