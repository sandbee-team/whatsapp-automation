/**
 * features/jobs/keys.ts - query key factory only (no fetching yet). See
 * `features/instances/keys.ts`'s doc comment for why exact key shapes
 * matter to `lib/sse.ts`'s static invalidation map.
 */
export const jobKeys = {
  all: ['jobs'] as const,
  detail: (jobPublicId: string) => ['jobs', 'detail', jobPublicId] as const,
  list: (instanceId: string) => ['jobs', 'list', instanceId] as const,
  needsAction: () => ['jobs', 'needsAction'] as const,
};
