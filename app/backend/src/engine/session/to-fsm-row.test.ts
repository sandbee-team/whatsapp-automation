import { describe, expect, it } from 'vitest';
import { DisconnectReason } from 'baileys';
import {
  DISCONNECT_MAP,
  UNKNOWN_CODE_POLICY,
  type DisconnectPolicyRow,
} from '../../provider/baileys/disconnect-map.js';
import { toFsmRow } from './to-fsm-row.js';

/**
 * to-fsm-row.test.ts (P08 U5 PRE-STEP B) - proves every row in
 * `DISCONNECT_MAP` plus `UNKNOWN_CODE_POLICY` maps onto a legal
 * `DisconnectPolicyRowLike` (the `@wp/domain` action/budget vocabulary), per
 * the mapping table in the P08 U5 dispatch.
 */

const CURRENT_LINK_STATE = 'linked' as const;

function expectMapping(
  row: DisconnectPolicyRow,
  expected: { action: string; budget: string | null },
): void {
  const mapped = toFsmRow(row, CURRENT_LINK_STATE);
  expect(mapped.action).toBe(expected.action);
  expect(mapped.budget).toBe(expected.budget);
  expect(mapped.healthState).toBe(row.healthState);
  expect(mapped.autoReconnect).toBe(row.autoReconnect);
  expect(mapped.surfaceAsError).toBe(row.surfaceAsError);
}

describe('toFsmRow', () => {
  it('515 restartRequired (action=none, budget=restart515) -> stay/restart515', () => {
    expectMapping(DISCONNECT_MAP[515]!, { action: 'stay', budget: 'restart515' });
  });

  it('428 connectionClosed (action=none, budget=backoff, autoReconnect) -> reconnect/null', () => {
    expectMapping(DISCONNECT_MAP[428]!, { action: 'reconnect', budget: null });
  });

  it('408 connectionLost/timedOut (action=none, budget=backoff) -> reconnect/null', () => {
    expectMapping(DISCONNECT_MAP[408]!, { action: 'reconnect', budget: null });
  });

  it('503 unavailableService (action=none, budget=backoff) -> reconnect/null', () => {
    expectMapping(DISCONNECT_MAP[503]!, { action: 'reconnect', budget: null });
  });

  it('440 connectionReplaced (action=session_replaced) -> session_replaced/null', () => {
    expectMapping(DISCONNECT_MAP[440]!, { action: 'session_replaced', budget: null });
  });

  it('401 loggedOut (action=purge_relink) -> purge/null', () => {
    expectMapping(DISCONNECT_MAP[401]!, { action: 'purge', budget: null });
  });

  it('403 forbidden (action=restriction_pause) -> restriction/null', () => {
    expectMapping(DISCONNECT_MAP[403]!, { action: 'restriction', budget: null });
  });

  it('402 (action=restriction_pause) -> restriction/null', () => {
    expectMapping(DISCONNECT_MAP[402]!, { action: 'restriction', budget: null });
  });

  it('406 (action=restriction_pause) -> restriction/null', () => {
    expectMapping(DISCONNECT_MAP[406]!, { action: 'restriction', budget: null });
  });

  it('411 multideviceMismatch (action=purge_relink) -> purge/null', () => {
    expectMapping(DISCONNECT_MAP[411]!, { action: 'purge', budget: null });
  });

  it('500 badSession (action=purge_relink) -> purge/null', () => {
    expectMapping(DISCONNECT_MAP[500]!, { action: 'purge', budget: null });
  });

  it('UNKNOWN_CODE_POLICY (action=unmapped) -> reconnect/limited2', () => {
    expectMapping(UNKNOWN_CODE_POLICY, { action: 'reconnect', budget: 'limited2' });
  });

  it('every DISCONNECT_MAP row maps without throwing', () => {
    for (const [code, row] of Object.entries(DISCONNECT_MAP)) {
      expect(() => toFsmRow(row, CURRENT_LINK_STATE)).not.toThrow();
      void code;
    }
  });

  it('linkState "unchanged" is resolved via the current link state parameter', () => {
    const mapped = toFsmRow(DISCONNECT_MAP[428]!, 'pairing');
    expect(mapped.linkState).toBe('pairing');
  });

  it('a row with a concrete linkState (not "unchanged") passes it through untouched', () => {
    const mapped = toFsmRow(DISCONNECT_MAP[401]!, 'linked');
    expect(mapped.linkState).toBe('unlinked');
  });

  it('disconnect_map_covers_every_enum_member (re-proved through the mapper)', () => {
    const raw = DisconnectReason as unknown as Record<string, number | string>;
    const codes: number[] = [];
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isNaN(Number(key))) {
        codes.push(value);
      }
    }
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const row = DISCONNECT_MAP[code];
      expect(row).toBeDefined();
      expect(() => toFsmRow(row!, CURRENT_LINK_STATE)).not.toThrow();
    }
  });
});
