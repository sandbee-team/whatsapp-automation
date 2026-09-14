import { describe, expect, it } from 'vitest';
import { connectErrorMessageKey } from '../connect-error-copy.js';

/**
 * connect-error-copy.test.ts (2026-09-08 bug fix) - pins the exact mapping
 * from each 409/403 error code to the message shape `useConnectFlow` uses,
 * so `handleCreateOrLinkError` and `goOnline` can never drift: both call
 * this one function.
 */
describe('connectErrorMessageKey', () => {
  it('registered_limit_reached_maps_to_the_limit_or_no_plan_rich_block', () => {
    const result = connectErrorMessageKey('REGISTERED_LIMIT_REACHED');
    expect(result).toEqual({
      kind: 'limitOrNoPlan',
      titleKey: 'instances.connect.limitOrNoPlan.title',
      bodyKey: 'instances.connect.limitOrNoPlan.body',
      helpKey: 'instances.connect.limitOrNoPlan.help',
    });
  });

  it('invalid_state_maps_to_the_existing_plain_message', () => {
    const result = connectErrorMessageKey('INVALID_STATE');
    expect(result).toEqual({ kind: 'plain', messageKey: 'instances.connect.invalidState' });
  });

  it('an_unknown_code_maps_to_null_so_callers_fall_back_to_the_generic_error', () => {
    expect(connectErrorMessageKey('SOME_OTHER_CODE')).toBeNull();
    expect(connectErrorMessageKey('')).toBeNull();
  });
});
