import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';

/**
 * admin/queue.ts (P28 Unit U4, step 9) - `GET /admin/v1/queue/summary`, the
 * fleet counts view.
 *
 * COUNTS ONLY. Three maps of enum -> integer and one scalar; no per-row
 * data of any kind crosses this contract, which makes it the narrowest
 * cross-tenant read on the surface by construction rather than by
 * discipline. It also takes NO query parameters, so there is no way to
 * slice it down to one tenant and turn it into a probe - per-tenant queue
 * depth lives on the client-detail instance panel, where it is audited
 * against that `client_id`.
 */

export const adminQueueSummarySchema = z
  .object({
    /** `message_jobs.status` -> job count, only for statuses that currently have rows. */
    jobsByStatus: z.record(z.string(), z.number().int().nonnegative()),
    /** `whatsapp_instances.health_state` -> live instance count. */
    instancesByHealthState: z.record(z.string(), z.number().int().nonnegative()),
    /**
     * Instances the fleet is supposed to be carrying that no worker holds a
     * fresh lease for (same 45-second staleness window as the
     * `wp_instances_unowned` gauge - the two can never disagree, because the
     * predicate is copied from `db/queries/fleet-gauges.sql`).
     */
    unownedInstances: z.number().int().nonnegative(),
  })
  .strict();
export type AdminQueueSummary = z.infer<typeof adminQueueSummarySchema>;

export const adminQueueSummaryOutputSchema = successEnvelope(adminQueueSummarySchema);
export type AdminQueueSummaryOutput = z.infer<typeof adminQueueSummaryOutputSchema>;

export const adminQueueSummaryContract = oc
  .route({ method: 'GET', path: '/admin/v1/queue/summary' })
  .output(adminQueueSummaryOutputSchema);

export const adminPlanItemSchema = z
  .object({
    id: z.uuid(),
    key: z.string().nullable(),
    name: z.string().min(1),
    description: z.string().nullable(),
    isDefault: z.boolean(),
    maxConnectedInstances: z.number().int().nullable(),
    maxRegisteredInstances: z.number().int().nullable(),
    maxBroadcastRecipients: z.number().int().nullable(),
  })
  .strict();
export type AdminPlanItem = z.infer<typeof adminPlanItemSchema>;

export const adminListPlansOutputSchema = successEnvelope(
  z.object({ items: z.array(adminPlanItemSchema) }).strict(),
);
export type AdminListPlansOutput = z.infer<typeof adminListPlansOutputSchema>;

/** Unpaginated on purpose: the plan catalogue is a small, bounded platform table. */
export const adminListPlansContract = oc
  .route({ method: 'GET', path: '/admin/v1/plans' })
  .output(adminListPlansOutputSchema);

export const adminQueueContract = {
  summary: adminQueueSummaryContract,
  listPlans: adminListPlansContract,
} as const;
