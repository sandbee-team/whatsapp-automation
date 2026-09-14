import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import {
  adminListQuerySchema,
  adminMutationOutputSchema,
  adminMutationReasonSchema,
  adminPageOutput,
  isoTimestampSchema,
  paiseStringSchema,
} from './common.js';
import { adminInstanceItemSchema } from './instances.js';
import { adminStaffAuditItemSchema } from './audit.js';
import { adminWalletHeaderSchema } from './wallet.js';

/**
 * admin/clients.ts (P28 Unit U4, step 9) - the client list, the client
 * detail, and the client mutation proxies.
 *
 * WHAT IS ABSENT IS THE CONTRACT. There is no `ownerName`, `ownerEmail`,
 * `phone` or any per-recipient field anywhere in this file, and `.strict()`
 * means the panel would REJECT a response that grew one. `companyName` and
 * `slug` are present: a workspace's business identity is exactly what staff
 * act on, and neither is a natural person's PII. Reading a tenant's actual
 * message content requires a separate, time-boxed, separately-audited
 * impersonation grant - never a side effect of opening a client page.
 */

export const adminClientStatusSchema = z.string().min(1);

export const adminClientListItemSchema = z
  .object({
    id: z.uuid(),
    companyName: z.string().min(1),
    slug: z.string().min(1),
    status: adminClientStatusSchema,
    onboardingStep: z.string().min(1),
    planKey: z.string().nullable(),
    createdAt: isoTimestampSchema,
    instanceCount: z.number().int().nonnegative(),
    connectedCount: z.number().int().nonnegative(),
    walletState: z.string().nullable(),
    balanceMinor: paiseStringSchema.nullable(),
  })
  .strict();
export type AdminClientListItem = z.infer<typeof adminClientListItemSchema>;

/** `q` matches `company_name`/`slug` ONLY - never a user's name or email. */
export const adminListClientsQuerySchema = adminListQuerySchema
  .extend({
    status: z.string().trim().min(1).max(40).optional(),
    q: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type AdminListClientsQuery = z.infer<typeof adminListClientsQuerySchema>;

export const adminListClientsOutputSchema = adminPageOutput(adminClientListItemSchema);
export type AdminListClientsOutput = z.infer<typeof adminListClientsOutputSchema>;

export const adminListClientsContract = oc
  .route({ method: 'GET', path: '/admin/v1/clients' })
  .input(adminListClientsQuerySchema)
  .output(adminListClientsOutputSchema);

export const adminPlanLimitsSchema = z
  .object({
    key: z.string().nullable(),
    name: z.string().nullable(),
    maxConnectedInstances: z.number().int().nullable(),
    maxRegisteredInstances: z.number().int().nullable(),
    maxBroadcastRecipients: z.number().int().nullable(),
  })
  .strict();

/**
 * Plan limits and overrides are returned SEPARATELY, never pre-merged, so
 * the panel can show that a value is a human-set override rather than the
 * plan default - a merged number would hide the fact that someone widened a
 * limit, which is precisely what a staff reviewer needs to see.
 */
export const adminClientLimitsSchema = z
  .object({
    plan: adminPlanLimitsSchema.nullable(),
    overrides: z.array(
      z
        .object({
          limitKey: z.string().min(1),
          limitValue: z.number().int().nullable(),
          expiresAt: isoTimestampSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const adminClientPricingSchema = z
  .object({
    priceListKey: z.string().min(1),
    overrideItems: z.record(z.string(), z.unknown()),
  })
  .strict();

export const adminImpersonationGrantSchema = z
  .object({
    id: z.uuid(),
    staffId: z.uuid(),
    scope: z.enum(['metadata_only', 'with_message_bodies']),
    reason: z.string().min(1),
    createdAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
export type AdminImpersonationGrant = z.infer<typeof adminImpersonationGrantSchema>;

export const adminClientDetailSchema = z
  .object({
    id: z.uuid(),
    companyName: z.string().min(1),
    slug: z.string().min(1),
    status: adminClientStatusSchema,
    onboardingStep: z.string().min(1),
    planKey: z.string().nullable(),
    planName: z.string().nullable(),
    createdAt: isoTimestampSchema,
    timezone: z.string().min(1),
    limits: adminClientLimitsSchema,
    pricing: adminClientPricingSchema.nullable(),
    wallet: adminWalletHeaderSchema.nullable(),
    instances: z.array(adminInstanceItemSchema),
    recentStaffActions: z.array(adminStaffAuditItemSchema),
    /** Surfaced here on purpose: a staff member about to act should see a colleague already inside. */
    activeImpersonations: z.array(adminImpersonationGrantSchema),
  })
  .strict();
export type AdminClientDetail = z.infer<typeof adminClientDetailSchema>;

export const adminClientDetailOutputSchema = successEnvelope(adminClientDetailSchema);

export const adminGetClientContract = oc
  .route({ method: 'GET', path: '/admin/v1/clients/{id}' })
  .output(adminClientDetailOutputSchema);

/**
 * Every mutation below is a PROXY: admin-backend validates and RBAC-checks,
 * then calls app-backend's `/internal/v1`, which owns the write. That is
 * why each input is only `reason` plus the change itself - the acting staff
 * member travels in the `X-Actor` header and the dedupe key in
 * `Idempotency-Key`, neither of which a caller of THIS surface supplies
 * (the panel supplies the idempotency key; the actor comes from the token).
 */
export const adminSuspendClientContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/suspend' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminReactivateClientContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/reactivate' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminSetClientLimitsInputSchema = adminMutationReasonSchema
  .extend({
    overrides: z.array(
      z
        .object({
          limitKey: z.string().trim().min(1).max(80),
          limitValue: z.number().int().nullable(),
          expiresAt: isoTimestampSchema.nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const adminSetClientLimitsContract = oc
  .route({ method: 'PUT', path: '/admin/v1/clients/{id}/limits' })
  .input(adminSetClientLimitsInputSchema)
  .output(adminMutationOutputSchema);

export const adminSetClientPricingInputSchema = adminMutationReasonSchema
  .extend({
    overrideItems: z.record(z.string(), z.number().int()),
  })
  .strict();

export const adminSetClientPricingContract = oc
  .route({ method: 'PUT', path: '/admin/v1/clients/{id}/pricing' })
  .input(adminSetClientPricingInputSchema)
  .output(adminMutationOutputSchema);

export const adminSetClientPlanInputSchema = adminMutationReasonSchema
  .extend({ planKey: z.string().trim().min(1).max(80) })
  .strict();

export const adminSetClientPlanContract = oc
  .route({ method: 'PUT', path: '/admin/v1/clients/{id}/plan' })
  .input(adminSetClientPlanInputSchema)
  .output(adminMutationOutputSchema);

export const adminClientsContract = {
  list: adminListClientsContract,
  get: adminGetClientContract,
  suspend: adminSuspendClientContract,
  reactivate: adminReactivateClientContract,
  setLimits: adminSetClientLimitsContract,
  setPricing: adminSetClientPricingContract,
  setPlan: adminSetClientPlanContract,
} as const;
