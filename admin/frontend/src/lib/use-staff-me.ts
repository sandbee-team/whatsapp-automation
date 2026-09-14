import { getRouteApi } from '@tanstack/react-router';
import { canStaff, type StaffAction } from '@wp/domain';
import type { StaffMeData } from '../features/auth/index.js';

const authedRoute = getRouteApi('/_authed');

/**
 * lib/use-staff-me.ts (P28 Unit U6, step 9) - reads the authenticated staff
 * member from the `_authed` route loader (no second `me()` fetch) and
 * exposes `canDo(action)`, the ONE place every control's disabled/tooltip
 * state is derived from `canStaff(role, action)`. A UX affordance only:
 * every mutation re-checks RBAC server-side.
 */
export interface UseStaffMeResult {
  me: StaffMeData;
  canDo: (action: StaffAction) => boolean;
}

export function useStaffMe(): UseStaffMeResult {
  const { me } = authedRoute.useLoaderData();
  return { me, canDo: (action) => canStaff(me.role, action) };
}
