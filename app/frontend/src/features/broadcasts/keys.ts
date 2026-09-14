/**
 * features/broadcasts/keys.ts (P23a Unit U3, step 2) - query key factory
 * only, same shape-matters idiom as `features/contacts/keys.ts`/
 * `features/instances/keys.ts`: exact key shapes matter because `lib/
 * sse-invalidation-map.ts`'s static invalidation map calls
 * `invalidateQueries({ queryKey })` with these exact arrays for the
 * `campaign.progress` event (`detail(id)` + `list()`).
 */
export const broadcastKeys = {
  all: ['broadcasts'] as const,
  list: () => ['broadcasts', 'list'] as const,
  detail: (id: string) => ['broadcasts', 'detail', id] as const,
  preflight: (id: string) => ['broadcasts', 'preflight', id] as const,
};
