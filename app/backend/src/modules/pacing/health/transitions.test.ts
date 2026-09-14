import { describe, expect, it } from 'vitest';
import { exitPaused, systemTransition, type Actor } from './transitions.js';

/**
 * transitions.test.ts (P16 Unit B, step 6) - proves `paused -> sending` is
 * NOT representable without a real `UserActor`, both at compile time
 * (`@ts-expect-error`) and at runtime (a guard-triggered throw for any
 * caller that bypasses the type system).
 */
describe('transitions', () => {
  it('paused_to_sending_is_not_representable_without_a_user_actor', () => {
    // Runtime guard: even if a caller bypasses the type system (`as Actor`),
    // exitPaused refuses anything but a genuine UserActor.
    const systemActor: Actor = { type: 'system' };
    expect(() => exitPaused('connected', systemActor as never)).toThrow(/requires a UserActor/);

    const apiKeyActor: Actor = { type: 'api_key', apiKeyId: 'key-1' };
    expect(() => exitPaused('connected', apiKeyActor as never)).toThrow(/requires a UserActor/);

    // The legitimate path: a real UserActor succeeds.
    const result = exitPaused('connected', { type: 'user', userId: 'user-1' });
    expect(result).toEqual({
      from: 'paused',
      to: 'connected',
      actor: { type: 'user', userId: 'user-1' },
    });

    // Compile-time: systemTransition's own `from` type excludes 'paused'
    // entirely - passing it is a TypeScript error, not just a runtime guard.
    // (systemTransition has no runtime actor-shape guard of its own since
    // its type already excludes 'paused' from `from` - this call is type-
    // rejected only, so it is never actually invoked here.)
    function callSystemTransitionWithPaused(): void {
      // @ts-expect-error - 'paused' is not assignable to SystemTransition's `from`.
      systemTransition('paused', 'connected', { type: 'system' });
    }
    expect(callSystemTransitionWithPaused).toBeTypeOf('function');

    // Compile-time: exitPaused's `actor` parameter only accepts UserActor -
    // a SystemActor argument is a TypeScript error at the call site. Also
    // throws at runtime (same guard proven above), so this is wrapped.
    expect(() => {
      // @ts-expect-error - SystemActor is not assignable to UserActor.
      exitPaused('connected', { type: 'system' });
    }).toThrow(/requires a UserActor/);
  });
});
