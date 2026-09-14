import { describe, expect, it } from 'vitest';
import { currentTenant, runInTenant, TenantContextMissingError } from './context.js';

const baseCtx = {
  clientId: 'client-a',
  actorId: 'actor-a',
  actorType: 'user' as const,
  role: 'owner',
  requestId: 'req-a',
  traceId: 'trace-a',
};

describe('TenantContext / runInTenant / currentTenant', () => {
  it('a_call_without_tenant_context_throws', () => {
    // Core invariant 4: there is no default client id - a missing context
    // must throw, never silently resolve to "all tenants".
    expect(() => currentTenant()).toThrow(TenantContextMissingError);
    try {
      currentTenant();
      throw new Error('expected currentTenant() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TenantContextMissingError);
      expect((err as TenantContextMissingError).code).toBe('TENANT_CONTEXT_MISSING');
    }
  });

  it('runInTenant_makes_the_context_observable_inside_the_callback_only', async () => {
    const observed = await runInTenant(baseCtx, () => currentTenant());
    expect(observed).toEqual(baseCtx);

    // Outside the callback, the context is gone again.
    expect(() => currentTenant()).toThrow(TenantContextMissingError);
  });

  it('two_concurrent_tenant_contexts_do_not_bleed', async () => {
    const ctxA = { ...baseCtx, clientId: 'client-a' };
    const ctxB = { ...baseCtx, clientId: 'client-b' };

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const runA = runInTenant(ctxA, async () => {
      // Yield to the microtask/macrotask queue in the middle of the async
      // work, interleaving with runB below, and confirm the context still
      // resolves to A's clientId afterwards.
      await delay(10);
      return currentTenant().clientId;
    });

    const runB = runInTenant(ctxB, async () => {
      await delay(1);
      return currentTenant().clientId;
    });

    const [resultA, resultB] = await Promise.all([runA, runB]);
    expect(resultA).toBe('client-a');
    expect(resultB).toBe('client-b');
  });

  it('nested_runInTenant_calls_the_inner_context_wins_and_the_outer_is_restored_after', async () => {
    const outerCtx = { ...baseCtx, clientId: 'outer' };
    const innerCtx = { ...baseCtx, clientId: 'inner' };

    const observedInsideInner = await runInTenant(outerCtx, async () => {
      const observedOuterBefore = currentTenant().clientId;

      const observedInner = await runInTenant(innerCtx, () => currentTenant().clientId);

      // After the nested call returns, the outer context is restored.
      const observedOuterAfter = currentTenant().clientId;

      expect(observedOuterBefore).toBe('outer');
      expect(observedOuterAfter).toBe('outer');

      return observedInner;
    });

    expect(observedInsideInner).toBe('inner');
    // And outside everything, there is no context at all.
    expect(() => currentTenant()).toThrow(TenantContextMissingError);
  });

  it('a_promise_chain_started_outside_any_tenant_context_never_observes_a_concurrently_running_ones_context', async () => {
    const ctxA = { ...baseCtx, clientId: 'client-a' };
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Started with NO ambient tenant context - just a bare async function
    // that yields, overlapping in time with runInTenant(ctxA, ...) below.
    const outsideChain = (async () => {
      await delay(5);
      try {
        currentTenant();
        return 'unexpectedly-had-a-context';
      } catch (err) {
        return err instanceof TenantContextMissingError ? 'missing-as-expected' : 'wrong-error';
      }
    })();

    const insideRun = runInTenant(ctxA, async () => {
      await delay(1);
      return currentTenant().clientId;
    });

    const [outsideResult, insideResult] = await Promise.all([outsideChain, insideRun]);
    expect(outsideResult).toBe('missing-as-expected');
    expect(insideResult).toBe('client-a');
  });

  it('mutating_the_original_ctx_object_after_runInTenant_starts_is_NOT_observed_the_stored_context_is_a_frozen_copy', async () => {
    // `runInTenant` stores a frozen shallow copy of `ctx`, never the caller's
    // own object reference - so mutating the original object after passing
    // it in has no effect on what `currentTenant()` sees, and the stored
    // context itself can never be mutated in place.
    const mutableCtx = { ...baseCtx, clientId: 'before-mutation' };

    const observed = await runInTenant(mutableCtx, async () => {
      const before = currentTenant().clientId;
      mutableCtx.clientId = 'after-mutation';
      const after = currentTenant().clientId;
      return { before, after, frozen: Object.isFrozen(currentTenant()) };
    });

    expect(observed.before).toBe('before-mutation');
    expect(observed.after).toBe('before-mutation');
    expect(observed.frozen).toBe(true);
    // The original object passed in by the caller is never frozen itself -
    // only the internally-stored copy is.
    expect(Object.isFrozen(mutableCtx)).toBe(false);
  });
});
