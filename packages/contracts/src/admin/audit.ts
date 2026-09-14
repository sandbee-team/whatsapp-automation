import { oc } from '@orpc/contract';
import { z } from 'zod';
import { adminListQuerySchema, adminPageOutput, isoTimestampSchema } from './common.js';

/**
 * admin/audit.ts (P28 Unit U4, step 9) - `GET /admin/v1/audit`, the staff
 * audit trail.
 *
 * `reason` IS projected here, and it is the only place in the admin surface
 * that projects free text. That is not an exception to the projection
 * discipline, it is the point of it: this field holds text a STAFF member
 * typed to justify their OWN action. Reading it back is the entire purpose
 * of an audit trail - without it the log records that someone suspended a
 * workspace but not why, which is useless for accountability.
 *
 * `targetRef` is an opaque id string (a topup/instance/campaign id), never
 * a phone number or an email.
 */

export const adminStaffAuditItemSchema = z
  .object({
    /** `bigint` identity column - a string on the wire, and the keyset tiebreaker. */
    id: z.string().regex(/^\d+$/),
    staffId: z.uuid(),
    /** Dotted action name, e.g. `clients.suspend`, `wallet.credit`. */
    action: z.string().min(1),
    /** `null` for a genuinely platform-level action. */
    clientId: z.uuid().nullable(),
    targetKind: z.string().nullable(),
    targetRef: z.string().nullable(),
    reason: z.string().min(1),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type AdminStaffAuditItem = z.infer<typeof adminStaffAuditItemSchema>;

export const adminListAuditQuerySchema = adminListQuerySchema
  .extend({
    clientId: z.uuid().optional(),
    staffId: z.uuid().optional(),
    action: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type AdminListAuditQuery = z.infer<typeof adminListAuditQuerySchema>;

export const adminListAuditOutputSchema = adminPageOutput(adminStaffAuditItemSchema);
export type AdminListAuditOutput = z.infer<typeof adminListAuditOutputSchema>;

export const adminListAuditContract = oc
  .route({ method: 'GET', path: '/admin/v1/audit' })
  .input(adminListAuditQuerySchema)
  .output(adminListAuditOutputSchema);

export const adminAuditContract = {
  list: adminListAuditContract,
} as const;
