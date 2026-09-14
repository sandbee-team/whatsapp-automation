import type { StaffRole } from '../enums/p28-admin.js';

/**
 * staff/rbac.ts (P28 Unit U2, step 3) - the pure staff RBAC decision: which
 * of the fixed `/internal/v1` actions a given `StaffRole` may perform. Pure,
 * no Node imports, no Date - a frozen table lookup, same "pure decision
 * function, DB/audit write is the caller's concern" shape as
 * `pacing/resolve-effective.ts`.
 *
 * The three roles nest strictly: `support` (read-only + impersonation grant/
 * revoke) is a subset of `ops` (adds the day-to-day staff mutations) is a
 * subset of `superadmin` (adds money-moving/relax/elevate - the actions with
 * the highest blast radius: `clients.pricing`, `wallet.adjust`,
 * `pacing.relax`, `impersonation.elevate`).
 *
 * WHY `wallet.credit` + `topups.approve` SIT IN `ops`, WHILE `wallet.adjust`
 * IS `superadmin`-ONLY (C1 review round 2 NOTE): both `wallet.credit` and
 * `topups.approve` are REQUEST-SHAPED money-in - a tenant (or the tenant's
 * bank transfer) already initiated the top-up; `ops` staff are confirming an
 * amount that exists independently in a bank statement/UTR, a decision with
 * an external paper trail to check against. `wallet.adjust` has no such
 * anchor: it is DISCRETIONARY goodwill/correction credit that staff decide
 * to grant on their own judgment alone, with nothing external to verify it
 * against - exactly the shape of action most likely to be abused for
 * self-dealing or social-engineered "just credit my account" requests, so it
 * stays gated behind `superadmin` alongside the other highest-blast-radius
 * actions named above.
 */

export const STAFF_ACTIONS = [
  'clients.read',
  'instances.read',
  'queue.read',
  'wallet.read',
  'audit.read',
  'topups.read',
  'clients.suspend',
  'clients.reactivate',
  'clients.limits',
  'clients.plan',
  'clients.pricing',
  'wallet.credit',
  'wallet.adjust',
  'wallet.freeze',
  'wallet.unfreeze',
  'topups.approve',
  'topups.reject',
  'instances.pause',
  'instances.resume',
  'pacing.relax',
  'campaigns.cancel',
  'impersonation.grant',
  'impersonation.elevate',
  'impersonation.revoke',
] as const;
export type StaffAction = (typeof STAFF_ACTIONS)[number];

const READ_ACTIONS: readonly StaffAction[] = [
  'clients.read',
  'instances.read',
  'queue.read',
  'wallet.read',
  'audit.read',
  'topups.read',
];

const SUPPORT_ACTIONS: readonly StaffAction[] = [
  ...READ_ACTIONS,
  'impersonation.grant',
  'impersonation.revoke',
];

const OPS_ACTIONS: readonly StaffAction[] = [
  ...SUPPORT_ACTIONS,
  'clients.suspend',
  'clients.reactivate',
  'clients.limits',
  'clients.plan',
  'wallet.credit',
  'wallet.freeze',
  'wallet.unfreeze',
  'topups.approve',
  'topups.reject',
  'instances.pause',
  'instances.resume',
  'campaigns.cancel',
];

const SUPERADMIN_ACTIONS: readonly StaffAction[] = [...STAFF_ACTIONS];

/** Frozen role -> allowed-action-set matrix. Never mutated after module load. */
const MATRIX: Readonly<Record<StaffRole, ReadonlySet<StaffAction>>> = Object.freeze({
  support: new Set(SUPPORT_ACTIONS),
  ops: new Set(OPS_ACTIONS),
  superadmin: new Set(SUPERADMIN_ACTIONS),
});

/** True when `role` may perform `action`, per the frozen matrix above. */
export function canStaff(role: StaffRole, action: StaffAction): boolean {
  return MATRIX[role].has(action);
}

/** The full set of actions available to `role`, in `STAFF_ACTIONS` order. */
export function staffActionsFor(role: StaffRole): readonly StaffAction[] {
  return STAFF_ACTIONS.filter((action) => MATRIX[role].has(action));
}
