/**
 * staff/index.ts (P28 Unit U2, step 3) - the staff RBAC decision re-export
 * block, mirroring the sibling-module split idiom `enums-exports.ts` /
 * `contacts-exports.ts` already established (never trim a contract comment
 * to make room in `src/index.ts`, split into a sibling module instead).
 */
export { canStaff, staffActionsFor, STAFF_ACTIONS, type StaffAction } from './rbac.js';
