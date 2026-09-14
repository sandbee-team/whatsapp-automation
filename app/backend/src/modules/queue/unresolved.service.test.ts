import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { assertUserActor, UnresolvedActorForbiddenError } from './unresolved.service.js';

/**
 * unresolved.service.test.ts (P12 Unit U5) - UNIT-level proof of the actor
 * gate only (no DB): `assertUserActor` (called by both `retryUnresolved`
 * and `discardUnresolved` before any query runs) throws a `FORBIDDEN`-coded
 * error for any actor kind but `'user'`, and for `'user'` with a missing or
 * blank `userId`. The DB-backed behaviour (retry/discard semantics, replay,
 * audit row) is proved by `unresolved-api.integration.test.ts` against real
 * Postgres - this file exists so the actor gate itself has a fast,
 * deterministic, no-DB proof that cannot be masked by a real database being
 * unavailable.
 */

describe('unresolved.service actor gate (unit, no DB)', () => {
  it('unresolved_actor_forbidden_error_carries_the_forbidden_code', () => {
    const err = new UnresolvedActorForbiddenError('api_key');
    expect(err.code).toBe('FORBIDDEN');
  });

  it('assert_user_actor_rejects_api_key_and_system_kinds', () => {
    expect(() => assertUserActor({ kind: 'api_key' })).toThrow(UnresolvedActorForbiddenError);
    expect(() => assertUserActor({ kind: 'system' })).toThrow(UnresolvedActorForbiddenError);
  });

  it('assert_user_actor_rejects_a_user_actor_with_a_missing_or_blank_userId', () => {
    expect(() => assertUserActor({ kind: 'user' })).toThrow(UnresolvedActorForbiddenError);
    expect(() => assertUserActor({ kind: 'user', userId: '   ' })).toThrow(
      UnresolvedActorForbiddenError,
    );
  });

  it('assert_user_actor_accepts_a_user_actor_with_a_real_userId', () => {
    expect(() => assertUserActor({ kind: 'user', userId: 'a-real-user-id' })).not.toThrow();
  });
});
