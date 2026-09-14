import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifyServiceToken } from '@wp/server-kit/auth';
import { callInternal, InternalCallError, type InternalFetch } from './internal-client.js';

/**
 * internal-client.test.ts (P28 Unit U4, step 6) - the outbound `/internal/v1`
 * client's contract with app-backend's own gate
 * (`app/backend/src/modules/internal/internal-access.ts`). Every assertion
 * here mirrors something that gate CHECKS, so a drift on either side goes
 * red rather than shipping a silently-rejected admin action.
 *
 * The HMAC is verified with the REAL `verifyServiceToken`, against the
 * CONCRETE path (query string stripped) - not the route template. That
 * distinction is a security boundary, not a detail: a token signed over
 * `/internal/v1/clients/:id/suspend` would be valid for EVERY client, so one
 * captured header would suspend any workspace.
 */

const SECRET = 'test-only-internal-service-token-secret-32chars';
const BASE_URL = 'http://127.0.0.1:3000';
const outputSchema = z.object({ ok: z.boolean() }).strict();

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(responses: Array<Response | Error>): {
  fetch: InternalFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetch: InternalFetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: String(init?.body ?? ''),
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('stubFetch: no response configured');
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { fetch, calls };
}

function depsFor(fetch: InternalFetch, now = 1_760_000_000_000) {
  return {
    baseUrl: BASE_URL,
    serviceTokenSecret: SECRET,
    fetch,
    now: () => new Date(now),
    // Zero-delay injected sleep, fixed random - every OTHER test in this
    // file asserts retry COUNT/behaviour, never timing, so the backoff
    // itself must never add real wall-clock delay here (test-discipline: no
    // sleeps in tests).
    sleep: async () => undefined,
    random: () => 0,
  };
}

const STAFF_ID = '8f1c0000-0000-4000-8000-000000000001';
const CONCRETE_PATH = `/internal/v1/clients/8f1c0000-0000-4000-8000-0000000000aa/suspend`;

describe('callInternal', () => {
  it('signs the concrete path and sends the staff actor and idempotency key', async () => {
    const { fetch, calls } = stubFetch([jsonResponse(200, { data: { ok: true } })]);
    const deps = depsFor(fetch);

    const result = await callInternal(deps, {
      method: 'POST',
      path: CONCRETE_PATH,
      actor: { staffId: STAFF_ID },
      idempotencyKey: 'idem-key-0001',
      body: { reason: 'fraud investigation ticket 4711' },
      outputSchema,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE_URL}${CONCRETE_PATH}`);
    expect(call.headers['X-Actor']).toBe(`staff:${STAFF_ID}`);
    expect(call.headers['Idempotency-Key']).toBe('idem-key-0001');
    expect(call.headers['Content-Type']).toBe('application/json');
    // The staff reason travels in the BODY, never a header (P28 U3a contract).
    expect(JSON.parse(call.body)).toEqual({ reason: 'fraud investigation ticket 4711' });

    // The real verifier accepts it for the concrete path...
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'POST',
        path: CONCRETE_PATH,
        header: call.headers['X-WP-Internal-Token'],
        now: new Date(1_760_000_000_000),
      }),
    ).toBe(true);
    // ...and REJECTS it for the route template and for another client's path.
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'POST',
        path: '/internal/v1/clients/:id/suspend',
        header: call.headers['X-WP-Internal-Token'],
        now: new Date(1_760_000_000_000),
      }),
    ).toBe(false);
    expect(
      verifyServiceToken({
        secret: SECRET,
        method: 'POST',
        path: '/internal/v1/clients/8f1c0000-0000-4000-8000-0000000000bb/suspend',
        header: call.headers['X-WP-Internal-Token'],
        now: new Date(1_760_000_000_000),
      }),
    ).toBe(false);
  });

  it('retries a 503 twice with the SAME idempotency key, then surfaces it', async () => {
    const { fetch, calls } = stubFetch([
      jsonResponse(503, { error: { code: 'INTERNAL', message: 'nope' } }),
    ]);

    await expect(
      callInternal(depsFor(fetch), {
        method: 'POST',
        path: CONCRETE_PATH,
        actor: { staffId: STAFF_ID },
        idempotencyKey: 'idem-key-retry',
        body: { reason: 'retry probe' },
        outputSchema,
      }),
    ).rejects.toBeInstanceOf(InternalCallError);

    // 1 initial attempt + exactly 2 retries.
    expect(calls).toHaveLength(3);
    // The SAME key on every attempt - that is what makes the retry safe: the
    // internal API replays the first result instead of applying the action
    // twice (core invariant 3, idempotency at the storage layer).
    expect(new Set(calls.map((call) => call.headers['Idempotency-Key']))).toEqual(
      new Set(['idem-key-retry']),
    );
  });

  it('never retries a 4xx and maps the internal error envelope through unchanged', async () => {
    const { fetch, calls } = stubFetch([
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'not allowed' } }),
    ]);

    const err = await callInternal(depsFor(fetch), {
      method: 'POST',
      path: CONCRETE_PATH,
      actor: { staffId: STAFF_ID },
      idempotencyKey: 'idem-key-4xx',
      body: { reason: 'rbac probe' },
      outputSchema,
    }).catch((caught: unknown) => caught);

    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(InternalCallError);
    expect((err as InternalCallError).code).toBe('FORBIDDEN');
    expect((err as InternalCallError).status).toBe(403);
  });

  it('retries a network error twice, then succeeds on a later attempt', async () => {
    const calls: RecordedCall[] = [];
    let attempt = 0;
    const fetch: InternalFetch = async (url, init) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? 'GET'),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: String(init?.body ?? ''),
      });
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { data: { ok: true } });
    };

    const result = await callInternal(depsFor(fetch), {
      method: 'POST',
      path: CONCRETE_PATH,
      actor: { staffId: STAFF_ID },
      idempotencyKey: 'idem-key-net',
      body: { reason: 'network probe' },
      outputSchema,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['Idempotency-Key']).toBe('idem-key-net');
  });

  it('sleeps with backoff plus jitter (200ms * 2^attempt + random(0..100ms)) before each retry, never before the first attempt', async () => {
    const { fetch } = stubFetch([
      jsonResponse(503, { error: { code: 'INTERNAL', message: 'nope' } }),
    ]);
    const sleepCalls: number[] = [];

    await expect(
      callInternal(
        {
          baseUrl: BASE_URL,
          serviceTokenSecret: SECRET,
          fetch,
          now: () => new Date(1_760_000_000_000),
          sleep: async (ms: number) => {
            sleepCalls.push(ms);
          },
          random: () => 0.5,
        },
        {
          method: 'POST',
          path: CONCRETE_PATH,
          actor: { staffId: STAFF_ID },
          idempotencyKey: 'idem-key-backoff',
          body: { reason: 'backoff formula probe' },
          outputSchema,
        },
      ),
    ).rejects.toBeInstanceOf(InternalCallError);

    // 1 initial attempt + 2 retries -> sleep called exactly BEFORE each of
    // the 2 retries, never before the first attempt: `200*2^0 + 0.5*100 = 250`,
    // `200*2^1 + 0.5*100 = 450`. Exact values, never a bound (core rule).
    expect(sleepCalls).toEqual([250, 450]);
  });
});
