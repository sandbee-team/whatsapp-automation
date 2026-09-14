import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';
import { paiseAmountSchema, positivePaiseSchema } from '../app/wallet.js';
import { WALLET_STATES, TOPUP_STATUSES } from '@wp/domain';
import { staffReasonSchema, uuidSchema, internalMutationResultSchema } from './common.js';

/**
 * internal/wallet.ts (P19 Unit U2, step 3; P28 Unit U2, step 3 rewires the
 * real mount points; C1 review round 2 MINOR - the legacy P19
 * `/v1/internal/wallet/*` mount deleted) - the STAFF wallet surface:
 * credit/adjust/freeze/unfreeze a client's wallet, approve/reject top-up
 * requests, and list top-ups. Every mutation input carries `reason`;
 * `staffId` + the idempotency key travel in `internalMutationHeadersSchema`
 * (`common.ts`), never in the body. The P19-era `creditWalletContract`/
 * `decideTopupRequestContract` (`/v1/internal/wallet/*`, inline
 * `staffId`/`idempotencyKey` body fields, never mounted by any live route -
 * `internalWalletMountContract` below is the real, mounted surface) are
 * removed: keeping a second, unreachable contract for the same surface
 * invites exactly the drift a "single contract, single mount" design exists
 * to prevent.
 */

// ---------------------------------------------------------------------
// P28 Unit U2 (step 3) - the REAL `/internal/v1` staff wallet mount points.
// ---------------------------------------------------------------------

export const creditClientWalletInputSchema = z
  .object({
    reason: staffReasonSchema,
    amountMinor: positivePaiseSchema,
    kind: z.enum(['topup_manual', 'promo_credit']),
    externalRef: z.string().min(1).max(200),
  })
  .strict();
export type CreditClientWalletInput = z.infer<typeof creditClientWalletInputSchema>;

export const creditClientWalletOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    seq: z.string(),
    balanceMinor: paiseAmountSchema,
    state: z.enum(WALLET_STATES),
  }),
);
export type CreditClientWalletOutput = z.infer<typeof creditClientWalletOutputSchema>;

export const creditClientWalletContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/wallet/credit' })
  .input(creditClientWalletInputSchema)
  .output(creditClientWalletOutputSchema);

/**
 * `kind` is always `adjustment_credit` (never a body field - the wire input
 * has no `kind` at all). A staff DEBIT adjustment is deliberately NOT part
 * of v1: it would be a SECOND money-moving path outside the append-only
 * credit ledger's single direction, and every P19/P28 money invariant
 * assumes a client's balance only ever moves via a credit entry or a
 * metered send debit - never a second staff-initiated subtraction path.
 */
export const adjustClientWalletInputSchema = z
  .object({
    reason: staffReasonSchema,
    amountMinor: positivePaiseSchema,
    externalRef: z.string().min(1).max(200),
  })
  .strict();
export type AdjustClientWalletInput = z.infer<typeof adjustClientWalletInputSchema>;

export const adjustClientWalletOutputSchema = creditClientWalletOutputSchema;
export type AdjustClientWalletOutput = z.infer<typeof adjustClientWalletOutputSchema>;

export const adjustClientWalletContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/wallet/adjust' })
  .input(adjustClientWalletInputSchema)
  .output(adjustClientWalletOutputSchema);

export const freezeClientWalletInputSchema = z.object({ reason: staffReasonSchema }).strict();
export type FreezeClientWalletInput = z.infer<typeof freezeClientWalletInputSchema>;

export const freezeClientWalletOutputSchema = successEnvelope(
  internalMutationResultSchema({
    clientId: uuidSchema,
    state: z.enum(WALLET_STATES),
    changed: z.boolean(),
  }),
);
export type FreezeClientWalletOutput = z.infer<typeof freezeClientWalletOutputSchema>;

export const freezeClientWalletContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/wallet/freeze' })
  .input(freezeClientWalletInputSchema)
  .output(freezeClientWalletOutputSchema);

export const unfreezeClientWalletInputSchema = freezeClientWalletInputSchema;
export type UnfreezeClientWalletInput = z.infer<typeof unfreezeClientWalletInputSchema>;

export const unfreezeClientWalletOutputSchema = freezeClientWalletOutputSchema;
export type UnfreezeClientWalletOutput = z.infer<typeof unfreezeClientWalletOutputSchema>;

export const unfreezeClientWalletContract = oc
  .route({ method: 'POST', path: '/internal/v1/clients/{id}/wallet/unfreeze' })
  .input(unfreezeClientWalletInputSchema)
  .output(unfreezeClientWalletOutputSchema);

export const approveTopupInputSchema = z.object({ reason: staffReasonSchema }).strict();
export type ApproveTopupInput = z.infer<typeof approveTopupInputSchema>;

export const decideTopupOutputSchema = successEnvelope(
  internalMutationResultSchema({
    topupRequestId: uuidSchema,
    status: z.enum(TOPUP_STATUSES),
  }),
);
export type DecideTopupOutput = z.infer<typeof decideTopupOutputSchema>;

export const approveTopupContract = oc
  .route({ method: 'POST', path: '/internal/v1/topups/{id}/approve' })
  .input(approveTopupInputSchema)
  .output(decideTopupOutputSchema);

export const rejectTopupInputSchema = approveTopupInputSchema;
export type RejectTopupInput = z.infer<typeof rejectTopupInputSchema>;

export const rejectTopupContract = oc
  .route({ method: 'POST', path: '/internal/v1/topups/{id}/reject' })
  .input(rejectTopupInputSchema)
  .output(decideTopupOutputSchema);

export const listTopupsQuerySchema = z
  .object({
    status: z.enum(TOPUP_STATUSES),
    limit: z.coerce.number().int().min(1).max(200).default(200),
  })
  .strict();
export type ListTopupsQuery = z.infer<typeof listTopupsQuerySchema>;

export const listTopupsItemSchema = z
  .object({
    id: uuidSchema,
    clientId: uuidSchema,
    amountMinor: paiseAmountSchema,
    status: z.enum(TOPUP_STATUSES),
    createdAt: z.string(),
  })
  .strict();
export type ListTopupsItem = z.infer<typeof listTopupsItemSchema>;

export const listTopupsOutputSchema = successEnvelope(
  z.object({ items: z.array(listTopupsItemSchema) }).strict(),
);
export type ListTopupsOutput = z.infer<typeof listTopupsOutputSchema>;

export const listTopupsContract = oc
  .route({ method: 'GET', path: '/internal/v1/topups' })
  .input(listTopupsQuerySchema)
  .output(listTopupsOutputSchema);

export const internalWalletMountContract = {
  credit: creditClientWalletContract,
  adjust: adjustClientWalletContract,
  freeze: freezeClientWalletContract,
  unfreeze: unfreezeClientWalletContract,
  approveTopup: approveTopupContract,
  rejectTopup: rejectTopupContract,
  listTopups: listTopupsContract,
} as const;
