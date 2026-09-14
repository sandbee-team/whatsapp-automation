import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import { staffReasonSchema, uuidSchema, internalMutationResultSchema } from './common.js';

/**
 * internal/instances.ts (P28 Unit U2, step 3) - the staff instance-control
 * mutations: pause/resume and the pacing-relax override. `clientId` travels
 * in the body (not derivable from the path alone without a DB lookup the
 * contract layer cannot do) so the handler can verify tenant scoping before
 * touching the instance - core invariant 4 (tenant isolation).
 * `adminRelaxPatchSchema` mirrors `AdminRelaxPatch`
 * (`@wp/domain`'s `pacing/relax-bounds.ts`) field-for-field; the actual
 * clamping happens server-side via `clampAdminRelax` - this schema only
 * bounds each field to a positive integer, never enforces the absolute
 * ceilings itself (that is `clampAdminRelax`'s job, applied after this
 * schema parses).
 */

export const adminRelaxPatchSchema = z
  .object({
    dailyCap: z.number().int().positive().optional(),
    hourlyCap: z.number().int().positive().optional(),
    newConvCap: z.number().int().positive().optional(),
    gapMinMs: z.number().int().positive().optional(),
    gapMaxMs: z.number().int().positive().optional(),
    groupDailyCap: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field must be set',
  });
export type AdminRelaxPatch = z.infer<typeof adminRelaxPatchSchema>;

export const pauseInstanceInputSchema = z
  .object({ clientId: uuidSchema, reason: staffReasonSchema })
  .strict();
export type PauseInstanceInput = z.infer<typeof pauseInstanceInputSchema>;

export const pauseInstanceOutputSchema = successEnvelope(
  internalMutationResultSchema({
    instanceId: uuidSchema,
    healthState: z.literal('paused'),
    pauseReason: z.literal('admin_action'),
    changed: z.boolean(),
  }),
);
export type PauseInstanceOutput = z.infer<typeof pauseInstanceOutputSchema>;

export const pauseInstanceContract = oc
  .route({ method: 'POST', path: '/internal/v1/instances/{id}/pause' })
  .input(pauseInstanceInputSchema)
  .output(pauseInstanceOutputSchema);

/**
 * `acknowledgement` must be exactly `true` (enforced by the HANDLER, not
 * this schema) when the instance's current `pause_reason` is
 * `'provider_restriction'` - staff get no shortcut past a restriction pause.
 *
 * NAME COLLISION, and why the internal export is ALIASED in
 * `internal/index.ts` (P28 U3b): the TENANT contract
 * (`packages/contracts/src/instances.ts`) exports a schema of the SAME name
 * for `POST /v1/instances/{id}/resume`, whose body is
 * `{acknowledgement?, reason?}` with NO `clientId` (a tenant's own session
 * already supplies the tenant scope). `src/index.ts` re-exports that one by
 * NAME and this directory via `export *`, and an explicit named export
 * SHADOWS a star re-export - so `import { resumeInstanceInputSchema } from
 * '@wp/contracts'` silently resolved to the TENANT schema. The staff resume
 * route then rejected its own valid body with
 * `Unrecognized key: "clientId"` - a 400 where the route's contract says
 * 422/200, with no type error anywhere to reveal it.
 */
export const resumeInstanceInputSchema = z
  .object({
    clientId: uuidSchema,
    reason: staffReasonSchema,
    acknowledgement: z.boolean().optional(),
  })
  .strict();
export type ResumeInstanceInput = z.infer<typeof resumeInstanceInputSchema>;

export const resumeInstanceOutputSchema = successEnvelope(
  internalMutationResultSchema({
    instanceId: uuidSchema,
    healthState: z.string(),
    resumed: z.boolean(),
  }),
);
export type ResumeInstanceOutput = z.infer<typeof resumeInstanceOutputSchema>;

export const resumeInstanceContract = oc
  .route({ method: 'POST', path: '/internal/v1/instances/{id}/resume' })
  .input(resumeInstanceInputSchema)
  .output(resumeInstanceOutputSchema);

export const pacingOverrideInputSchema = z
  .object({
    clientId: uuidSchema,
    reason: staffReasonSchema,
    expiresAt: z.string().datetime(),
    patch: adminRelaxPatchSchema,
  })
  .strict();
export type PacingOverrideInput = z.infer<typeof pacingOverrideInputSchema>;

export const pacingOverrideOutputSchema = successEnvelope(
  internalMutationResultSchema({
    instanceId: uuidSchema,
    overrideId: uuidSchema,
    appliedPatch: adminRelaxPatchSchema,
    clampedFields: z.array(z.string()),
    expiresAt: z.string().datetime(),
  }),
);
export type PacingOverrideOutput = z.infer<typeof pacingOverrideOutputSchema>;

export const pacingOverrideContract = oc
  .route({ method: 'POST', path: '/internal/v1/instances/{id}/pacing-override' })
  .input(pacingOverrideInputSchema)
  .output(pacingOverrideOutputSchema);

export const internalInstancesContract = {
  pause: pauseInstanceContract,
  resume: resumeInstanceContract,
  pacingOverride: pacingOverrideContract,
} as const;
