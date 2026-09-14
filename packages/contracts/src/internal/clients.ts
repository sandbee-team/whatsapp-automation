import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import { paiseAmountSchema } from '../app/wallet.js';
import { staffReasonSchema, uuidSchema, internalMutationResultSchema } from './common.js';

/**
 * internal/clients.ts (P28 Unit U2, step 3) - the staff client-management
 * mutations: suspend/reactivate, per-client limit overrides, per-client
 * pricing overrides, and plan changes. Every mutation input carries
 * `reason` (`staffReasonSchema`); `staffId` and the idempotency key travel
 * in `internalMutationHeadersSchema` (see `common.ts`), never in the body.
 * `.strict()` on every object schema.
 */

export const clientLimitKeySchema = z.enum([
  'max_contacts',
  'max_connected_instances',
  'max_registered_instances',
  'max_broadcast_recipients',
  'max_daily_sends',
]);
export type ClientLimitKey = z.infer<typeof clientLimitKeySchema>;

export const clientLimitOverrideSchema = z
  .object({
    limitKey: clientLimitKeySchema,
    /** `null` clears the override (falls back to the plan default). */
    limitValue: z.number().int().min(0).nullable(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type ClientLimitOverride = z.infer<typeof clientLimitOverrideSchema>;

export const suspendClientInputSchema = z.object({ reason: staffReasonSchema }).strict();
export type SuspendClientInput = z.infer<typeof suspendClientInputSchema>;

export const suspendClientOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    status: z.literal('suspended'),
    changed: z.boolean(),
  }),
);
export type SuspendClientOutput = z.infer<typeof suspendClientOutputSchema>;

export const suspendClientContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/suspend' })
  .input(suspendClientInputSchema)
  .output(suspendClientOutputSchema);

export const reactivateClientInputSchema = z.object({ reason: staffReasonSchema }).strict();
export type ReactivateClientInput = z.infer<typeof reactivateClientInputSchema>;

export const reactivateClientOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    status: z.literal('active'),
    changed: z.boolean(),
    wokenInstances: z.number().int().nonnegative(),
  }),
);
export type ReactivateClientOutput = z.infer<typeof reactivateClientOutputSchema>;

export const reactivateClientContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/reactivate' })
  .input(reactivateClientInputSchema)
  .output(reactivateClientOutputSchema);

export const setClientLimitsInputSchema = z
  .object({
    reason: staffReasonSchema,
    overrides: z.array(clientLimitOverrideSchema).min(1).max(10),
  })
  .strict();
export type SetClientLimitsInput = z.infer<typeof setClientLimitsInputSchema>;

export const setClientLimitsOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    overrides: z.array(clientLimitOverrideSchema),
  }),
);
export type SetClientLimitsOutput = z.infer<typeof setClientLimitsOutputSchema>;

export const setClientLimitsContract = oc
  .route({ method: 'PUT', path: '/internal/v1/clients/{id}/limits' })
  .input(setClientLimitsInputSchema)
  .output(setClientLimitsOutputSchema);

/**
 * An empty `overrideItems` object clears every override (falls back to the
 * plan/rate-card default), and any SUBSET of the four price keys overrides
 * only those keys - hence `z.partialRecord`, never `z.record`: in Zod 4 a
 * `z.record` over an ENUM key schema is EXHAUSTIVE (every enum member is
 * required), which contradicted this schema's own documented "empty clears
 * everything" semantics and made a single-key override a 400. Caught by P28
 * U3b's `a_pricing_override_rewrites_max_rate_minor_in_the_same_transaction`.
 */
export const setClientPricingInputSchema = z
  .object({
    reason: staffReasonSchema,
    overrideItems: z.partialRecord(
      z.enum(['text', 'media', 'group_text', 'group_media']),
      paiseAmountSchema,
    ),
  })
  .strict();
export type SetClientPricingInput = z.infer<typeof setClientPricingInputSchema>;

export const setClientPricingOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    maxRateMinor: paiseAmountSchema,
    /** Partial for the same reason as the INPUT schema above - see its doc comment. */
    overrideItems: z.partialRecord(
      z.enum(['text', 'media', 'group_text', 'group_media']),
      paiseAmountSchema,
    ),
  }),
);
export type SetClientPricingOutput = z.infer<typeof setClientPricingOutputSchema>;

export const setClientPricingContract = oc
  .route({ method: 'PUT', path: '/internal/v1/clients/{id}/pricing' })
  .input(setClientPricingInputSchema)
  .output(setClientPricingOutputSchema);

export const setClientPlanInputSchema = z
  .object({
    reason: staffReasonSchema,
    planKey: z.enum(['starter', 'growth', 'business']),
  })
  .strict();
export type SetClientPlanInput = z.infer<typeof setClientPlanInputSchema>;

export const setClientPlanOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    planKey: z.enum(['starter', 'growth', 'business']),
  }),
);
export type SetClientPlanOutput = z.infer<typeof setClientPlanOutputSchema>;

export const setClientPlanContract = oc
  .route({ method: 'PUT', path: '/internal/v1/clients/{id}/plan' })
  .input(setClientPlanInputSchema)
  .output(setClientPlanOutputSchema);

export const internalClientsContract = {
  suspend: suspendClientContract,
  reactivate: reactivateClientContract,
  setLimits: setClientLimitsContract,
  setPricing: setClientPricingContract,
  setPlan: setClientPlanContract,
} as const;
