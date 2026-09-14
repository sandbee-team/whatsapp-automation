import { oc } from '@orpc/contract';
import { z } from 'zod';
import { IMPERSONATION_SCOPES } from '@wp/domain';
import { successEnvelope } from '../envelope.js';
import { staffReasonSchema, uuidSchema, internalMutationResultSchema } from './common.js';

/**
 * internal/impersonation.ts (P28 Unit U2, step 3) - the staff impersonation
 * lifecycle: grant, mint an access token, elevate to `with_message_bodies`
 * scope, revoke, and list a client's grants. Every grant starts at
 * `metadata_only` scope; `elevate` is the ONLY way to reach
 * `with_message_bodies`, is capped at 15 minutes (vs. a grant's 30), and
 * is `superadmin`-only (enforced by `@wp/domain`'s `canStaff`, not by this
 * contract). Minting a token is itself audited and Idempotency-Key-wrapped
 * like every other mutation here - a token is a capability, not a passive
 * read, so it goes through the same `internalMutationHeadersSchema` +
 * `reason` discipline as every other action in this directory.
 */

export const grantImpersonationInputSchema = z
  .object({
    reason: staffReasonSchema,
    durationMinutes: z.number().int().min(1).max(30).default(30),
    targetUserId: uuidSchema.optional(),
  })
  .strict();
export type GrantImpersonationInput = z.infer<typeof grantImpersonationInputSchema>;

export const grantImpersonationOutputSchema = successEnvelope(
  internalMutationResultSchema({
    grantId: uuidSchema,
    clientId: uuidSchema,
    scope: z.literal('metadata_only'),
    expiresAt: z.string().datetime(),
  }),
);
export type GrantImpersonationOutput = z.infer<typeof grantImpersonationOutputSchema>;

export const grantImpersonationContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/impersonation' })
  .input(grantImpersonationInputSchema)
  .output(grantImpersonationOutputSchema);

export const mintImpersonationTokenInputSchema = z.object({ reason: staffReasonSchema }).strict();
export type MintImpersonationTokenInput = z.infer<typeof mintImpersonationTokenInputSchema>;

export const mintImpersonationTokenOutputSchema = successEnvelope(
  internalMutationResultSchema({
    // Nullable: `routes/impersonation-mint.ts` returns the real bearer token
    // ONLY on the winning (non-replayed) call - a replayed Idempotency-Key
    // must never re-emit it (see that route's own module header). `null` on
    // replay, never omitted, so every consumer must handle both explicitly.
    accessToken: z.string().nullable(),
    expiresAt: z.string().datetime(),
    scope: z.enum(IMPERSONATION_SCOPES),
    grantId: uuidSchema,
    panelEntryPath: z.string().nullable(),
    /** `true` on every response (winning or replayed) - a grant for this key exists and is usable. */
    tokenIssued: z.literal(true),
  }),
);
export type MintImpersonationTokenOutput = z.infer<typeof mintImpersonationTokenOutputSchema>;

export const mintImpersonationTokenContract = oc
  .route({ method: 'POST', path: '/internal/v1/impersonation/{grantId}/token' })
  .input(mintImpersonationTokenInputSchema)
  .output(mintImpersonationTokenOutputSchema);

export const elevateImpersonationInputSchema = z
  .object({
    reason: staffReasonSchema,
    durationMinutes: z.number().int().min(1).max(15).default(15),
  })
  .strict();
export type ElevateImpersonationInput = z.infer<typeof elevateImpersonationInputSchema>;

export const elevateImpersonationOutputSchema = successEnvelope(
  internalMutationResultSchema({
    grantId: uuidSchema,
    parentGrantId: uuidSchema,
    scope: z.literal('with_message_bodies'),
    expiresAt: z.string().datetime(),
  }),
);
export type ElevateImpersonationOutput = z.infer<typeof elevateImpersonationOutputSchema>;

export const elevateImpersonationContract = oc
  .route({ method: 'POST', path: '/internal/v1/impersonation/{grantId}/elevate' })
  .input(elevateImpersonationInputSchema)
  .output(elevateImpersonationOutputSchema);

export const revokeImpersonationInputSchema = z.object({ reason: staffReasonSchema }).strict();
export type RevokeImpersonationInput = z.infer<typeof revokeImpersonationInputSchema>;

export const revokeImpersonationOutputSchema = successEnvelope(
  internalMutationResultSchema({
    grantId: uuidSchema,
    revokedAt: z.string().datetime(),
  }),
);
export type RevokeImpersonationOutput = z.infer<typeof revokeImpersonationOutputSchema>;

export const revokeImpersonationContract = oc
  .route({ method: 'POST', path: '/internal/v1/impersonation/{grantId}/revoke' })
  .input(revokeImpersonationInputSchema)
  .output(revokeImpersonationOutputSchema);

export const impersonationGrantItemSchema = z
  .object({
    grantId: uuidSchema,
    staffId: uuidSchema,
    scope: z.enum(IMPERSONATION_SCOPES),
    createdAt: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export type ImpersonationGrantItem = z.infer<typeof impersonationGrantItemSchema>;

export const listImpersonationGrantsOutputSchema = successEnvelope(
  z.object({ items: z.array(impersonationGrantItemSchema) }).strict(),
);
export type ListImpersonationGrantsOutput = z.infer<typeof listImpersonationGrantsOutputSchema>;

export const listImpersonationGrantsContract = oc
  .route({ method: 'GET', path: '/internal/v1/clients/{id}/impersonation' })
  .output(listImpersonationGrantsOutputSchema);

export const internalImpersonationContract = {
  grant: grantImpersonationContract,
  mintToken: mintImpersonationTokenContract,
  elevate: elevateImpersonationContract,
  revoke: revokeImpersonationContract,
  list: listImpersonationGrantsContract,
} as const;
