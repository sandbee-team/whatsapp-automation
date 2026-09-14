import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope, paginationInputSchema } from '../envelope.js';

/**
 * app/wallet.ts (P19 Unit U2, step 3) - the TENANT wallet surface:
 * `GET /v1/wallet` (balance/state/threshold/estimated remaining messages),
 * `POST /v1/wallet/topup-requests` (a client asking staff to approve a
 * manual top-up - it does NOT move money itself, see
 * `packages/contracts/src/internal/wallet.ts` for the staff-side credit
 * that actually does), and `GET /v1/wallet/topup-requests` (the client's
 * own request history). Money is `z.number().int()` PAISE everywhere in
 * this file - never a float, never a decimal string parsed with
 * `parseFloat` - matching every other money field in this package
 * (`instance-card.ts`, `pacing.ts`). `.strict()` on every object schema so
 * an unplanned field cannot silently drift the wire shape.
 */

export const walletStateSchema = z.enum(['active', 'low', 'empty', 'frozen']);
export type WalletStateContract = z.infer<typeof walletStateSchema>;

/**
 * PAISE as a decimal STRING wire type - used for any money field whose
 * backing value is `bigint` end-to-end (never a JS number round-trip,
 * core invariant: money is bigint paise). `JSON.stringify` throws on a
 * bigint, and a JS number cannot represent every bigint-range amount
 * exactly (above `Number.MAX_SAFE_INTEGER`), so these fields cross the
 * wire as a validated non-negative integer string instead.
 */
export const paiseAmountSchema = z.string().regex(/^\d+$/);
export type PaiseAmount = z.infer<typeof paiseAmountSchema>;

/**
 * P28 C2 FIX (Bug 3): `paiseAmountSchema` chained with a bare
 * `.refine((value) => BigInt(value) > 0n, ...)` is UNSAFE in this Zod 4
 * version - a failed `.regex(/^\d+$/)` check does not short-circuit the
 * chain, so the refine's predicate still runs against a value that already
 * failed validation. `BigInt('1e3')` (or any other non-digit-string input
 * that still reaches here) throws a raw, uncaught `SyntaxError` out of
 * `parse`/`safeParse` instead of the refine cleanly returning `false` - at
 * the route layer that becomes an unhandled throw mapped to a 500
 * `INTERNAL`, never the 400 `VALIDATION_ERROR` every other malformed
 * `amountMinor` produces. `positivePaiseSchema` is the ONE shared
 * "amountMinor > 0" schema every paise input in this package must use
 * instead of hand-rolling its own `paiseAmountSchema.refine(...)`: its
 * predicate re-checks `/^\d+$/` itself before ever calling `BigInt`, so a
 * non-digit string fails the refine (a clean `false`) rather than throwing.
 */
export const positivePaiseSchema = paiseAmountSchema.refine(
  (value) => /^\d+$/.test(value) && BigInt(value) > 0n,
  { message: 'amountMinor must be greater than zero' },
);
export type PositivePaiseAmount = z.infer<typeof positivePaiseSchema>;

export const walletSummaryDataSchema = z
  .object({
    balanceMinor: z.number().int(),
    state: walletStateSchema,
    lowBalanceThresholdMinor: z.number().int().nonnegative(),
    maxRateMinor: z.number().int().positive(),
    /** balanceMinor / maxRateMinor, floored - a rough "messages left" estimate, never a promise. */
    estimatedMessagesRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type WalletSummaryData = z.infer<typeof walletSummaryDataSchema>;

export const walletSummaryOutputSchema = successEnvelope(walletSummaryDataSchema);
export type WalletSummaryOutput = z.infer<typeof walletSummaryOutputSchema>;

export const walletSummaryContract = oc
  .route({ method: 'GET', path: '/v1/wallet' })
  .output(walletSummaryOutputSchema);

export const topupRequestStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type TopupRequestStatus = z.infer<typeof topupRequestStatusSchema>;

/** `topup_requests.method` (migration 0058) - v1 supports UPI and bank transfer only, both manual. */
export const topupMethodSchema = z.enum(['upi', 'bank_transfer']);
export type TopupMethod = z.infer<typeof topupMethodSchema>;

/**
 * P19 Unit U4 (step 7, additive): `method` and `externalRef` (the UTR/
 * reference number the tenant types) were missing from this schema even
 * though `topup_requests.method`/`external_ref` are both NOT NULL
 * (migration 0058) - added here rather than invented ad hoc in the route,
 * per this unit's own "ADD it there additively" instruction.
 * `externalRef` is trimmed and length-bounded to match the same discipline
 * `createMessageHeadersSchema`'s idempotency key uses elsewhere in this
 * package - a blank value cannot masquerade as a real UTR.
 */
export const createTopupRequestInputSchema = z
  .object({
    amountMinor: z.number().int().positive(),
    method: topupMethodSchema,
    externalRef: z.string().trim().min(1).max(255),
    note: z.string().max(500).optional(),
  })
  .strict();
export type CreateTopupRequestInput = z.infer<typeof createTopupRequestInputSchema>;

export const topupRequestItemSchema = z
  .object({
    id: z.string(),
    /** PAISE, decimal string wire type - see `paiseAmountSchema`'s own doc comment. */
    amountMinor: paiseAmountSchema,
    status: topupRequestStatusSchema,
    note: z.string().max(500).optional(),
    createdAt: z.string(),
  })
  .strict();
export type TopupRequestItem = z.infer<typeof topupRequestItemSchema>;

export const createTopupRequestOutputSchema = successEnvelope(topupRequestItemSchema);
export type CreateTopupRequestOutput = z.infer<typeof createTopupRequestOutputSchema>;

export const createTopupRequestContract = oc
  .route({ method: 'POST', path: '/v1/wallet/topup-requests' })
  .input(createTopupRequestInputSchema)
  .output(createTopupRequestOutputSchema);

export const listTopupRequestsInputSchema = paginationInputSchema;
export type ListTopupRequestsInput = z.infer<typeof listTopupRequestsInputSchema>;

export const listTopupRequestsOutputSchema = successEnvelope(z.array(topupRequestItemSchema));
export type ListTopupRequestsOutput = z.infer<typeof listTopupRequestsOutputSchema>;

export const listTopupRequestsContract = oc
  .route({ method: 'GET', path: '/v1/wallet/topup-requests' })
  .input(listTopupRequestsInputSchema)
  .output(listTopupRequestsOutputSchema);

/**
 * P19 Unit U4 (step 7, additive): a single-item read, needed so a tenant
 * probing another tenant's `id` gets a `404` (never a cross-tenant leak) -
 * the list route alone cannot express that (an empty array vs "not yours"
 * are indistinguishable from a list response).
 */
export const getTopupRequestInputSchema = z.object({ id: z.string().uuid() }).strict();
export type GetTopupRequestInput = z.infer<typeof getTopupRequestInputSchema>;

export const getTopupRequestOutputSchema = successEnvelope(topupRequestItemSchema);
export type GetTopupRequestOutput = z.infer<typeof getTopupRequestOutputSchema>;

export const getTopupRequestContract = oc
  .route({ method: 'GET', path: '/v1/wallet/topup-requests/{id}' })
  .input(getTopupRequestInputSchema)
  .output(getTopupRequestOutputSchema);

/**
 * P19 Unit U5 (step 9, additive): `GET /v1/queue-status` - per-instance
 * queue rows plus workspace totals. `waiting`/`sentToday`/`failedToday` are
 * plain counts; `spentTodayMinor` is PAISE (net of same-day refunds - see
 * `db/queries/queue-status.sql`'s own header), never a float.
 */
export const queueStatusInstanceSchema = z
  .object({
    instanceId: z.string(),
    waiting: z.number().int().nonnegative(),
    sentToday: z.number().int().nonnegative(),
    failedToday: z.number().int().nonnegative(),
    /** PAISE, decimal string wire type - see `paiseAmountSchema`'s own doc comment. */
    spentTodayMinor: paiseAmountSchema,
  })
  .strict();
export type QueueStatusInstance = z.infer<typeof queueStatusInstanceSchema>;

export const queueStatusWorkspaceSchema = z
  .object({
    waiting: z.number().int().nonnegative(),
    sentToday: z.number().int().nonnegative(),
    failedToday: z.number().int().nonnegative(),
    spentTodayMinor: paiseAmountSchema,
  })
  .strict();
export type QueueStatusWorkspace = z.infer<typeof queueStatusWorkspaceSchema>;

export const queueStatusDataSchema = z
  .object({
    instances: z.array(queueStatusInstanceSchema),
    workspace: queueStatusWorkspaceSchema,
  })
  .strict();
export type QueueStatusData = z.infer<typeof queueStatusDataSchema>;

export const queueStatusOutputSchema = successEnvelope(queueStatusDataSchema);
export type QueueStatusOutput = z.infer<typeof queueStatusOutputSchema>;

export const queueStatusContract = oc
  .route({ method: 'GET', path: '/v1/queue-status' })
  .output(queueStatusOutputSchema);

export const walletContract = {
  summary: walletSummaryContract,
  createTopupRequest: createTopupRequestContract,
  listTopupRequests: listTopupRequestsContract,
  getTopupRequest: getTopupRequestContract,
  queueStatus: queueStatusContract,
} as const;
