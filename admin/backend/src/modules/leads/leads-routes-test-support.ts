import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { assertAdminRoutePolicy } from '../../platform/http/route-policy.js';
import { registerLeadsRoutes, type LeadsRoutesDeps } from './leads.routes.js';
import { PublicLeadsRateLimiter } from './public-rate-limit.js';
import type { LeadRow, LeadsRepo } from './leads.repo.js';

/**
 * leads-routes-test-support.ts (P29 U4b) - harness helpers shared by
 * `leads.routes.test.ts`, split out to stay under the 300-line cap (see
 * `session-worker-discovery-wiring.ts` for the same split idiom). Test-only:
 * never imported by shipped runtime code.
 */

export const SECRET = 'test-leads-ip-hash-secret-not-a-real-secret-32+';
export const ALLOWED_ORIGIN = 'http://127.0.0.1:3002';

export function fakeRepo(): { repo: LeadsRepo; rows: LeadRow[] } {
  const rows: LeadRow[] = [];
  return {
    rows,
    repo: {
      insert: async (row) => {
        rows.push(row);
        return { id: randomUUID() };
      },
    },
  };
}

export interface Harness {
  app: ReturnType<typeof Fastify>;
  rows: LeadRow[];
  outcomes: Array<'accepted' | 'bot_rejected' | 'rate_limited' | 'invalid'>;
  clock: { current: Date };
}

export function buildHarness(overrides?: Partial<LeadsRoutesDeps>): Harness {
  const app = Fastify();
  app.addHook('onRoute', assertAdminRoutePolicy);
  const { repo, rows } = fakeRepo();
  const clock = { current: new Date('2026-09-08T12:00:00.000Z') };
  const outcomes: Harness['outcomes'] = [];
  const deps: LeadsRoutesDeps = {
    auth: {
      pool: {
        connect: async () => {
          throw new Error('never');
        },
      },
      jwtSecret: 'x'.repeat(32),
      now: () => clock.current,
    },
    repo,
    allowedOrigins: [ALLOWED_ORIGIN],
    ipHashSecret: SECRET,
    now: () => clock.current,
    limiter: new PublicLeadsRateLimiter(() => clock.current),
    onOutcome: (o) => outcomes.push(o),
    ...overrides,
  };
  registerLeadsRoutes(app, deps);
  return { app, rows, outcomes, clock };
}

export function validBody(
  clockNow: Date,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: 'Ada Lovelace',
    email: 'ADA@example.com',
    message: 'We would like to learn more.',
    source: 'contact',
    website: '',
    startedAt: clockNow.getTime() - 10_000,
    ...extra,
  };
}

export function post(
  harness: Harness,
  body: Record<string, unknown>,
  opts?: { ip?: string; origin?: string },
) {
  return harness.app.inject({
    method: 'POST',
    url: '/public/v1/leads',
    payload: body,
    remoteAddress: opts?.ip ?? '198.51.100.7',
    headers: opts?.origin ? { origin: opts.origin } : undefined,
  });
}
