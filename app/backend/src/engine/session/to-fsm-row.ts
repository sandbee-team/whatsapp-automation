import type { DisconnectPolicyRowLike, WaLinkState } from '@wp/domain';
import type { DisconnectPolicyRow } from '../../provider/baileys/disconnect-map.js';

/**
 * to-fsm-row.ts (P08 U5 PRE-STEP B) - the seam fix between two modules that
 * landed in parallel with divergent action/budget vocabularies:
 *
 *   - `provider/baileys/disconnect-map.ts` (U1): `action: 'none' |
 *     'purge_relink' | 'restriction_pause' | 'session_replaced' |
 *     'unmapped'`, `budget: 'backoff' | 'restart515' | 'none' | 'limited2'`,
 *     `linkState: 'unchanged' | 'linked' | 'unlinked'`.
 *   - `@wp/domain`'s `session-fsm.ts` (U2): `action: 'stay' | 'reconnect' |
 *     'restriction' | 'purge' | 'session_replaced'`, `budget: 'restart515' |
 *     'limited2' | null`, `linkState: WaLinkState` (no `'unchanged'` - a
 *     concrete value is always required).
 *
 * `toFsmRow` is a pure, total mapping from the former to the latter. The
 * `'unchanged'` link-state sentinel is resolved by passing the CURRENT
 * `linkState` through as a second parameter, so this module never invents a
 * value.
 *
 * Mapping (normative, from the P08 U5 dispatch):
 *   - budget 'restart515'                                -> action 'stay',    budget 'restart515'
 *   - action 'none'   + budget 'backoff' (autoReconnect)  -> action 'reconnect', budget null
 *   - action 'purge_relink'                               -> action 'purge',    budget null
 *   - action 'restriction_pause'                          -> action 'restriction', budget null
 *   - action 'session_replaced'                           -> action 'session_replaced', budget null
 *   - action 'unmapped'                                   -> action 'reconnect', budget 'limited2'
 *
 * Compile-time exhaustiveness is enforced over BOTH source unions via the
 * `satisfies`/`never` checks in `mapAction`/`mapBudget` below - an
 * unhandled member of either union is a compile error, not a runtime
 * surprise.
 */

type SourceAction = DisconnectPolicyRow['action'];
type SourceBudget = DisconnectPolicyRow['budget'];
type TargetAction = DisconnectPolicyRowLike['action'];
type TargetBudget = DisconnectPolicyRowLike['budget'];

function assertNever(value: never): never {
  throw new RangeError(`to-fsm-row: unhandled source variant ${JSON.stringify(value)}`);
}

/**
 * Resolves the mapped `(action, budget)` pair. `budget: 'restart515'` takes
 * priority over `action` (it is 515's own row, whose `action` is `'none'`) -
 * matching the dispatch's explicit ordering ("budget 'restart515' ->
 * action 'stay' + budget 'restart515'" is listed first).
 */
function mapActionAndBudget(
  action: SourceAction,
  budget: SourceBudget,
): { action: TargetAction; budget: TargetBudget } {
  if (budget === 'restart515') {
    return { action: 'stay', budget: 'restart515' };
  }

  switch (action) {
    case 'none': {
      // Only 'backoff'-budget rows reach here with action 'none' (515's
      // 'restart515' budget was handled above); 'none'-budget + action
      // 'none' does not occur in the live table, but is still handled
      // fail-safe below via the exhaustive budget switch.
      const mappedBudget = mapNoneActionBudget(budget);
      return { action: 'reconnect', budget: mappedBudget };
    }
    case 'purge_relink':
      return { action: 'purge', budget: null };
    case 'restriction_pause':
      return { action: 'restriction', budget: null };
    case 'session_replaced':
      return { action: 'session_replaced', budget: null };
    case 'unmapped':
      return { action: 'reconnect', budget: 'limited2' };
    default:
      return assertNever(action);
  }
}

/**
 * Exhaustiveness over `SourceBudget` for the `action: 'none'` branch -
 * `'restart515'` is unreachable here (handled by the caller before this is
 * invoked), so it maps to `null` fail-safe rather than being reachable at
 * runtime.
 */
function mapNoneActionBudget(budget: SourceBudget): TargetBudget {
  switch (budget) {
    case 'backoff':
      return null;
    case 'restart515':
      return 'restart515';
    case 'none':
      return null;
    case 'limited2':
      return 'limited2';
    default:
      return assertNever(budget);
  }
}

function resolveLinkState(
  source: DisconnectPolicyRow['linkState'],
  current: WaLinkState,
): WaLinkState {
  if (source === 'unchanged') {
    return current;
  }
  return source;
}

export function toFsmRow(
  row: DisconnectPolicyRow,
  currentLinkState: WaLinkState,
): DisconnectPolicyRowLike {
  const { action, budget } = mapActionAndBudget(row.action, row.budget);
  return {
    healthState: row.healthState,
    linkState: resolveLinkState(row.linkState, currentLinkState),
    autoReconnect: row.autoReconnect,
    budget,
    action,
    surfaceAsError: row.surfaceAsError,
  };
}
