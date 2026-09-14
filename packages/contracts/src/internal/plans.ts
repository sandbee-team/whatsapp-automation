import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import { uuidSchema } from './common.js';

/**
 * internal/plans.ts (P28 Unit U2, step 3) - a read-only staff listing of the
 * platform's plan catalogue (used to populate the `clients.plan` change
 * mutation's dropdown). No mutation, no `reason`, no idempotency headers.
 */

export const planLimitsSchema = z
  .object({
    maxConnectedInstances: z.number().int().nonnegative(),
    maxRegisteredInstances: z.number().int().nonnegative(),
    maxBroadcastRecipients: z.number().int().nonnegative(),
    maxContacts: z.number().int().nonnegative(),
  })
  .strict();
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const planItemSchema = z
  .object({
    id: uuidSchema,
    key: z.string(),
    name: z.string(),
    isDefault: z.boolean(),
    limits: planLimitsSchema,
  })
  .strict();
export type PlanItem = z.infer<typeof planItemSchema>;

export const listPlansOutputSchema = successEnvelope(
  z.object({ items: z.array(planItemSchema) }).strict(),
);
export type ListPlansOutput = z.infer<typeof listPlansOutputSchema>;

export const listPlansContract = oc
  .route({ method: 'GET', path: '/internal/v1/plans' })
  .output(listPlansOutputSchema);

export const internalPlansContract = {
  list: listPlansContract,
} as const;
