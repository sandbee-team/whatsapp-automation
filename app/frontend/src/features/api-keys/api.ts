import type { z } from 'zod';
import {
  createApiKeyInputSchema,
  createApiKeyOutputSchema,
  listApiKeysOutputSchema,
  revokeApiKeyOutputSchema,
} from '@wp/contracts';
import { apiFetch } from '../../lib/api-client.js';

/**
 * features/api-keys/api.ts (go-live U5) - the client side of
 * `apiKeysContract` (`create`/`list`/`revoke`). Every response type is
 * inferred FROM the imported `@wp/contracts` schemas (never hand-typed),
 * same idiom as `features/webhooks/api.ts`.
 *
 * `create`'s response carries `key` - the full one-time API key - in the
 * clear ONCE (contract doc comment: "the raw one-time `key`... appears in
 * EXACTLY ONE response shape"). Callers must hand the whole result to
 * `key-once-dialog.tsx` and never persist `key` beyond that render;
 * `listApiKeys` never carries it (only `keyPrefix`/`last4`).
 */
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;
export type CreateApiKeyResult = z.infer<typeof createApiKeyOutputSchema>['data'];
export type ApiKeySummary = z.infer<typeof listApiKeysOutputSchema>['data']['items'][number];
export type RevokeApiKeyResult = z.infer<typeof revokeApiKeyOutputSchema>['data'];

export function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  return apiFetch<CreateApiKeyResult>('/v1/api-keys', {
    method: 'POST',
    body: createApiKeyInputSchema.parse(input),
  });
}

export function listApiKeys(): Promise<ApiKeySummary[]> {
  return apiFetch<{ items: ApiKeySummary[] }>('/v1/api-keys').then((result) => result.items);
}

/**
 * `DELETE /v1/api-keys/{id}` (the contract's revoke route -
 * `revokeApiKeyContract` in `@wp/contracts`) - revocation takes effect
 * immediately.
 */
export function revokeApiKey(id: string): Promise<RevokeApiKeyResult> {
  return apiFetch<RevokeApiKeyResult>(`/v1/api-keys/${id}`, {
    method: 'DELETE',
  });
}
