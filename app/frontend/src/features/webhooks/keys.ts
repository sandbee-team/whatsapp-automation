/**
 * features/webhooks/keys.ts (P15 U6, step 9) - query key factory only, same
 * shape-matters idiom as `features/instances/keys.ts`. Consumed by `api.ts`'s
 * mutations (create/patch invalidate their own list) and by
 * `lib/sse-invalidation-map.ts` for `webhook.endpoint_disabled` (a
 * dispatcher-side auto-disable is server-pushed, so the endpoint list must
 * refresh without a manual reload).
 */
export const webhookKeys = {
  list: () => ['webhooks', 'endpoints', 'list'] as const,
};
