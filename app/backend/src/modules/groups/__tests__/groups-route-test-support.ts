import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import type { TenantDb, TenantQueryable } from '@wp/db';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { assertRoutePolicyConfig } from '../../../platform/http/route-policy.js';
import { registerGroupsRoutes } from '../groups.routes.js';

/**
 * groups-route-test-support.ts (P24 Unit U3, step 4/5) - the real-HTTP
 * harness for `groups-routes.integration.test.ts`: a real Fastify app +
 * `registerGroupsRoutes` + a real signed HS256 JWT (same shape
 * `modules/webhooks/__tests__/webhooks-test-support.ts#signAccessToken`
 * already established) - no mocked auth. NOT itself a test file.
 */

export const JWT_SECRET = 'groups-route-test-secret-at-least-32-chars-long!!';

interface TokenSpec {
  userId: string;
  clientId: string;
  role: string;
  mfa?: boolean;
}

export async function signAccessToken(spec: TokenSpec): Promise<string> {
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sid: randomUUID(),
    clientId: spec.clientId,
    role: spec.role,
    epoch: 0,
    mfa: spec.mfa ?? true,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(spec.userId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(secretKey);
}

/** Stub `TokenEpochCtx.db`/redis - every user has epoch 0, always (no epoch-revocation test here). */
function stubDb(): TenantQueryable {
  return {
    query: (async (_sql: string, params?: unknown[]) => {
      const userId = params?.[0] as string;
      return userId ? { rows: [{ token_epoch: 0 }] } : { rows: [] };
    }) as TenantQueryable['query'],
  } as unknown as TenantQueryable;
}

function stubRedis(): AuthDeps['tokenEpochCtx']['redis'] {
  return { get: async () => null, set: async () => 'OK', del: async () => 1 } as never;
}

export function buildGroupsRoutesHarness(tenantDb: TenantDb): FastifyInstance {
  const app = Fastify();
  app.addHook('onRoute', assertRoutePolicyConfig);

  const authDeps: AuthDeps = {
    tokenEpochCtx: {
      redis: stubRedis(),
      db: stubDb(),
      jwtSecret: JWT_SECRET,
      epochCacheTtlSec: 3600,
      env: 'test',
    },
    db: stubDb(),
    hasTotpEnrolled: async () => true,
  };

  registerGroupsRoutes(app, { tenantDb }, authDeps);
  return app;
}
