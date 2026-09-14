/**
 * P28 (admin-internal-api-and-panel) Unit U1 delta enums (migration 0070) -
 * labels verbatim, in the exact declared order (db/tests/enum-parity.test.ts
 * asserts order equality). Split out of `index.ts` (P28 U1, to stay under
 * the `max-lines: 300` cap - same "move a self-contained delta-enum block to
 * a sibling module" idiom `enums-exports.ts` already established for the
 * whole re-export block); re-exported unchanged from `index.ts` and merged
 * into `PG_ENUMS` there.
 */
export const STAFF_ROLES = ['support', 'ops', 'superadmin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const IMPERSONATION_SCOPES = ['metadata_only', 'with_message_bodies'] as const;
export type ImpersonationScope = (typeof IMPERSONATION_SCOPES)[number];
