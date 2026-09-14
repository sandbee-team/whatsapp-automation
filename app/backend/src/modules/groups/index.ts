/**
 * modules/groups - public barrel (P24 groups-messaging). Pre-created by the
 * orchestrating session so the three parallel units never share a file:
 * `groups.public.ts` (U3: sync, repo, routes, service), `send-lookup.public.ts`
 * (U4a: enqueue-time group eligibility) and `forbidden.public.ts` (U4b: the
 * `group_forbidden` result hook). Each unit edits only its own public file.
 */
export * from './groups.public.js';
export * from './send-lookup.public.js';
export * from './forbidden.public.js';
