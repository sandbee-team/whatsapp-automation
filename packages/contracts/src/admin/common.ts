import { z } from 'zod';
import { successEnvelope } from '../envelope.js';

/**
 * admin/common.ts (P28 Unit U4, step 9) - the shared shapes of the
 * `/admin/v1` staff surface (`adminContract`). Unit U6 (the admin frontend)
 * consumes these, so this is the ONE wire definition both sides compile
 * against - a projection change that forgot the panel would fail to compile
 * rather than render `undefined`.
 *
 * Three conventions hold across every schema in this directory:
 *
 * 1. `.strict()` on every object, so an unplanned backend field cannot
 *    silently reach the panel. That matters more here than on the tenant
 *    API: the whole point of the admin projection discipline is that
 *    `phone_e164`/`payload`/`external_ref` never leave the database, and
 *    `.strict()` makes an accidental addition a VALIDATION FAILURE the
 *    integration test catches, not a quiet leak.
 * 2. Money is PAISE as a decimal STRING (`paiseStringSchema`), never a JS
 *    number - the backing columns are `bigint`, `JSON.stringify` throws on
 *    a bigint, and a float cannot represent every amount in that range
 *    exactly. Same wire type as `app/wallet.ts`'s `paiseAmountSchema`.
 * 3. Lists are keyset-paginated: `cursor` is an OPAQUE server-issued token
 *    and `nextCursor: null` is the only end-of-list signal. There is no
 *    page number and no total count, deliberately - a total would require
 *    an unbounded cross-tenant COUNT on every page.
 */

/** PAISE as a decimal string; SIGNED, because a ledger debit is negative. */
export const paiseStringSchema = z.string().regex(/^-?\d+$/);
export type PaiseString = z.infer<typeof paiseStringSchema>;

/** ISO-8601 timestamp string - every admin timestamp crosses the wire this way. */
export const isoTimestampSchema = z.string().min(1);

/** Shared list query: keyset cursor + bounded limit. No `offset`, ever. */
export const adminListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque, server-issued. A client never constructs one. */
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type AdminListQuery = z.infer<typeof adminListQuerySchema>;

/**
 * A keyset page. `nextCursor: null` means "this was the last page" - a
 * caller stops on null and NEVER by comparing `items.length` to `limit`
 * (a full final page is indistinguishable from a non-final one that way).
 */
export function adminPage<TItem extends z.ZodType>(itemSchema: TItem) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable(),
    })
    .strict();
}

export function adminPageOutput<TItem extends z.ZodType>(itemSchema: TItem) {
  return successEnvelope(adminPage(itemSchema));
}

/** The `X-Staff-Reason` header carried by every admin READ (recorded in the audit row; see `clients.routes.ts`). */
export const staffReadReasonHeaderSchema = z
  .object({
    'x-staff-reason': z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * The staff `reason` on every MUTATION - MANDATORY, minimum length
 * enforced. A mutation without a reason is a 400 before anything happens:
 * `staff_audit_log.reason` is NOT NULL with a non-blank CHECK (migration
 * 0058/0070), so a reasonless staff action is impossible at the storage
 * layer too, not merely discouraged by this schema.
 */
export const adminMutationReasonSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminMutationReason = z.infer<typeof adminMutationReasonSchema>;

/**
 * The `Idempotency-Key` header the panel sends: ONE uuid per user action,
 * reused verbatim across retries of that same action. The admin route
 * passes it through to `/internal/v1` unchanged, where a UNIQUE constraint
 * on `staff_audit_log.idempotency_key` is the actual dedupe authority
 * (core invariant 3 - never an in-memory check).
 */
export const adminMutationHeadersSchema = z
  .object({
    'idempotency-key': z.string().trim().min(8).max(200),
  })
  .strict();
export type AdminMutationHeaders = z.infer<typeof adminMutationHeadersSchema>;

/** Every mutation proxy answers with the internal API's own verdict, unflattened. */
export const adminMutationResultSchema = z
  .object({
    ok: z.literal(true),
    /** True when `/internal/v1` REPLAYED a prior identical call rather than applying a new change. */
    replayed: z.boolean(),
  })
  .strict();
export const adminMutationOutputSchema = successEnvelope(adminMutationResultSchema);
export type AdminMutationOutput = z.infer<typeof adminMutationOutputSchema>;
