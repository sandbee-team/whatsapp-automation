import { describe, expect, it } from 'vitest';
import { canStaff, staffActionsFor, STAFF_ACTIONS, type StaffAction } from '../src/staff/rbac.js';
import type { StaffRole } from '../src/enums/p28-admin.js';

/**
 * staff-rbac.test.ts (P28 Unit U2, step 3) - a literal (role, action) table
 * asserted explicitly, NOT derived from `canStaff`'s own matrix (a
 * derived-from-itself table would be a tautology - see this dispatch's own
 * "matrix table test" instruction). Covers every role at least once per
 * read/mutate boundary plus the money/pricing/relax/elevate actions that are
 * superadmin-only.
 */

const READ_ACTIONS: readonly StaffAction[] = [
  'clients.read',
  'instances.read',
  'queue.read',
  'wallet.read',
  'audit.read',
  'topups.read',
];

describe('canStaff', () => {
  it('support_role_cannot_adjust_a_wallet_or_relax_pacing', () => {
    const cases: Array<[StaffRole, StaffAction, boolean]> = [
      // support: every *.read + impersonation.grant + impersonation.revoke
      ['support', 'clients.read', true],
      ['support', 'instances.read', true],
      ['support', 'queue.read', true],
      ['support', 'wallet.read', true],
      ['support', 'audit.read', true],
      ['support', 'topups.read', true],
      ['support', 'impersonation.grant', true],
      ['support', 'impersonation.revoke', true],
      ['support', 'clients.suspend', false],
      ['support', 'clients.reactivate', false],
      ['support', 'clients.limits', false],
      ['support', 'clients.plan', false],
      ['support', 'clients.pricing', false],
      ['support', 'wallet.credit', false],
      ['support', 'wallet.adjust', false],
      ['support', 'wallet.freeze', false],
      ['support', 'wallet.unfreeze', false],
      ['support', 'topups.approve', false],
      ['support', 'topups.reject', false],
      ['support', 'instances.pause', false],
      ['support', 'instances.resume', false],
      ['support', 'pacing.relax', false],
      ['support', 'campaigns.cancel', false],
      ['support', 'impersonation.elevate', false],

      // ops: support + suspend/reactivate/limits/plan + wallet.credit/freeze/unfreeze
      // + topups.approve/reject + instances.pause/resume + campaigns.cancel
      ['ops', 'clients.read', true],
      ['ops', 'wallet.read', true],
      ['ops', 'impersonation.grant', true],
      ['ops', 'impersonation.revoke', true],
      ['ops', 'clients.suspend', true],
      ['ops', 'clients.reactivate', true],
      ['ops', 'clients.limits', true],
      ['ops', 'clients.plan', true],
      ['ops', 'wallet.credit', true],
      ['ops', 'wallet.freeze', true],
      ['ops', 'wallet.unfreeze', true],
      ['ops', 'topups.approve', true],
      ['ops', 'topups.reject', true],
      ['ops', 'instances.pause', true],
      ['ops', 'instances.resume', true],
      ['ops', 'campaigns.cancel', true],
      // ops does NOT get pricing, adjust, pacing.relax, or impersonation.elevate
      ['ops', 'clients.pricing', false],
      ['ops', 'wallet.adjust', false],
      ['ops', 'pacing.relax', false],
      ['ops', 'impersonation.elevate', false],

      // superadmin: everything
      ['superadmin', 'clients.read', true],
      ['superadmin', 'clients.suspend', true],
      ['superadmin', 'clients.pricing', true],
      ['superadmin', 'wallet.credit', true],
      ['superadmin', 'wallet.adjust', true],
      ['superadmin', 'wallet.freeze', true],
      ['superadmin', 'topups.approve', true],
      ['superadmin', 'instances.pause', true],
      ['superadmin', 'pacing.relax', true],
      ['superadmin', 'campaigns.cancel', true],
      ['superadmin', 'impersonation.grant', true],
      ['superadmin', 'impersonation.elevate', true],
      ['superadmin', 'impersonation.revoke', true],
    ];

    for (const [role, action, expected] of cases) {
      expect(canStaff(role, action)).toBe(expected);
    }
  });

  it('every_read_action_is_available_to_every_role', () => {
    for (const role of ['support', 'ops', 'superadmin'] as const) {
      for (const action of READ_ACTIONS) {
        expect(canStaff(role, action)).toBe(true);
      }
    }
  });

  it('staffActionsFor_returns_exactly_the_allowed_action_set_per_role', () => {
    const supportActions = staffActionsFor('support');
    expect([...supportActions].sort()).toEqual(
      [...READ_ACTIONS, 'impersonation.grant', 'impersonation.revoke'].sort(),
    );

    const superadminActions = staffActionsFor('superadmin');
    expect([...superadminActions].sort()).toEqual([...STAFF_ACTIONS].sort());
  });
});
