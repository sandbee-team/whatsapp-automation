import { z } from 'zod';

/**
 * internal/common.ts (P28 Unit U2, step 3) - shared schemas/helpers for
 * every `/internal/v1` staff mutation contract: the mandatory mutation
 * headers (`idempotency-key` + `x-actor`), `parseActorHeader` (pure, throws
 * a ZodError on anything that is not `staff:<uuid>` - `system`, an
 * `api_key:...` actor, or a bare uuid are all rejected, since every
 * `/internal/v1` mutation is a NAMED staff member acting, never an
 * anonymous system actor), `staffReasonSchema` (every mutation input
 * carries `reason` - an audited action is never unreasoned), and
 * `internalMutationResultSchema`, which wraps a data schema with the
 * `replayed` flag every idempotent mutation's response carries (`true` when
 * the `idempotency-key` matched an existing row and no new side effect
 * happened).
 *
 * `staffId` and the idempotency key travel in the HEADERS, not the body -
 * this file documents that shape once so every sibling contract in this
 * directory can defer to it.
 */

export const uuidSchema = z.string().uuid();

export const internalMutationHeadersSchema = z
  .object({
    'idempotency-key': z.string().trim().min(1).max(255),
    'x-actor': z.string().regex(/^staff:[0-9a-f-]{36}$/),
  })
  .strict();
export type InternalMutationHeaders = z.infer<typeof internalMutationHeadersSchema>;

export const staffReasonSchema = z.string().trim().min(3).max(500);

export interface ParsedStaffActor {
  kind: 'staff';
  staffId: string;
}

const STAFF_ACTOR_PATTERN = /^staff:([0-9a-f-]{36})$/;

/**
 * Parses the `x-actor` header value into a `ParsedStaffActor`. Accepts ONLY
 * `staff:<uuid>` - throws a `ZodError` (via `z.string().regex(...).parse`,
 * so callers get the same error shape as any other schema-level validation
 * failure) on anything else: `system`, `api_key:x`, a bare uuid, or
 * `staff:` followed by a non-uuid value.
 */
export function parseActorHeader(value: string): ParsedStaffActor {
  const match = STAFF_ACTOR_PATTERN.exec(
    internalMutationHeadersSchema.shape['x-actor'].parse(value),
  );
  const staffId = match?.[1];
  if (!staffId) {
    // Unreachable given the regex above already enforced the shape, but
    // keeps this function's return type total without a non-null assertion.
    throw new Error('parseActorHeader: unreachable - x-actor did not match staff:<uuid>');
  }
  return { kind: 'staff', staffId };
}

/** Wraps `dataSchema` with the `replayed` flag every idempotent internal mutation response carries. */
export function internalMutationResultSchema<TData extends z.ZodRawShape>(dataSchema: TData) {
  return z.object({ ...dataSchema, replayed: z.boolean() }).strict();
}
