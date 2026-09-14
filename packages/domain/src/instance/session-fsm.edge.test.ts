import { describe, expect, it } from 'vitest';
import {
  applyDisconnect,
  beginPairing,
  pairingExpired,
  type DisconnectPolicyRowLike,
} from './session-fsm.js';

/**
 * session-fsm.edge.test.ts - E3 edge-case pass (P08 session-qr-linking).
 * Pins `applyDisconnect`'s behavior when fed the SAME policy row twice in a
 * row on an instance that is ALREADY at the outcome state (double 403 on an
 * already-paused instance, double 401/purge on an already-logged_out
 * instance). `applyDisconnect` takes a `DisconnectPolicyRowLike` (data), not
 * an `InstanceSnapshot` - it has NO current-state parameter and therefore
 * cannot consult (or enforce) `LEGAL_HEALTH_TRANSITIONS`/`LEGAL_LINK_TRANSITIONS`
 * the way `beginPairing`/`pairingSucceeded`/`pairingExpired` do. This is
 * pinned as DOCUMENTED, INTENTIONAL behavior (a pure, idempotent mapping from
 * policy row -> Transition, safe to call repeatedly), not a bug - the runner
 * caller is the one responsible for not re-emitting side effects (see
 * runner-disconnect.edge.integration.test.ts for that half of the guarantee).
 */

function restrictionRow(): DisconnectPolicyRowLike {
  return {
    healthState: 'paused',
    linkState: 'linked',
    autoReconnect: false,
    budget: null,
    action: 'restriction',
    surfaceAsError: true,
  };
}

function purgeRow(): DisconnectPolicyRowLike {
  return {
    healthState: 'logged_out',
    linkState: 'unlinked',
    autoReconnect: false,
    budget: null,
    action: 'purge',
    surfaceAsError: true,
  };
}

describe('session-fsm edge: applyDisconnect on an instance already at the outcome state', () => {
  it('a second 403 (restriction) while already paused produces the SAME transition, no throw', () => {
    const counters = { restart515Used: 0, unknownAttempts: 0 };
    const first = applyDisconnect(restrictionRow(), counters);
    const second = applyDisconnect(restrictionRow(), counters);

    expect(first.healthState).toBe('paused');
    expect(second.healthState).toBe('paused');
    expect(second.userActionReason).toBe('RESTRICTION_SIGNAL');
    expect(second.sideEffects).toEqual(['audit', 'notify']);
  });

  it('a second 401 (purge) while already logged_out/unlinked produces the SAME transition, no throw', () => {
    const counters = { restart515Used: 0, unknownAttempts: 0 };
    const first = applyDisconnect(purgeRow(), counters);
    const second = applyDisconnect(purgeRow(), counters);

    expect(first.healthState).toBe('logged_out');
    expect(second.healthState).toBe('logged_out');
    expect(second.linkState).toBe('unlinked');
    expect(second.sideEffects).toEqual(['purge_auth', 'audit', 'notify']);
  });

  it('applyDisconnect never throws regardless of the "current" state - no legal-transition table is consulted', () => {
    // Unlike beginPairing/pairingExpired (which DO throw on an illegal
    // current linkState), applyDisconnect has no snapshot parameter at all -
    // this is a structural guarantee, not just an empirical one.
    expect(() =>
      applyDisconnect(restrictionRow(), { restart515Used: 0, unknownAttempts: 0 }),
    ).not.toThrow();
    expect(() =>
      applyDisconnect(purgeRow(), { restart515Used: 5, unknownAttempts: 5 }),
    ).not.toThrow();
  });
});

describe('session-fsm edge: illegal transitions on the runner-facing entry points', () => {
  it('pairingExpired is illegal from an already-unlinked (never-pairing) snapshot', () => {
    expect(() =>
      pairingExpired({
        healthState: 'never_linked',
        linkState: 'unlinked',
        desiredState: 'online',
        needsUserAction: false,
        userActionReason: null,
      }),
    ).toThrow(RangeError);
  });

  it('beginPairing is illegal while already pairing (double link-start)', () => {
    expect(() =>
      beginPairing({
        healthState: 'never_linked',
        linkState: 'pairing',
        desiredState: 'online',
        needsUserAction: false,
        userActionReason: null,
      }),
    ).toThrow(/illegal link transition pairing -> pairing/);
  });
});
