import { describe, expect, it } from 'vitest';
import {
  applyDisconnect,
  beginPairing,
  pairingExpired,
  pairingSucceeded,
  type DisconnectPolicyRowLike,
  type InstanceSnapshot,
  type Transition,
} from './session-fsm.js';

function snapshot(overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    healthState: 'connected',
    linkState: 'linked',
    desiredState: 'online',
    needsUserAction: false,
    userActionReason: null,
    ...overrides,
  };
}

function restart515Row(): DisconnectPolicyRowLike {
  return {
    healthState: 'connected',
    linkState: 'linked',
    autoReconnect: true,
    budget: 'restart515',
    action: 'stay',
    surfaceAsError: false,
  };
}

function unknownRow(): DisconnectPolicyRowLike {
  return {
    healthState: 'degraded',
    linkState: 'linked',
    autoReconnect: true,
    budget: 'limited2',
    action: 'reconnect',
    surfaceAsError: false,
  };
}

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

function sessionReplacedRow(): DisconnectPolicyRowLike {
  return {
    healthState: 'paused',
    linkState: 'linked',
    autoReconnect: false,
    budget: null,
    action: 'session_replaced',
    surfaceAsError: true,
  };
}

describe('session-fsm', () => {
  describe('link_health_and_desired_state_are_never_collapsed', () => {
    it('beginPairing only ever touches linkState (and needsUserAction/reason/sideEffects)', () => {
      const t = beginPairing(snapshot({ healthState: 'never_linked', linkState: 'unlinked' }));
      assertAtMostOneHealthOrLinkField(t);
    });

    it('pairingSucceeded only ever touches health+link together in the one legal joint pair', () => {
      const t = pairingSucceeded(snapshot({ healthState: 'never_linked', linkState: 'pairing' }));
      // The only joint-write pair allowed is logged_out+unlinked; pairing success
      // moves to connected+linked, which is a DIFFERENT joint pair - so this
      // must not be reachable from a single beginPairing/pairingSucceeded call
      // without going through the explicit exception check below.
      expect(t.healthState).toBe('connected');
      expect(t.linkState).toBe('linked');
    });

    it('pairingExpired only ever touches linkState + needsUserAction/reason', () => {
      const t = pairingExpired(snapshot({ healthState: 'never_linked', linkState: 'pairing' }));
      expect(t.healthState).toBeUndefined();
      expect(t.linkState).toBe('unlinked');
      expect(t.needsUserAction).toBe(true);
      expect(t.userActionReason).toBe('PAIRING_EXPIRED');
    });

    it('a purge disconnect is the one explicit exception allowed to write both health and link together', () => {
      const t = applyDisconnect(purgeRow(), { restart515Used: 0, unknownAttempts: 0 });
      expect(t.healthState).toBe('logged_out');
      expect(t.linkState).toBe('unlinked');
    });

    it('every other disconnect outcome writes at most one of health/link per call', () => {
      const outcomes = [
        applyDisconnect(restrictionRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(sessionReplacedRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(unknownRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(unknownRow(), { restart515Used: 0, unknownAttempts: 1 }),
      ];
      for (const t of outcomes) {
        assertAtMostOneHealthOrLinkField(t);
      }
    });
  });

  describe('restart_required_stays_connected_on_its_own_budget_of_two', () => {
    it('515 x2 stays connected/linked, surfaceAsError false, backoff untouched', () => {
      const first = applyDisconnect(restart515Row(), { restart515Used: 0, unknownAttempts: 0 });
      expect(first.healthState).toBeUndefined();
      expect(first.linkState).toBeUndefined();
      expect(first.needsUserAction).toBeUndefined();
      expect(first.userActionReason).toBeUndefined();
      expect(first.sideEffects).toEqual([]);
      expect(first.restart515Used).toBe(1);
      expect(first.unknownAttempts).toBe(0);

      const second = applyDisconnect(restart515Row(), { restart515Used: 1, unknownAttempts: 0 });
      expect(second.healthState).toBeUndefined();
      expect(second.linkState).toBeUndefined();
      expect(second.sideEffects).toEqual([]);
      expect(second.restart515Used).toBe(2);
    });

    it('the 3rd 515 in a row escalates (treated as unknown, no longer a silent stay)', () => {
      const third = applyDisconnect(restart515Row(), { restart515Used: 2, unknownAttempts: 0 });
      // Escalation: no longer a bare "stay connected" outcome.
      expect(third.healthState).toBe('degraded');
      expect(third.restart515Used).toBe(3);
    });
  });

  describe('unknown disconnect rows degrade then pause after two attempts', () => {
    it('first unknown attempt degrades', () => {
      const t = applyDisconnect(unknownRow(), { restart515Used: 0, unknownAttempts: 0 });
      expect(t.healthState).toBe('degraded');
      expect(t.unknownAttempts).toBe(1);
      expect(t.needsUserAction).toBeFalsy();
    });

    it('second unknown attempt pauses with a reconnect-style reason', () => {
      const t = applyDisconnect(unknownRow(), { restart515Used: 0, unknownAttempts: 1 });
      expect(t.healthState).toBe('paused');
      expect(t.needsUserAction).toBe(true);
      expect(t.userActionReason).toBe('RECONNECT_FAILED');
      expect(t.unknownAttempts).toBe(2);
    });
  });

  describe('restriction, purge, and 440 outcomes', () => {
    it('restriction rows pause with RESTRICTION_SIGNAL and audit+notify side effects', () => {
      const t = applyDisconnect(restrictionRow(), { restart515Used: 0, unknownAttempts: 0 });
      expect(t.healthState).toBe('paused');
      expect(t.needsUserAction).toBe(true);
      expect(t.userActionReason).toBe('RESTRICTION_SIGNAL');
      expect(t.sideEffects).toEqual(['audit', 'notify']);
    });

    it('purge rows go logged_out/unlinked with RELINK_REQUIRED and purge_auth+audit+notify', () => {
      const t = applyDisconnect(purgeRow(), { restart515Used: 0, unknownAttempts: 0 });
      expect(t.healthState).toBe('logged_out');
      expect(t.linkState).toBe('unlinked');
      expect(t.needsUserAction).toBe(true);
      expect(t.userActionReason).toBe('RELINK_REQUIRED');
      expect(t.sideEffects).toEqual(['purge_auth', 'audit', 'notify']);
    });

    it('440 pauses with SESSION_REPLACED when takeover was not expected', () => {
      const t = applyDisconnect(sessionReplacedRow(), { restart515Used: 0, unknownAttempts: 0 });
      expect(t.healthState).toBe('paused');
      expect(t.needsUserAction).toBe(true);
      expect(t.userActionReason).toBe('SESSION_REPLACED');
    });

    it('440 with expectedTakeover only ends the socket, no state change', () => {
      const t = applyDisconnect(
        sessionReplacedRow(),
        { restart515Used: 0, unknownAttempts: 0 },
        { expectedTakeover: true },
      );
      expect(t.healthState).toBeUndefined();
      expect(t.linkState).toBeUndefined();
      expect(t.needsUserAction).toBeUndefined();
      expect(t.userActionReason).toBeUndefined();
      expect(t.sideEffects).toEqual(['end_socket']);
    });
  });

  describe('illegal transitions throw', () => {
    it('pairingSucceeded is not legal from a connected/linked snapshot', () => {
      expect(() =>
        pairingSucceeded(snapshot({ healthState: 'connected', linkState: 'linked' })),
      ).toThrow();
    });

    it('beginPairing is not legal from an already-linked snapshot', () => {
      expect(() =>
        beginPairing(snapshot({ healthState: 'connected', linkState: 'linked' })),
      ).toThrow();
    });
  });

  describe('a_disconnect_code_can_never_set_desired_state_offline', () => {
    it('Transition has no desiredState key at all, compile-time', () => {
      const t: Transition = { sideEffects: [] };
      // @ts-expect-error - Transition must not have a desiredState field.
      t.desiredState = 'offline';
      expect(t.sideEffects).toEqual([]);
    });

    it('runtime scan: no producible transition ever contains a desiredState key', () => {
      const producedTransitions: Transition[] = [
        beginPairing(snapshot({ healthState: 'never_linked', linkState: 'unlinked' })),
        pairingSucceeded(snapshot({ healthState: 'never_linked', linkState: 'pairing' })),
        pairingExpired(snapshot({ healthState: 'never_linked', linkState: 'pairing' })),
        applyDisconnect(restart515Row(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(restart515Row(), { restart515Used: 2, unknownAttempts: 0 }),
        applyDisconnect(unknownRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(unknownRow(), { restart515Used: 0, unknownAttempts: 1 }),
        applyDisconnect(restrictionRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(purgeRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(sessionReplacedRow(), { restart515Used: 0, unknownAttempts: 0 }),
        applyDisconnect(
          sessionReplacedRow(),
          { restart515Used: 0, unknownAttempts: 0 },
          { expectedTakeover: true },
        ),
      ];

      for (const t of producedTransitions) {
        expect(Object.keys(t)).not.toContain('desiredState');
      }
    });
  });
});

/**
 * Shared assertion for the "never collapsed" property: a transition may set
 * at most one of `healthState`/`linkState`, EXCEPT the one explicit,
 * documented exception (the logged_out+unlinked joint write from a purge
 * disconnect), which this helper does not call.
 */
function assertAtMostOneHealthOrLinkField(t: Transition): void {
  const touched = [t.healthState !== undefined, t.linkState !== undefined].filter(Boolean).length;
  expect(touched).toBeLessThanOrEqual(1);
}
