/**
 * features/groups/keys.ts (P24 groups-messaging, Unit U5) - query key
 * factory only, same shape-matters idiom as `features/broadcasts/keys.ts`/
 * `features/contacts/keys.ts`. `list` is keyed by instance id (the keyset
 * cursor itself is not part of the key - `useInfiniteQuery` owns pagination
 * for a given instance, same as `broadcastKeys.list()`).
 */
export const groupKeys = {
  all: ['groups'] as const,
  list: (instanceId: string) => ['groups', 'list', instanceId] as const,
};
