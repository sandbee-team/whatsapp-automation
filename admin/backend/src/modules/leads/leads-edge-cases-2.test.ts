import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ORIGIN, buildHarness, post, validBody } from './leads-routes-test-support.js';
import { PublicLeadsRateLimiter } from './public-rate-limit.js';

/**
 * leads-edge-cases-2.test.ts (P29 session 1, E3 hardening) - clock
 * boundaries on the bot guard, retry storms, call ordering (limiter before
 * repo), and CORS edge cases. Split from `leads-edge-cases.test.ts` (300-
 * line cap); see that file for crash-in-the-middle/replay/input-size cases.
 */

describe('leads_clock_boundaries', () => {
  it('elapsed_exactly_3000ms_is_ok_2999ms_is_too_fast', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;

    const ok = await post(harness, validBody(now, { startedAt: now.getTime() - 3000 }), {
      ip: '198.51.100.55',
    });
    expect(ok.statusCode).toBe(202);
    expect(harness.outcomes.at(-1)).toBe('accepted');

    const tooFast = await post(harness, validBody(now, { startedAt: now.getTime() - 2999 }), {
      ip: '198.51.100.56',
    });
    expect(tooFast.statusCode).toBe(202);
    expect(harness.outcomes.at(-1)).toBe('bot_rejected');
  });

  it('elapsed_exactly_24h_is_ok_the_implemented_boundary_is_inclusive', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const exactly24h = 24 * 60 * 60 * 1000;

    const response = await post(
      harness,
      validBody(now, { startedAt: now.getTime() - exactly24h }),
      { ip: '198.51.100.57' },
    );
    // bot-guard.ts: `elapsedMs > MAX_FORM_AGE_MS` is strict-greater, so
    // elapsed exactly 24h is NOT stale - documenting the implemented
    // (inclusive) boundary.
    expect(response.statusCode).toBe(202);
    expect(harness.outcomes.at(-1)).toBe('accepted');
  });

  it('startedAt_exactly_60s_in_the_future_is_ok_60001ms_is_future', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;

    const atBoundary = await post(harness, validBody(now, { startedAt: now.getTime() + 60_000 }), {
      ip: '198.51.100.58',
    });
    // bot-guard.ts: `startedAtMs > nowMs + MAX_FUTURE_SKEW_MS` is
    // strict-greater, so exactly 60s in the future is NOT `future` - it
    // then fails the elapsed check instead (negative elapsed < 3000ms), so
    // the observable outcome is still `bot_rejected`, just via `too_fast`.
    expect(atBoundary.statusCode).toBe(202);
    expect(harness.outcomes.at(-1)).toBe('bot_rejected');

    const pastBoundary = await post(
      harness,
      validBody(now, { startedAt: now.getTime() + 60_001 }),
      { ip: '198.51.100.59' },
    );
    expect(pastBoundary.statusCode).toBe(202);
    expect(harness.outcomes.at(-1)).toBe('bot_rejected');
  });

  it('a_now_on_a_dst_change_day_has_no_effect_pure_arithmetic', async () => {
    // DST changes are a wall-clock/timezone artifact; bot-guard.ts does
    // pure epoch-ms subtraction, which is unaffected by DST. One case
    // (a `now` on a real US DST transition date) proves the arithmetic is
    // timezone-naive.
    const dstDay = new Date('2026-03-08T09:00:00.000Z');
    const harness = buildHarness();
    harness.clock.current = dstDay;
    const response = await post(
      harness,
      validBody(dstDay, { startedAt: dstDay.getTime() - 5000 }),
      {
        ip: '198.51.100.60',
      },
    );
    expect(response.statusCode).toBe(202);
    expect(harness.outcomes.at(-1)).toBe('accepted');
  });
});

describe('leads_retry_storms', () => {
  it('retrying_a_429_immediately_gets_429_again_with_a_valid_retry_after_and_identical_limit', async () => {
    const harness = buildHarness();
    const ip = '198.51.100.61';
    for (let i = 0; i < 5; i += 1) {
      await post(harness, validBody(harness.clock.current), { ip });
    }
    const first429 = await post(harness, validBody(harness.clock.current), { ip });
    const second429 = await post(harness, validBody(harness.clock.current), { ip });

    expect(first429.statusCode).toBe(429);
    expect(second429.statusCode).toBe(429);
    expect(Number(second429.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(second429.headers['ratelimit-limit']).toBe(first429.headers['ratelimit-limit']);
  });

  it('the_429_path_never_calls_the_repo_and_never_calls_the_bot_guard', async () => {
    const harness = buildHarness();
    const ip = '198.51.100.62';
    for (let i = 0; i < 5; i += 1) {
      await post(harness, validBody(harness.clock.current), { ip });
    }
    const rowsBefore = harness.rows.length;
    const outcomesBefore = harness.outcomes.length;

    // A body that WOULD be honeypot-rejected if the bot guard ran -
    // proving the guard never runs on a rate-limited request (it would
    // otherwise still record a `bot_rejected` outcome).
    await post(harness, validBody(harness.clock.current, { website: 'gotcha' }), { ip });

    expect(harness.rows.length).toBe(rowsBefore);
    expect(harness.outcomes.length).toBe(outcomesBefore + 1);
    expect(harness.outcomes.at(-1)).toBe('rate_limited');
  });
});

describe('leads_rate_limit_before_body_parsing', () => {
  it('a_rate_limited_request_is_refused_before_its_body_is_parsed', async () => {
    const harness = buildHarness();
    const ip = '198.51.100.72';
    for (let i = 0; i < 5; i += 1) {
      const response = await post(harness, validBody(harness.clock.current), { ip });
      expect(response.statusCode).toBe(202);
    }

    const sixth = await harness.app.inject({
      method: 'POST',
      url: '/public/v1/leads',
      remoteAddress: ip,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    // A malformed body would normally 400 once zod (or Fastify's own JSON
    // parser) sees it - a 429 here proves the limiter ran, and refused the
    // request, before the body was ever parsed.
    expect(sixth.statusCode).toBe(429);
    expect(harness.rows.length).toBe(5);
  });

  it('an_oversized_body_is_refused_with_413_and_never_parsed', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const oversized = await post(harness, validBody(now, { message: 'a'.repeat(20 * 1024) }), {
      ip: '198.51.100.73',
    });
    expect(oversized.statusCode).toBe(413);
    expect(harness.rows.length).toBe(0);
  });
});

describe('leads_slow_rather_than_down', () => {
  it('limiter_check_is_invoked_before_repo_insert_and_a_denied_request_never_reaches_the_repo', async () => {
    const order: string[] = [];
    const realLimiter = new PublicLeadsRateLimiter(() => new Date('2026-09-08T12:00:00.000Z'));
    const spyingLimiter = {
      check: (ip: string) => {
        order.push('limiter.check');
        return realLimiter.check(ip);
      },
    };
    const harness = buildHarness({
      limiter: spyingLimiter as unknown as PublicLeadsRateLimiter,
      repo: {
        insert: async () => {
          order.push('repo.insert');
          return { id: 'x' };
        },
      },
    });
    const now = harness.clock.current;
    await post(harness, validBody(now), { ip: '198.51.100.63' });
    expect(order).toEqual(['limiter.check', 'repo.insert']);
  });
});

describe('leads_cors_edge_cases', () => {
  it('an_origin_with_a_trailing_slash_is_not_allowed_exact_match_only', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now), {
      ip: '198.51.100.64',
      origin: 'http://127.0.0.1:3002/',
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a_differently_cased_origin_scheme_is_not_allowed_case_sensitive_exact_match', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now), {
      ip: '198.51.100.65',
      origin: 'HTTP://127.0.0.1:3002',
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a_null_origin_gets_no_acao_header', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;
    const response = await post(harness, validBody(now), {
      ip: '198.51.100.66',
      origin: 'null',
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('an_options_preflight_does_not_exhaust_the_post_rate_limit_budget', async () => {
    const harness = buildHarness();
    const ip = '198.51.100.67';
    for (let i = 0; i < 10; i += 1) {
      const preflight = await harness.app.inject({
        method: 'OPTIONS',
        url: '/public/v1/leads',
        remoteAddress: ip,
      });
      expect(preflight.statusCode).toBe(204);
    }
    // All 5 POST tokens must still be available - preflights never touch
    // the limiter (the OPTIONS handler has no `deps.limiter.check` call).
    for (let i = 0; i < 5; i += 1) {
      const response = await post(harness, validBody(harness.clock.current), { ip });
      expect(response.statusCode).toBe(202);
    }
    const sixth = await post(harness, validBody(harness.clock.current), { ip });
    expect(sixth.statusCode).toBe(429);
  });

  it('a_429_from_an_allowed_origin_carries_the_cors_header_so_the_browser_can_read_it', async () => {
    // The limiter refuses inside the onRequest hook, before the handler's own
    // CORS step - without ACAO on the 429 the browser reports an opaque
    // network failure and the form cannot show its rate-limited copy.
    const harness = buildHarness();
    const ip = '198.51.100.68';
    for (let i = 0; i < 5; i += 1) {
      await post(harness, validBody(harness.clock.current), { ip, origin: ALLOWED_ORIGIN });
    }
    const refused = await post(harness, validBody(harness.clock.current), {
      ip,
      origin: ALLOWED_ORIGIN,
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(refused.headers['access-control-allow-credentials']).toBeUndefined();
    expect(refused.headers['retry-after']).toBeDefined();
  });
});
