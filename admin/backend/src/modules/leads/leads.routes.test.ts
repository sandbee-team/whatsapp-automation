import '../../platform/__test-support__/stub-wp-server-kit-env.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ISOLATION_NON_TENANT_TABLES, TENANT_TABLE_COVERAGE } from '@wp/db';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAdminRoutePolicy } from '../../platform/http/route-policy.js';
import { registerLeadsRoutes } from './leads.routes.js';
import { hashIp } from './bot-guard.js';
import { PublicLeadsRateLimiter } from './public-rate-limit.js';
import { LEADS_TABLES_TOUCHED } from './leads.repo.js';
import {
  ALLOWED_ORIGIN,
  SECRET,
  buildHarness,
  fakeRepo,
  post,
  validBody,
} from './leads-routes-test-support.js';

/**
 * leads.routes.test.ts (P29 U4b) - the unit half of the public lead
 * endpoint: a bare Fastify app (never the real admin app - there is no
 * staff auth, no tenant context, no `platformRead` on this surface), a FAKE
 * repo, and an injectable clock. Real Postgres behaviour (hashed-ip storage,
 * grant surface) is `leads.repo.integration.test.ts`. Harness helpers live
 * in the sibling `leads-routes-test-support.ts` (300-line cap).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('leads_routes', () => {
  it('a_public_lead_post_is_rate_limited_with_a_real_429_and_headers', async () => {
    const harness = buildHarness();
    const ip = '198.51.100.7';
    for (let i = 0; i < 5; i += 1) {
      const response = await post(harness, validBody(harness.clock.current), { ip });
      expect(response.statusCode).toBe(202);
    }

    const sixth = await post(harness, validBody(harness.clock.current), { ip });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['ratelimit-limit']).toBe('5');
    expect(sixth.headers['ratelimit-remaining']).toBe('0');
    expect(Number(sixth.headers['ratelimit-reset'])).toBeGreaterThanOrEqual(1);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(sixth.json().error.code).toBe('RATE_LIMITED');

    const otherIp = await post(harness, validBody(harness.clock.current), {
      ip: '203.0.113.55',
    });
    expect(otherIp.statusCode).toBe(202);

    expect(harness.rows.length).toBe(6);

    harness.clock.current = new Date(harness.clock.current.getTime() + 60 * 60 * 1000);
    const afterHour = await post(harness, validBody(harness.clock.current), { ip });
    expect(afterHour.statusCode).toBe(202);

    expect(Object.getOwnPropertyNames(PublicLeadsRateLimiter.prototype)).not.toContain('skip');
    expect(Object.getOwnPropertyNames(PublicLeadsRateLimiter.prototype)).not.toContain('bypass');
    const limiterSource = readFileSync(path.join(HERE, 'public-rate-limit.ts'), 'utf8');
    expect(limiterSource).not.toMatch(/skip/i);
    expect(limiterSource).not.toMatch(/bypass/i);
  });

  it('the_honeypot_and_timing_bot_guard_reject_without_writing_a_row', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;

    const honeypot = await post(harness, validBody(now, { website: 'gotcha' }));
    expect(honeypot.statusCode).toBe(202);

    const tooFast = await post(harness, validBody(now, { startedAt: now.getTime() - 500 }), {
      ip: '198.51.100.8',
    });
    expect(tooFast.statusCode).toBe(202);

    const stale = await post(
      harness,
      validBody(now, { startedAt: now.getTime() - 25 * 60 * 60 * 1000 }),
      { ip: '198.51.100.9' },
    );
    expect(stale.statusCode).toBe(202);

    const future = await post(
      harness,
      validBody(now, { startedAt: now.getTime() + 5 * 60 * 1000 }),
      { ip: '198.51.100.10' },
    );
    expect(future.statusCode).toBe(202);

    expect(harness.rows.length).toBe(0);
    expect(harness.outcomes.filter((o) => o === 'bot_rejected').length).toBe(4);
    expect(harness.outcomes.filter((o) => o === 'accepted').length).toBe(0);

    // `requestId` is per-request random - compare the response SHAPE (status
    // + `data`), which is the part a bot (or its operator) could observe to
    // distinguish "caught" from "accepted".
    expect(honeypot.statusCode).toBe(future.statusCode);
    expect(honeypot.json().data).toEqual(future.json().data);
  });

  it('the_lead_endpoint_reads_and_writes_no_tenant_table', () => {
    expect(LEADS_TABLES_TOUCHED).toEqual(['leads']);
    expect(Object.keys(ISOLATION_NON_TENANT_TABLES)).toContain('leads');
    expect(Object.keys(TENANT_TABLE_COVERAGE)).not.toContain('leads');

    const moduleFiles = readdirSync(HERE)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({ name, content: readFileSync(path.join(HERE, name), 'utf8') }));

    const tenantKeys = Object.keys(TENANT_TABLE_COVERAGE);
    for (const file of moduleFiles) {
      for (const key of tenantKeys) {
        const pattern = new RegExp(`\\b${key}\\b`);
        expect(pattern.test(file.content), `${file.name} must not mention ${key}`).toBe(false);
      }
      expect(file.content).not.toContain('platformRead(');
      expect(file.content).not.toContain('SET LOCAL ROLE');
    }
  });

  it('a_lead_row_stores_no_raw_ip_and_no_unbounded_free_text', async () => {
    const harness = buildHarness();
    const ip = '203.0.113.9';
    const now = harness.clock.current;

    const ok = await post(harness, validBody(now), { ip });
    expect(ok.statusCode).toBe(202);
    const stored = harness.rows[0]!;
    expect(stored.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.ipHash).not.toContain(ip);
    expect(stored.ipHash).toBe(hashIp(SECRET, ip));

    const tooLong = await post(harness, validBody(now, { message: 'a'.repeat(2001) }), {
      ip: '198.51.100.20',
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('VALIDATION_ERROR');

    const rowsBeforeOk2000 = harness.rows.length;
    const ok2000 = await post(harness, validBody(now, { message: 'a'.repeat(2000) }), {
      ip: '198.51.100.21',
    });
    expect(ok2000.statusCode).toBe(202);
    expect(harness.rows.length).toBe(rowsBeforeOk2000 + 1);

    const tooManyUtmKeys: Record<string, string> = {};
    for (let i = 0; i < 11; i += 1) {
      tooManyUtmKeys[`utm_k${i}`] = 'v';
    }
    const utmTooBig = await post(harness, validBody(now, { utm: tooManyUtmKeys }), {
      ip: '198.51.100.22',
    });
    expect(utmTooBig.statusCode).toBe(400);

    const extraField = await post(harness, validBody(now, { extra: 'nope' }), {
      ip: '198.51.100.23',
    });
    expect(extraField.statusCode).toBe(400);

    const rawIpField = await post(harness, validBody(now, { ip: '9.9.9.9' }), {
      ip: '198.51.100.24',
    });
    expect(rawIpField.statusCode).toBe(400);
  });

  it('cors_is_limited_to_the_site_origin', async () => {
    const harness = buildHarness();
    const now = harness.clock.current;

    const preflightOk = await harness.app.inject({
      method: 'OPTIONS',
      url: '/public/v1/leads',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(preflightOk.statusCode).toBe(204);
    expect(preflightOk.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(preflightOk.headers['access-control-allow-methods']).toContain('POST');
    expect(preflightOk.headers.vary).toBe('Origin');

    const preflightEvil = await harness.app.inject({
      method: 'OPTIONS',
      url: '/public/v1/leads',
      headers: { origin: 'https://evil.example' },
    });
    expect(preflightEvil.statusCode).toBe(204);
    expect(preflightEvil.headers['access-control-allow-origin']).toBeUndefined();

    const postAllowed = await post(harness, validBody(now), {
      ip: '198.51.100.30',
      origin: ALLOWED_ORIGIN,
    });
    expect(postAllowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);

    // An unknown Origin gets no ACAO header, so the browser refuses to let
    // the calling page read the response - but the row still lands, because
    // the request itself (not the browser's read of the response) is not
    // the attack surface CORS defends against.
    const postUnknown = await post(harness, validBody(now), {
      ip: '198.51.100.31',
      origin: 'https://evil.example',
    });
    expect(postUnknown.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a_route_without_a_policy_still_fails_at_boot', () => {
    const app = Fastify();
    app.addHook('onRoute', assertAdminRoutePolicy);
    const { repo } = fakeRepo();
    registerLeadsRoutes(app, {
      auth: {
        pool: {
          connect: async () => {
            throw new Error('never');
          },
        },
        jwtSecret: 'x'.repeat(32),
        now: () => new Date(),
      },
      repo,
      allowedOrigins: [ALLOWED_ORIGIN],
      ipHashSecret: SECRET,
      now: () => new Date(),
      limiter: new PublicLeadsRateLimiter(() => new Date()),
    });

    expect(() => {
      app.get('/public/v1/x', () => {
        // Deliberately bare - proves fail-closed routing is still active.
      });
    }).toThrow();
  });
});
