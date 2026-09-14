/**
 * features/api-keys/keys.ts (go-live U5) - query key factory only, same
 * shape-matters idiom as `features/webhooks/keys.ts`. `list` is invalidated
 * by `api.ts`'s `createApiKey`/`revokeApiKey` mutations so a new/revoked key
 * appears without a manual reload.
 */
export const apiKeyKeys = {
  list: () => ['api-keys', 'list'] as const,
};
