/**
 * features/notifications/keys.ts (P17 U5) - query key factory only, same
 * shape-matters idiom as `features/instances/keys.ts`. `list()` carries no
 * per-cursor identity: a keyset-paginated list is one infinite-query cache
 * entry per filter set, not one entry per page, so invalidating `list()`
 * always refreshes the whole paginated view from its first page.
 * `unreadCount()` is a separate key so a `notification.created` push can
 * invalidate the badge and the list independently of one another if a
 * future caller ever needs to.
 */
export const notificationKeys = {
  all: ['notifications'] as const,
  list: () => ['notifications', 'list'] as const,
  // The dashboard's recent-activity card reads ONE page with plain useQuery; the bell owns
  // list() as an infinite query, so the two must never share a cache entry (an infinite
  // query's data is {pages, pageParams}, not a page). Child of list() so every
  // invalidation of the prefix still refreshes it.
  recent: () => ['notifications', 'list', 'recent'] as const,
  unreadCount: () => ['notifications', 'unread-count'] as const,
};
