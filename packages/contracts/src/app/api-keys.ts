import { oc } from '@orpc/contract';
import { z } from 'zod';
import { successEnvelope } from '../envelope.js';

/**
 * api-keys.ts (api-keys U2) - `api_keys` CRUD contracts (wire shapes only;
 * generation/hashing live in `app/backend/src/modules/api-keys`, routing in
 * a later unit). Columns per U1's migration: `client_id, id, name,
 * key_prefix (globally unique, wp_live_[0-9a-f]{12}), secret_hash bytea,
 * last4 ([0-9a-f]{4}), created_by_user_id, created_at, last_used_at,
 * revoked_at`.
 *
 * The raw one-time `key` (full `wp_live_<prefix>_<secret>` string) appears
 * in EXACTLY ONE response shape in this whole file -
 * `createApiKeyOutputSchema` - and nowhere else: `listApiKeysOutputSchema`
 * never carries it (only `keyPrefix`/`last4`, the same "shown once" pattern
 * as `modules/webhooks`' `secret` field on its create response).
 */

const apiKeyNameSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------------
// POST /v1/api-keys
// ---------------------------------------------------------------------

export const createApiKeyInputSchema = z
  .object({
    name: apiKeyNameSchema,
  })
  .strict();
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

/** `key` is the full one-time key in the clear - see this file's own header comment; never repeated in any other schema here. */
export const createApiKeyOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    name: apiKeyNameSchema,
    keyPrefix: z.string(),
    last4: z.string().regex(/^[0-9a-f]{4}$/),
    createdAt: z.iso.datetime(),
    key: z.string(),
  }),
);
export type CreateApiKeyOutput = z.infer<typeof createApiKeyOutputSchema>;

export const createApiKeyContract = oc
  .route({ method: 'POST', path: '/v1/api-keys' })
  .input(createApiKeyInputSchema)
  .output(createApiKeyOutputSchema);

// ---------------------------------------------------------------------
// GET /v1/api-keys
// ---------------------------------------------------------------------

const apiKeySummarySchema = z.object({
  id: z.uuid(),
  name: apiKeyNameSchema,
  keyPrefix: z.string(),
  last4: z.string().regex(/^[0-9a-f]{4}$/),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const listApiKeysOutputSchema = successEnvelope(
  z.object({
    items: z.array(apiKeySummarySchema),
  }),
);
export type ListApiKeysOutput = z.infer<typeof listApiKeysOutputSchema>;

export const listApiKeysContract = oc
  .route({ method: 'GET', path: '/v1/api-keys' })
  .output(listApiKeysOutputSchema);

// ---------------------------------------------------------------------
// DELETE /v1/api-keys/:id  (revoke)
// ---------------------------------------------------------------------

export const revokeApiKeyInputSchema = z.object({ id: z.uuid() }).strict();
export type RevokeApiKeyInput = z.infer<typeof revokeApiKeyInputSchema>;

export const revokeApiKeyOutputSchema = successEnvelope(
  z.object({
    id: z.uuid(),
    revokedAt: z.iso.datetime(),
  }),
);
export type RevokeApiKeyOutput = z.infer<typeof revokeApiKeyOutputSchema>;

export const revokeApiKeyContract = oc
  .route({ method: 'DELETE', path: '/v1/api-keys/{id}' })
  .input(revokeApiKeyInputSchema)
  .output(revokeApiKeyOutputSchema);

export const apiKeysContract = {
  create: createApiKeyContract,
  list: listApiKeysContract,
  revoke: revokeApiKeyContract,
} as const;
