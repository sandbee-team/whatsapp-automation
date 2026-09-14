import { oc } from '@orpc/contract';
import { z } from 'zod';
import { GROUP_SEND_INELIGIBILITY_REASONS } from '@wp/domain';
import { successEnvelope, paginationInputSchema } from '../envelope.js';

/**
 * app/groups.ts (P24 groups-messaging, Unit U2, step 4) - the tenant group
 * surface. Four routes only:
 *   GET   /v1/instances/:id/groups
 *   POST  /v1/instances/:id/groups/sync
 *   PATCH /v1/groups/:id/send-enabled
 *   POST  /v1/groups/:id/leave
 * `.strict()` on every object schema (an unplanned field cannot silently
 * widen the wire shape, same discipline as `broadcasts.ts`). Dates are ISO
 * strings everywhere - no money is involved on this surface.
 *
 * `groupSummarySchema` deliberately has NO `groupJid` field - the panel never
 * needs the raw JID (data minimisation, same principle as
 * `wa_groups`'s own "counts only, forever" migration note); nor does any
 * schema here carry a participant list/field of any kind
 * (`scripts/check-send-origin.ts`-adjacent discipline: no client-settable
 * `origin`, and no participant-shaped field anywhere on this DTO surface).
 */

export const GROUP_ROLES = ['member', 'admin', 'superadmin'] as const;
export const groupRoleSchema = z.enum(GROUP_ROLES);
export type GroupRoleContract = z.infer<typeof groupRoleSchema>;

export const groupSendIneligibilityReasonSchema = z.enum(GROUP_SEND_INELIGIBILITY_REASONS);
export type GroupSendIneligibilityReasonContract = z.infer<
  typeof groupSendIneligibilityReasonSchema
>;

export const groupEligibilitySchema = z
  .object({
    sendable: z.boolean(),
    reason: groupSendIneligibilityReasonSchema.nullable(),
  })
  .strict();
export type GroupEligibility = z.infer<typeof groupEligibilitySchema>;

export const groupSummarySchema = z
  .object({
    id: z.string().uuid(),
    instanceId: z.string().uuid(),
    subject: z.string().nullable(),
    participantCount: z.number().int().nullable(),
    isAnnounce: z.boolean(),
    ourRole: groupRoleSchema.nullable(),
    sendEnabled: z.boolean(),
    sendEnabledAt: z.string().nullable(),
    disabledReason: z.string().nullable(),
    trackedParticipantDevices: z.number().int(),
    lastSyncedAt: z.string().nullable(),
    lastMessageAt: z.string().nullable(),
    leaveRequestedAt: z.string().nullable(),
    eligibility: groupEligibilitySchema,
  })
  .strict();
export type GroupSummary = z.infer<typeof groupSummarySchema>;

/** The shared keyset-pagination shape (`cursor` + `limit`; OFFSET pagination is a lint error - see `paginationInputSchema`'s own doc comment) plus the path's instance id. */
export const listGroupsInputSchema = z
  .object({
    id: z.string().uuid(),
    cursor: paginationInputSchema.shape.cursor,
    limit: paginationInputSchema.shape.limit,
  })
  .strict();
export type ListGroupsInput = z.infer<typeof listGroupsInputSchema>;

export const listGroupsResponseSchema = z
  .object({
    items: z.array(groupSummarySchema),
    nextCursor: z.string().optional(),
    budget: z
      .object({
        trackedDevicesEnabledTotal: z.number().int().nonnegative(),
        max: z.number().int().positive(),
      })
      .strict(),
    groupCap: z
      .object({
        warmupTier: z.number().int().positive(),
        healthBand: z.string(),
        effGroupDailyCap: z.number().int().nonnegative(),
        sentToday: z.number().int().nonnegative(),
        remainingToday: z.number().int().nonnegative(),
      })
      .strict(),
    sync: z
      .object({
        lastSyncedAt: z.string().nullable(),
        nextSyncAfter: z.string().nullable(),
        requestedAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type ListGroupsResponse = z.infer<typeof listGroupsResponseSchema>;

export const listGroupsOutputSchema = successEnvelope(listGroupsResponseSchema);
export type ListGroupsOutput = z.infer<typeof listGroupsOutputSchema>;

export const listGroupsContract = oc
  .route({ method: 'GET', path: '/v1/instances/{id}/groups' })
  .input(listGroupsInputSchema)
  .output(listGroupsOutputSchema);

export const requestGroupSyncInputSchema = z.object({ id: z.string().uuid() }).strict();
export type RequestGroupSyncInput = z.infer<typeof requestGroupSyncInputSchema>;

/**
 * A refused (rate-limited) request is the standard error envelope with code
 * `RATE_LIMITED` and a `Retry-After` header - a transport-layer concern, no
 * schema needed beyond the shared error envelope (see `errors.ts`).
 */
export const requestGroupSyncResponseSchema = z
  .object({
    requestedAt: z.string(),
    nextSyncAfter: z.string().nullable(),
  })
  .strict();
export type RequestGroupSyncResponse = z.infer<typeof requestGroupSyncResponseSchema>;

export const requestGroupSyncOutputSchema = successEnvelope(requestGroupSyncResponseSchema);
export type RequestGroupSyncOutput = z.infer<typeof requestGroupSyncOutputSchema>;

export const requestGroupSyncContract = oc
  .route({ method: 'POST', path: '/v1/instances/{id}/groups/sync' })
  .input(requestGroupSyncInputSchema)
  .output(requestGroupSyncOutputSchema);

export const setGroupSendEnabledInputSchema = z
  .object({
    sendEnabled: z.boolean(),
  })
  .strict();
export type SetGroupSendEnabledInput = z.infer<typeof setGroupSendEnabledInputSchema>;

/**
 * A refusal is the standard error envelope, code `GROUP_NOT_SENDABLE`, with
 * `details` shaped by `groupNotSendableDetailsSchema` below - `trackedDevicesEnabledTotal`/
 * `groupTrackedDevices`/`max` are populated only for a `DEVICE_BUDGET_EXCEEDED` refusal.
 */
export const groupNotSendableDetailsSchema = z
  .object({
    reason: groupSendIneligibilityReasonSchema,
    trackedDevicesEnabledTotal: z.number().int().nonnegative().optional(),
    groupTrackedDevices: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
  })
  .strict();
export type GroupNotSendableDetails = z.infer<typeof groupNotSendableDetailsSchema>;

export const setGroupSendEnabledOutputSchema = successEnvelope(groupSummarySchema);
export type SetGroupSendEnabledOutput = z.infer<typeof setGroupSendEnabledOutputSchema>;

export const setGroupSendEnabledContract = oc
  .route({ method: 'PATCH', path: '/v1/groups/{id}/send-enabled' })
  .input(setGroupSendEnabledInputSchema)
  .output(setGroupSendEnabledOutputSchema);

export const requestGroupLeaveInputSchema = z.object({ id: z.string().uuid() }).strict();
export type RequestGroupLeaveInput = z.infer<typeof requestGroupLeaveInputSchema>;

/** Always allowed, idempotent - leaving is a de-escalation, never refused. */
export const requestGroupLeaveResponseSchema = z
  .object({
    leaveRequestedAt: z.string(),
  })
  .strict();
export type RequestGroupLeaveResponse = z.infer<typeof requestGroupLeaveResponseSchema>;

export const requestGroupLeaveOutputSchema = successEnvelope(requestGroupLeaveResponseSchema);
export type RequestGroupLeaveOutput = z.infer<typeof requestGroupLeaveOutputSchema>;

export const requestGroupLeaveContract = oc
  .route({ method: 'POST', path: '/v1/groups/{id}/leave' })
  .input(requestGroupLeaveInputSchema)
  .output(requestGroupLeaveOutputSchema);

export const groupsContract = {
  list: listGroupsContract,
  sync: requestGroupSyncContract,
  setSendEnabled: setGroupSendEnabledContract,
  leave: requestGroupLeaveContract,
} as const;
