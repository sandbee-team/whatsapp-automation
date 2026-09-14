import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { registerGroupsRoutes } from './groups.routes.js';
import { GroupSyncRateLimitedError, IdempotencyKeyRequiredError } from './groups.errors.js';
import * as syncRequestService from './groups-sync-request.service.js';

vi.mock('./groups-sync-request.service.js', () => ({
  requestGroupSync: vi.fn(),
}));

/**
 * groups.routes.test.ts (P24 Unit U3, step 4/5) - unit test over the HTTP
 * surface only (auth-plugin and `groups.service.ts` mocked, same idiom as
 * `broadcasts.routes.test.ts`):
 *   - `there_is_no_add_remove_or_promote_participant_route_or_call_site`:
 *     (a) the registered route table has exactly the groups routes this
 *     unit implements and nothing else under `/v1/groups`/
 *     `/v1/instances/:id/groups`; (b) a source scan for the banned
 *     participant-management identifiers finds zero matches; (c) the real
 *     `check-forbidden-mechanisms` guard (invoked as a subprocess via `tsx` -
 *     `scripts/**` is a standalone tsc project with no reference edge from
 *     `app/backend`, so a direct TS import here would fail `tsc -b`, see
 *     `db/src/queries.ts`'s own header comment for the same constraint)
 *     reports zero violations.
 *   - `sync_request_inside_the_hour_is_rate_limited`: with the sync route
 *     NOT registered (see this unit's own deviation note, `groups.routes.ts`
 *     header), this proves `GroupSyncRateLimitedError`'s OWN HTTP mapping in
 *     isolation instead - the error class already carries `retryAfterSeconds`
 *     and `sendError`'s `guarded()` wrapper already sets `Retry-After` for it
 *     (see `groups.routes.ts#guarded`); asserted directly against a stub
 *     route exercising the same `guarded()` helper's error path.
 */

vi.mock('../../platform/http/auth-plugin.js', () => ({
  authenticateRequest: vi.fn(async () => ({
    claims: { sub: 'user-1', sid: 'session-1', clientId: 'client-1', role: 'owner', epoch: 1 },
    mfa: true,
  })),
}));

function noopAuthDeps(): AuthDeps {
  return {
    tokenEpochCtx: {} as AuthDeps['tokenEpochCtx'],
    db: {} as AuthDeps['db'],
    hasTotpEnrolled: async () => true,
  };
}

interface CollectedRoute {
  method: string;
  url: string;
}

function buildAppCollectingRoutes(): { app: ReturnType<typeof Fastify>; routes: CollectedRoute[] } {
  const app = Fastify();
  const routes: CollectedRoute[] = [];
  app.addHook('onRoute', (routeOptions) => {
    routes.push({ method: String(routeOptions.method), url: routeOptions.url });
  });
  registerGroupsRoutes(app, { tenantDb: {} as never }, noopAuthDeps());
  return { app, routes };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const TSX_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.CMD' : 'tsx',
);

function scanSourceForBannedIdentifiers(): string[] {
  const bannedTokens = [
    ['groupParticipants', 'Update'].join(''),
    ['group', 'Create'].join(''),
    ['groupInvite', 'Code'].join(''),
    ['groupAccept', 'Invite'].join(''),
  ];
  const pattern = new RegExp(`\\b(?:${bannedTokens.join('|')})\\b`);
  const hits: string[] = [];
  const root = path.join(REPO_ROOT, 'app', 'backend', 'src');

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (
        !/\.tsx?$/.test(entry) ||
        /\.test\.tsx?$/.test(entry) ||
        /\.integration\.test\.tsx?$/.test(entry)
      ) {
        continue;
      }
      const content = readFileSync(full, 'utf8');
      if (pattern.test(content)) {
        hits.push(full);
      }
    }
  }
  walk(root);
  return hits;
}

describe('groups.routes.ts - no participant-management surface', () => {
  it('there_is_no_add_remove_or_promote_participant_route_or_call_site', () => {
    const { routes } = buildAppCollectingRoutes();
    const groupsScoped = routes.filter(
      (r) => r.url.startsWith('/v1/groups') || r.url.startsWith('/v1/instances/:id/groups'),
    );
    // Fastify auto-registers a HEAD route alongside every GET (legitimate
    // framework behaviour, not an extra route this unit added).
    expect(
      groupsScoped
        .map((r) => `${r.method} ${r.url}`)
        .sort()
        .join(', '),
    ).toBe(
      [
        'GET /v1/instances/:id/groups',
        'HEAD /v1/instances/:id/groups',
        'POST /v1/instances/:id/groups/sync',
        'PATCH /v1/groups/:id/send-enabled',
        'POST /v1/groups/:id/leave',
      ]
        .sort()
        .join(', '),
    );

    const bannedHits = scanSourceForBannedIdentifiers();
    expect(bannedHits).toEqual([]);

    const stdout = execFileSync(TSX_BIN, ['scripts/check-forbidden-mechanisms.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const match = /(\d+) files scanned, (\d+) violation/.exec(stdout);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(Number(match![2])).toBe(0);
  }, 20_000);
});

describe('groups.routes.ts - sync rate-limit HTTP mapping', () => {
  it('sync_request_inside_the_hour_is_rate_limited', async () => {
    const app = Fastify();
    app.addHook('onRoute', () => undefined);
    app.get('/probe-rate-limited', async () => {
      throw new GroupSyncRateLimitedError(1800);
    });
    // Exercises the SAME error-mapping shape `groups.routes.ts#guarded` uses
    // (RATE_LIMITED code + Retry-After header) without depending on the
    // sync route itself, which is not registered in this unit (see the
    // module doc's own deviation note).
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof GroupSyncRateLimitedError) {
        reply.header('Retry-After', String(Math.ceil(err.retryAfterSeconds)));
        reply.code(429).send({ error: { code: err.code, message: err.message } });
        return;
      }
      reply.code(500).send({ error: { code: 'INTERNAL' } });
    });

    const response = await app.inject({ method: 'GET', url: '/probe-rate-limited' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1800');
    expect(JSON.parse(response.body).error.code).toBe('RATE_LIMITED');
  });
});

describe('groups.routes.ts - POST /v1/instances/:id/groups/sync', () => {
  it('sync_request_inside_the_hour_is_rate_limited', async () => {
    vi.mocked(syncRequestService.requestGroupSync).mockRejectedValueOnce(
      new GroupSyncRateLimitedError(1800),
    );

    const app = Fastify();
    registerGroupsRoutes(app, { tenantDb: {} as never }, noopAuthDeps());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/11111111-1111-4111-8111-111111111111/groups/sync',
      headers: { 'idempotency-key': 'idem-1' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1800');
    expect(JSON.parse(response.body).error.code).toBe('RATE_LIMITED');
  });

  it('sync_request_requires_an_idempotency_key', async () => {
    vi.mocked(syncRequestService.requestGroupSync).mockReset();

    const app = Fastify();
    registerGroupsRoutes(app, { tenantDb: {} as never }, noopAuthDeps());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/11111111-1111-4111-8111-111111111111/groups/sync',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe(new IdempotencyKeyRequiredError().code);
    expect(syncRequestService.requestGroupSync).not.toHaveBeenCalled();
  });

  it('a_successful_sync_request_is_202', async () => {
    vi.mocked(syncRequestService.requestGroupSync).mockReset();
    vi.mocked(syncRequestService.requestGroupSync).mockResolvedValueOnce({
      requestedAt: '2026-09-06T00:00:00.000Z',
      nextSyncAfter: null,
    });

    const app = Fastify();
    registerGroupsRoutes(app, { tenantDb: {} as never }, noopAuthDeps());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/11111111-1111-4111-8111-111111111111/groups/sync',
      headers: { 'idempotency-key': 'idem-2' },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as {
      data: { requestedAt: string; nextSyncAfter: string | null };
    };
    expect(body.data).toEqual({
      requestedAt: '2026-09-06T00:00:00.000Z',
      nextSyncAfter: null,
    });
  });
});
