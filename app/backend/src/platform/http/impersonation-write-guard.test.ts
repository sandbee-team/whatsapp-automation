import { describe, expect, it } from 'vitest';
import { assertImpersonationAllowListRegistered } from './impersonation-write-guard.js';

/**
 * impersonation-write-guard.test.ts (C1 review round 2 MINOR fix) -
 * `assertImpersonationAllowListRegistered` proves at boot that every
 * `ALLOWED_MUTATIONS` entry names a route template Fastify actually
 * registered - a typo'd or renamed route template in the allow-list would
 * otherwise silently stop protecting anything (the guard's own `key` lookup
 * would just never match, which looks identical to "correctly refused" from
 * the outside). Exercised against a minimal Fastify-shaped fake exposing
 * only `hasRoute`, never a real `buildApp()` (that boundary is proved by
 * `server.ts` calling this at the end of its own route registration).
 */

interface FakeApp {
  hasRoute(opts: { method: string; url: string }): boolean;
}

function fakeApp(registered: Set<string>): FakeApp {
  return {
    hasRoute: ({ method, url }) => registered.has(`${method} ${url}`),
  };
}

describe('assertImpersonationAllowListRegistered', () => {
  it('passes_when_every_allow_listed_entry_is_a_registered_route', () => {
    const registered = new Set([
      'POST /v1/auth/logout',
      'POST /v1/auth/impersonation/refresh',
      'POST /v1/notifications/:id/read',
      'POST /v1/notifications/read-all',
    ]);
    expect(() => assertImpersonationAllowListRegistered(fakeApp(registered))).not.toThrow();
  });

  it('throws_when_an_allow_listed_entry_names_a_route_that_was_never_registered', () => {
    const registered = new Set([
      'POST /v1/auth/logout',
      // Missing: 'POST /v1/auth/impersonation/refresh' (e.g. renamed route).
      'POST /v1/notifications/:id/read',
      'POST /v1/notifications/read-all',
    ]);
    expect(() => assertImpersonationAllowListRegistered(fakeApp(registered))).toThrow(
      /impersonation-write-guard.*ALLOWED_MUTATIONS/i,
    );
  });

  it('never_throws_for_an_entry_the_caller_marked_optional', () => {
    // Mirrors `server.ts`'s own call: a partial build (e.g. a test harness
    // that never wires the notifications module) may legitimately skip an
    // entry whose owning module was never mounted.
    const registered = new Set(['POST /v1/auth/logout', 'POST /v1/auth/impersonation/refresh']);
    expect(() =>
      assertImpersonationAllowListRegistered(fakeApp(registered), (entry) =>
        entry.startsWith('POST /v1/notifications/'),
      ),
    ).not.toThrow();
  });
});
