import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  adminListQuerySchema,
  adminMutationOutputSchema,
  adminMutationReasonSchema,
  adminPageOutput,
  isoTimestampSchema,
  paiseStringSchema,
} from './common.js';

/**
 * admin/wallet.ts (P28 Unit U4, step 9) - the staff wallet surface: the
 * wallet header (carried on the client detail), the ledger, the top-up
 * queue, and the money-moving mutation proxies.
 *
 * MONEY IS A DECIMAL STRING OF PAISE everywhere in this file, never a JS
 * number. These are `bigint` columns holding real money; `JSON.stringify`
 * throws on a bigint and a float cannot represent every value in that range
 * exactly, so a number here would silently corrupt large amounts.
 * `paiseStringSchema` is SIGNED because a ledger debit is negative.
 *
 * THE LEDGER PROJECTION OMITS `externalRef` AND `reason`, deliberately.
 * `external_ref` is a UTR/bank reference tying a real payment to a named
 * person; `reason` is unstructured free text, which is exactly where PII
 * accumulates. The staff-side trail for ledger changes lives in
 * `GET /admin/v1/audit` instead, keyed to the staff member who wrote it -
 * so the accountability is preserved without a browsable PII surface.
 */

export const adminWalletStateSchema = z.enum(['active', 'low', 'empty', 'frozen']);

export const adminWalletHeaderSchema = z
  .object({
    clientId: z.uuid(),
    state: z.string().min(1),
    currency: z.string().min(1),
    balanceMinor: paiseStringSchema,
    /** The per-message rate ceiling - what makes "messages remaining" computable. */
    maxRateMinor: paiseStringSchema,
    lowThresholdMinor: paiseStringSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type AdminWalletHeader = z.infer<typeof adminWalletHeaderSchema>;

export const adminWalletLedgerItemSchema = z
  .object({
    /** The per-client monotonic sequence - also the keyset tiebreaker. */
    seq: z.string().regex(/^\d+$/),
    kind: z.string().min(1),
    amountMinor: paiseStringSchema,
    balanceAfterMinor: paiseStringSchema,
    actorType: z.string().min(1),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type AdminWalletLedgerItem = z.infer<typeof adminWalletLedgerItemSchema>;

export const adminWalletLedgerOutputSchema = adminPageOutput(adminWalletLedgerItemSchema);
export type AdminWalletLedgerOutput = z.infer<typeof adminWalletLedgerOutputSchema>;

export const adminWalletLedgerContract = oc
  .route({ method: 'GET', path: '/admin/v1/clients/{id}/wallet/ledger' })
  .input(adminListQuerySchema)
  .output(adminWalletLedgerOutputSchema);

export const adminTopupItemSchema = z
  .object({
    id: z.uuid(),
    clientId: z.uuid(),
    amountMinor: paiseStringSchema,
    method: z.enum(['upi', 'bank_transfer']),
    status: z.enum(['pending', 'approved', 'rejected']),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type AdminTopupItem = z.infer<typeof adminTopupItemSchema>;

export const adminListTopupsQuerySchema = adminListQuerySchema
  .extend({ status: z.enum(['pending', 'approved', 'rejected']).optional() })
  .strict();

export const adminListTopupsOutputSchema = adminPageOutput(adminTopupItemSchema);

export const adminListTopupsContract = oc
  .route({ method: 'GET', path: '/admin/v1/topups' })
  .input(adminListTopupsQuerySchema)
  .output(adminListTopupsOutputSchema);

/**
 * CREDIT adds money; `amountMinor` is a POSITIVE paise string (the schema
 * rejects a negative), so "credit a negative amount" is not expressible -
 * taking money away is `adjust`, a separate, `superadmin`-only action with
 * its own audit action name. Splitting them this way means the audit trail
 * distinguishes "we added funds" from "we corrected a balance" without
 * having to inspect a sign.
 */
export const adminCreditWalletInputSchema = adminMutationReasonSchema
  .extend({
    amountMinor: z.string().regex(/^\d+$/),
    kind: z.enum(['topup_manual', 'promo_credit', 'adjustment_credit']),
  })
  .strict();

export const adminCreditWalletContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/wallet/credit' })
  .input(adminCreditWalletInputSchema)
  .output(adminMutationOutputSchema);

/** SIGNED - an adjustment may move a balance either way. `superadmin` only. */
export const adminAdjustWalletInputSchema = adminMutationReasonSchema
  .extend({ amountMinor: paiseStringSchema })
  .strict();

export const adminAdjustWalletContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/wallet/adjust' })
  .input(adminAdjustWalletInputSchema)
  .output(adminMutationOutputSchema);

export const adminFreezeWalletContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/wallet/freeze' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminUnfreezeWalletContract = oc
  .route({ method: 'POST', path: '/admin/v1/clients/{id}/wallet/unfreeze' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminApproveTopupContract = oc
  .route({ method: 'POST', path: '/admin/v1/topups/{id}/approve' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminRejectTopupContract = oc
  .route({ method: 'POST', path: '/admin/v1/topups/{id}/reject' })
  .input(adminMutationReasonSchema)
  .output(adminMutationOutputSchema);

export const adminWalletContract = {
  ledger: adminWalletLedgerContract,
  listTopups: adminListTopupsContract,
  credit: adminCreditWalletContract,
  adjust: adminAdjustWalletContract,
  freeze: adminFreezeWalletContract,
  unfreeze: adminUnfreezeWalletContract,
  approveTopup: adminApproveTopupContract,
  rejectTopup: adminRejectTopupContract,
} as const;
