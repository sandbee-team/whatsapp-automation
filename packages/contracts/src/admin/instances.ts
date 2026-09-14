import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  adminListQuerySchema,
  adminMutationOutputSchema,
  adminMutationReasonSchema,
  adminPageOutput,
  isoTimestampSchema,
} from './common.js';

/**
 * admin/instances.ts (P28 Unit U4, step 9) - the fleet instance list plus
 * the pause/resume/pacing-override mutation proxies.
 *
 * NO `phoneE164`, `ownerJid` or `label` field exists here, and `.strict()`
 * makes adding one a wire-shape break the integration test catches. Staff
 * diagnose a stuck instance from its STATES (health/link/desired), its
 * pause reason, its pacing band and tier, which worker holds its lease and
 * how fresh that lease is, plus queue depth and oldest-queued age. None of
 * that requires knowing the WhatsApp number behind it - and putting the
 * number on a routine ops list would make every staff session a standing
 * PII disclosure.
 */

export const adminInstanceItemSchema = z
  .object({
    id: z.uuid(),
    clientId: z.uuid(),
    healthState: z.string().min(1),
    linkState: z.string().nullable(),
    desiredState: z.string().min(1),
    pauseReason: z.string().nullable(),
    /** Pacing health band: healthy | watch | degraded | critical. */
    band: z.string().nullable(),
    /** Warm-up tier. */
    tier: z.number().int().nullable(),
    ownerWorkerId: z.string().nullable(),
    /** Lease freshness - a stale value is how staff spot an unowned session. */
    leaseSeenAt: isoTimestampSchema.nullable(),
    queueDepth: z.number().int().nonnegative(),
    oldestQueuedAgeSeconds: z.number().int().nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type AdminInstanceItem = z.infer<typeof adminInstanceItemSchema>;

export const adminListInstancesQuerySchema = adminListQuerySchema
  .extend({
    healthState: z.string().trim().min(1).max(40).optional(),
    clientId: z.uuid().optional(),
  })
  .strict();
export type AdminListInstancesQuery = z.infer<typeof adminListInstancesQuerySchema>;

export const adminListInstancesOutputSchema = adminPageOutput(adminInstanceItemSchema);
export type AdminListInstancesOutput = z.infer<typeof adminListInstancesOutputSchema>;

export const adminListInstancesContract = oc
  .route({ method: 'GET', path: '/admin/v1/instances' })
  .input(adminListInstancesQuerySchema)
  .output(adminListInstancesOutputSchema);

/**
 * PAUSE is always available to `ops`; RESUME is deliberately NOT an
 * "undo". Resuming re-runs eligibility rather than forcing sends, and a
 * pause that came from a provider restriction signal is never auto-resumed
 * (safety-compliance: recovery goes through the provider's legitimate path,
 * initiated by a human). This contract carries no "force" flag for exactly
 * that reason - there is nothing here that could express "send anyway".
 */
export const adminPauseInstanceContract = oc
  .route({ method: 'POST', path: '/admin/v1/instances/{id}/pause' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminResumeInstanceContract = oc
  .route({ method: 'POST', path: '/admin/v1/instances/{id}/resume' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

/**
 * A pacing override RELAXES or tightens this instance's resolved caps for a
 * bounded window. `expiresAt` is REQUIRED, not optional: an unbounded
 * relaxation is how a temporary exception becomes permanent, so the
 * contract makes an expiry unavoidable. `superadmin` only
 * (`pacing.relax`) - it is the highest-blast-radius knob on the surface.
 */
export const adminPacingOverrideInputSchema = adminMutationReasonSchema
  .extend({
    patch: z.record(z.string(), z.number().int()),
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const adminPacingOverrideContract = oc
  .route({ method: 'POST', path: '/admin/v1/instances/{id}/pacing-override' })
  .input(adminPacingOverrideInputSchema)
  .output(adminMutationOutputSchema);

export const adminCancelCampaignContract = oc
  .route({ method: 'POST', path: '/admin/v1/campaigns/{id}/cancel' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminInstancesContract = {
  list: adminListInstancesContract,
  pause: adminPauseInstanceContract,
  resume: adminResumeInstanceContract,
  pacingOverride: adminPacingOverrideContract,
  cancelCampaign: adminCancelCampaignContract,
} as const;
