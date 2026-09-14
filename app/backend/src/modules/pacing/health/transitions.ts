/**
 * transitions.ts (P16 Unit B, step 6) - the health-state transition table
 * (design §7: CONNECTED -> DEGRADED -> PAUSED -> LOGGED_OUT, recovery only
 * via the provider's legitimate path). This module's whole reason to exist
 * is to make `CRITICAL -> anything` and `paused -> sending` NOT
 * REPRESENTABLE without a real user actor - not by convention or a runtime
 * `if`, but because no exported function can PRODUCE such a transition
 * value without one. `transitions.test.ts`'s
 * `paused_to_sending_is_not_representable_without_a_user_actor` proves this
 * BOTH at compile time (`@ts-expect-error` on a call missing the actor
 * argument, and on a call passing a `system`/`api_key` actor) and at
 * runtime (`exitPaused` throws if handed anything but a `UserActor`).
 *
 * Exported actor types are reused by Unit C/D per this unit's dispatch.
 */

export type HealthState = 'connected' | 'degraded' | 'paused' | 'logged_out';

/** `system` - the engine itself (health evaluator, reconnect logic). `api_key` - a tenant's API-driven action. Only `UserActor` can exit `paused` back toward sending. */
export type SystemActor = { readonly type: 'system' };
export type ApiKeyActor = { readonly type: 'api_key'; readonly apiKeyId: string };

/**
 * A NAMED HUMAN - the only actor kind that may take an instance out of
 * `paused`. Two members, both humans, deliberately under ONE type name:
 *  - `{type:'user', userId}` - the tenant's own human, acting through the
 *    dashboard (`modules/instances/resume.ts`);
 *  - `{type:'staff_user', staffId}` - a named WP staff member acting through
 *    `/internal/v1/instances/:id/resume` (P28 U3b), whose identity is
 *    resolved from a `staff_users` row and RBAC-checked against
 *    `instances.resume` before the route is ever entered.
 *
 * The NAME stays `UserActor` on purpose: `scripts/check-forbidden-mechanisms.
 * ts` clause (b) string-asserts that `human-resume.ts` types its `actor`
 * parameter as exactly `actor: UserActor`, which is the mechanical guarantee
 * that no `SystemActor`/`ApiKeyActor` can reach the one paused-exit writer.
 * Widening the MEMBERS of this union (from one human kind to two) never
 * weakens that guarantee - a system/api_key actor is still not
 * representable here, so "no automatic resume after a restriction signal"
 * (safety-compliance) still holds structurally, for both humans.
 */
export type UserActor =
  | { readonly type: 'user'; readonly userId: string }
  | { readonly type: 'staff_user'; readonly staffId: string };

export type Actor = SystemActor | ApiKeyActor | UserActor;

/**
 * Every EXPRESSIBLE health-state edge in this table's own vocabulary. Note
 * what is deliberately ABSENT: there is no `{ from: 'paused'; to:
 * 'connected' }` edge here at all, and no `'critical'` state exists in this
 * `HealthState` union in the first place (design §7 only names
 * `CONNECTED`/`DEGRADED`/`PAUSED`/`LOGGED_OUT` as health STATES - `critical`
 * is a `bands.ts` health BAND, a distinct vocabulary that feeds the
 * evaluator's own pause decision, not a member of this state machine). The
 * only sanctioned way out of `paused` is `exitPaused` below, which accepts
 * ONLY a `UserActor`.
 */
export interface SystemTransition {
  readonly from: Exclude<HealthState, 'paused'>;
  readonly to: HealthState;
  readonly actor: SystemActor | ApiKeyActor;
}

/**
 * System/api_key-driven transitions: every edge EXCEPT leaving `paused`.
 * `applyDisconnect` (P08, `@wp/domain`) already owns the raw FSM; this
 * function is the health-module-level assertion that no caller can smuggle
 * a `from: 'paused'` edge through this constructor - `SystemTransition`'s
 * own `from` type already excludes it, so passing `'paused'` is a
 * TypeScript error at the call site, not just a runtime guard.
 */
export function systemTransition(
  from: Exclude<HealthState, 'paused'>,
  to: HealthState,
  actor: SystemActor | ApiKeyActor,
): SystemTransition {
  return { from, to, actor };
}

export interface PausedExitTransition {
  readonly from: 'paused';
  readonly to: Exclude<HealthState, 'paused'>;
  readonly actor: UserActor;
}

/**
 * THE only function that can produce a transition OUT of `paused`. Its
 * parameter type accepts only `UserActor` - a `SystemActor`/`ApiKeyActor`
 * argument is a compile-time error at the call site (this is what
 * `transitions.test.ts` asserts with `@ts-expect-error`). The runtime guard
 * below is a second, independent line of defense for any caller that
 * bypasses the type system (e.g. a `.js` caller, or an `as` cast) - it
 * throws rather than silently accepting a non-user actor, matching this
 * repo's fail-safe invariant.
 */
export function exitPaused(
  to: Exclude<HealthState, 'paused'>,
  actor: UserActor,
): PausedExitTransition {
  // Both HUMAN kinds are accepted (`UserActor`'s own doc comment); a
  // `system`/`api_key` actor is rejected here as well as at compile time.
  if (actor.type !== 'user' && actor.type !== 'staff_user') {
    throw new Error(
      `exitPaused: paused -> ${to} requires a UserActor, got actor.type = "${(actor as Actor).type}"`,
    );
  }
  return { from: 'paused', to, actor };
}
