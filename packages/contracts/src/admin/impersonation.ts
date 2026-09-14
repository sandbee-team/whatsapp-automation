import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import {
  adminMutationOutputSchema,
  adminMutationReasonSchema,
  isoTimestampSchema,
} from './common.js';

/**
 * admin/impersonation.ts (P28 Unit U4, step 9) - the staff impersonation
 * surface: grant, mint, elevate, revoke.
 *
 * THE WHOLE DESIGN IS A TIME BOX. Every admin READ in this package projects
 * ids, enums and amounts only - never a phone number, a recipient or a
 * message body. Impersonation is the ONE path to a tenant's actual
 * workspace, and it is deliberately made expensive rather than convenient:
 *
 *  - a grant carries a MANDATORY reason and a hard expiry the DATABASE
 *    enforces (`impersonation_grants` CHECK: 30 minutes maximum for
 *    metadata, 15 for message bodies - migration 0070), so "forever" is not
 *    representable even by a bug;
 *  - `metadata_only` is the default scope, and reading message BODIES is a
 *    separate ELEVATION (`impersonation.elevate`, `superadmin` only) that
 *    chains back to the metadata grant it elevates;
 *  - a live grant is shown on the client-detail page, so colleagues see it;
 *  - revoke is available at any time and takes effect immediately.
 *
 * `panelUrl` is built against `APP_PANEL_BASE_URL` - the TENANT panel's
 * origin, never the admin panel's: the staff member is being sent into the
 * customer's workspace, and pointing this at the admin origin would be a
 * confused-deputy waiting to happen.
 */

export const impersonationScopeSchema = z.enum(['metadata_only', 'with_message_bodies']);
export type ImpersonationScope = z.infer<typeof impersonationScopeSchema>;

/**
 * `ttlMinutes` is bounded HERE too (not only in the database) so the panel
 * cannot offer a duration the storage layer will reject - two independent
 * ceilings, the database's being the authority.
 */
export const adminGrantImpersonationInputSchema = adminMutationReasonSchema
  .extend({
    scope: impersonationScopeSchema.default('metadata_only'),
    ttlMinutes: z.coerce.number().int().min(1).max(30).default(30),
  })
  .strict();
export type AdminGrantImpersonationInput = z.infer<typeof adminGrantImpersonationInputSchema>;

export const adminImpersonationTokenDataSchema = z
  .object({
    grantId: z.uuid(),
    expiresAt: isoTimestampSchema,
    scope: impersonationScopeSchema,
    // Nullable: `panelUrl` carries a bearer credential in its `#token=`
    // fragment (see `admin/backend/src/modules/mutations/
    // impersonation.routes.ts`'s module header), so a REPLAYED
    // Idempotency-Key on the mint/elevate routes returns `panelUrl: null`
    // rather than re-emitting it - `internal/impersonation.ts`'s
    // `mintImpersonationTokenOutputSchema` makes the same call one layer
    // down, for the same reason.
    panelUrl: z.string().min(1).nullable(),
  })
  .strict();
export type AdminImpersonationTokenData = z.infer<typeof adminImpersonationTokenDataSchema>;

export const adminImpersonationTokenOutputSchema = successEnvelope(
  adminImpersonationTokenDataSchema,
);

export const adminGrantImpersonationContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/impersonation' })
  .input(adminGrantImpersonationInputSchema)
  .output(adminImpersonationTokenOutputSchema);

export const adminMintImpersonationTokenContract = oc
  .route({ method: 'POST', path: '/admin/v1/impersonation/{grantId}/token' })
  .input(adminMutationReasonSchema)
  .output(adminImpersonationTokenOutputSchema);

/** `superadmin` only - this is the single path to reading a tenant's message bodies. */
export const adminElevateImpersonationContract = oc
  .route({ method: 'POST', path: '/admin/v1/impersonation/{grantId}/elevate' })
  .input(adminMutationReasonSchema)
  .output(adminImpersonationTokenOutputSchema);

export const adminRevokeImpersonationContract = oc
  .route({ method: 'POST', path: '/admin/v1/impersonation/{grantId}/revoke' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminImpersonationContract = {
  grant: adminGrantImpersonationContract,
  mintToken: adminMintImpersonationTokenContract,
  elevate: adminElevateImpersonationContract,
  revoke: adminRevokeImpersonationContract,
} as const;
