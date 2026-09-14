import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import type { TenantQueryable } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { assertRoutePolicyConfig } from '../../../platform/http/route-policy.js';
import type { SafeFetchOptions } from '../../../platform/http/safe-fetch.js';
import { registerWebhooksRoutes } from '../routes.js';

/**
 * webhooks-test-support.ts (P15 U5, step 8) - shared fixtures for
 * routes.integration.test.ts. NOT itself a test file. Real Postgres,
 * a real `FileKeyProvider` (`tenant-secrets`), a real HS256 JWT (same shape
 * `modules/realtime/__tests__/sse-route-test-support.ts` already
 * established) - no mocked auth/crypto, only the outbound `fetchFn` is a
 * test double (never dials a real network).
 */

export const JWT_SECRET = 'webhooks-route-test-secret-at-least-32-chars-long!!';

/**
 * A full 5-purpose ring (`session`/`tenant-secrets`/`user-secrets`/
 * `optout-pepper`/`api-key-pepper`) - the key-ring schema's `active` record
 * requires an exhaustive entry for every `KEK_PURPOSES` member, not merely
 * the purpose this test cares about (same shape `registry.integration.test.ts`'s
 * own `makeOptoutPepperRing` already establishes). `FileKeyProvider`'s
 * `mountedPurposes: ['tenant-secrets']` still drops every other purpose's
 * material before it enters memory - the extra ring entries exist only to
 * satisfy the file-level schema.
 */
export function makeTenantSecretsRing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-webhooks-route-ring-'));
  const path = join(dir, 'key-ring.json');
  const material = Buffer.alloc(32, 0x0c).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      active: {
        session: 'k1',
        'tenant-secrets': 'k2',
        'user-secrets': 'k3',
        'optout-pepper': 'k4',
        'api-key-pepper': 'k5',
      },
      keys: {
        k1: { purpose: 'session', material, created_at: '2026-01-01T00:00:00.000Z' },
        k2: { purpose: 'tenant-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k3: { purpose: 'user-secrets', material, created_at: '2026-01-01T00:00:00.000Z' },
        k4: { purpose: 'optout-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
        k5: { purpose: 'api-key-pepper', material, created_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
    'utf8',
  );
  return path;
}

export function makeKeyProvider(): FileKeyProvider {
  return new FileKeyProvider({
    ringPath: makeTenantSecretsRing(),
    mountedPurposes: ['tenant-secrets'],
  });
}

interface TokenSpec {
  userId: string;
  clientId: string;
  role: string;
}

export async function signAccessToken(spec: TokenSpec): Promise<string> {
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: randomUUID(), clientId: spec.clientId, role: spec.role, epoch: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(spec.userId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(secretKey);
}

/** Stub `TokenEpochCtx.db`/redis - every user has epoch 0, always. */
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

export type FetchStub = (
  url: string,
  options: SafeFetchOptions,
) => ReturnType<typeof import('../../../platform/http/safe-fetch.js').safeFetch>;

export interface RoutesHarness {
  app: FastifyInstance;
}

export function buildRoutesHarness(
  tenantDb: import('@wp/db').TenantDb,
  keyProvider: FileKeyProvider,
  fetchFn: FetchStub,
): RoutesHarness {
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
    hasTotpEnrolled: async () => false,
  };

  registerWebhooksRoutes(app, { tenantDb, keyProvider, fetchFn }, authDeps);
  return { app };
}

/** A `fetchFn` double that always resolves 200 without dialling a network - configuration-time preflight tests only care about SafeFetchError shape. */
export const acceptingFetchStub: FetchStub = async () => ({
  statusCode: 200,
  headers: {},
  body: Buffer.from('{}'),
});
