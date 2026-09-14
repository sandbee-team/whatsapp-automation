import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { callInternal, InternalCallError, type InternalFetch } from './internal-client.js';

/**
 * internal-client-c2.test.ts (P28 C2 hardening) - the ONE case
 * `internal-client.test.ts` does not cover: a fetch that never settles on
 * its own. `deps.timeoutMs` is overridden to 20ms (a real but tiny timer,
 * never a sleep in the assertion path and never a margin the test asserts
 * proximity to) so the abort path fires deterministically fast; the stub
 * fetch never resolves by itself and only rejects when its `AbortSignal`
 * fires, exactly mirroring `AbortController`'s real contract.
 */

const SECRET = 'test-only-internal-service-token-secret-32chars';
const BASE_URL = 'http://127.0.0.1:3000';
const outputSchema = z.object({ ok: z.boolean() }).strict();
const STAFF_ID = '8f1c0000-0000-4000-8000-000000000001';
const CONCRETE_PATH = '/internal/v1/clients/8f1c0000-0000-4000-8000-0000000000aa/suspend';

interface RecordedCall {
  url: string;
}

/** A fetch that NEVER resolves on its own - only rejects when `init.signal` aborts, same contract `fetch` itself has for a caller-supplied `AbortSignal`. */
function stubHangingFetch(calls: RecordedCall[]): InternalFetch {
  return (url, init) =>
    new Promise((_resolve, reject) => {
      calls.push({ url: String(url) });
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
      // Deliberately no resolve/timeout of its own: this Promise settles
      // ONLY via the abort listener above, so the test proves the CLIENT's
      // own timeout is what ends the call, not some other race.
    });
}

function depsForHanging(fetch: InternalFetch, timeoutMs: number) {
  return {
    baseUrl: BASE_URL,
    serviceTokenSecret: SECRET,
    fetch,
    now: () => new Date(1_760_000_000_000),
    timeoutMs,
    // Zero-delay injected backoff - this test's own 10s budget is for the
    // real abort timers only, never for retry backoff on top of them.
    sleep: async () => undefined,
    random: () => 0,
  };
}

describe('callInternal: dependency slow-not-down (P28 C2)', () => {
  it('a_fetch_that_never_resolves_is_aborted_by_the_configured_timeout_and_surfaces_a_5xx_class_error', async () => {
    const calls: RecordedCall[] = [];
    const fetch = stubHangingFetch(calls);

    const err = await callInternal(depsForHanging(fetch, 20), {
      method: 'POST',
      path: CONCRETE_PATH,
      actor: { staffId: STAFF_ID },
      idempotencyKey: 'idem-key-hang',
      body: { reason: 'timeout probe' },
      outputSchema,
    }).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(InternalCallError);
    const callError = err as InternalCallError;
    // A network/timeout-class failure is mapped to a 5xx-class status (502),
    // never surfaced as if app-backend had made a considered decision.
    expect(callError.status).toBeGreaterThanOrEqual(500);
    expect(callError.code).toBe('INTERNAL');

    // The timeout is retried exactly like any other network failure: 1
    // initial attempt + 2 retries (the module default), each hitting the
    // SAME hanging stub, each aborted by its own 20ms timer.
    expect(calls).toHaveLength(3);
  }, 10_000);
});
