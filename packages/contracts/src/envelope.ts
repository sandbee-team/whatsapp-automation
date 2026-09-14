import { z } from 'zod';
import { errorBodySchema } from './errors.js';

/**
 * Every response - success or error - carries `requestId`. `nextCursor` is
 * present only on list responses that have more pages (keyset pagination,
 * see `paginationInputSchema` below).
 */
export const metaSchema = z.object({
  requestId: z.string(),
  nextCursor: z.string().optional(),
});

export type Meta = z.infer<typeof metaSchema>;

/**
 * The success envelope, generic over the payload schema:
 * `{ "data": <payload>, "meta": { "requestId", "nextCursor"? } }`
 * (docs/CONVENTIONS.md §6.3).
 */
export function successEnvelope<TData extends z.ZodType>(dataSchema: TData) {
  return z.object({
    data: dataSchema,
    meta: metaSchema,
  });
}

export type SuccessEnvelope<TData extends z.ZodType> = ReturnType<typeof successEnvelope<TData>>;

/**
 * The error envelope: `{ "error": { code, message, details?, requestId } }`.
 */
export const errorEnvelopeSchema = z.object({
  error: errorBodySchema,
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Shared keyset-pagination input for every list route. `cursor` is an
 * opaque, server-issued token (never a client-constructed offset - `OFFSET`
 * pagination is a lint error, see `packages/config/eslint.config.js` /
 * docs/CONVENTIONS.md §6.3). `limit` is capped at 100.
 */
export const paginationInputSchema = z.object({
  cursor: z.string().optional(),
  /**
   * Coerced from string: Fastify hands `req.query` values as STRINGS, so a
   * plain `z.number()` here rejects every real request (P26b finding c).
   */
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationInput = z.infer<typeof paginationInputSchema>;
