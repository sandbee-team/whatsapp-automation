/**
 * features/contacts/keys.ts (P20 Unit U9, step 10) - query key factory only,
 * same shape-matters idiom as `features/webhooks/keys.ts`. `list` is keyed by
 * its filters (search/tag/opt-out state) so each filter combination caches
 * independently; the keyset cursor itself is NOT part of the key (TanStack
 * Query's `useInfiniteQuery` owns pagination for a given filter set).
 */
export interface ContactsListFilters {
  q?: string;
  tagId?: string;
  optOutState?: 'none' | 'opted_out';
}

export const contactsKeys = {
  list: (filters: ContactsListFilters) => ['contacts', 'list', filters] as const,
  detail: (id: string) => ['contacts', 'detail', id] as const,
  tags: () => ['contacts', 'tags'] as const,
  imports: () => ['contacts', 'imports'] as const,
  import: (id: string) => ['contacts', 'imports', id] as const,
};
