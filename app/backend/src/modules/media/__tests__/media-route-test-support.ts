import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SignJWT } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPool, type TenantDb, type TenantQueryable } from '@wp/db';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { assertRoutePolicyConfig } from '../../../platform/http/route-policy.js';
import { createFsObjectStore } from '../../../platform/storage/object-store-fs.js';
import type { ObjectStore } from '../../../platform/storage/object-store-types.js';
import {
  generateApiKey,
  hashApiKeySecret,
  lookupByKeyPrefix as lookupByKeyPrefixRepo,
} from '../../api-keys/index.js';
import { registerMediaRoutes } from '../media.routes.js';

/**
 * media-route-test-support.ts (P34 U-upload) - the real-HTTP harness for
 * `media.routes.integration.test.ts`: a real Fastify app registering ONLY
 * `registerMediaRoutes` + a real signed HS256 JWT (same shape
 * `modules/groups/__tests__/groups-route-test-support.ts#signAccessToken`
 * already establishes) - no mocked auth, real Postgres via the caller's own
 * `tenantDb`, a real fs `ObjectStore` rooted at a fresh `mkdtemp` dir per
 * harness build. NOT itself a test file.
 */

export const JWT_SECRET = 'media-route-test-secret-at-least-32-chars-long!!';

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

export interface MediaRoutesHarness {
  app: FastifyInstance;
  objectStore: ObjectStore;
}

/** A fixed, test-only pepper (32 zero-ish bytes) - same "not a real secret" idiom as `hash.ts#DUMMY_SECRET_HASH`. */
const TEST_API_KEY_PEPPER = Buffer.alloc(32, 0x07);

export async function buildMediaRoutesHarness(
  tenantDb: TenantDb,
  pool: ReturnType<typeof createPool>,
): Promise<MediaRoutesHarness> {
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
    db: pool,
    hasTotpEnrolled: async () => true,
    verifyApiKeyDeps: {
      pepper: TEST_API_KEY_PEPPER,
      lookupByKeyPrefix: (kp) => lookupByKeyPrefixRepo(pool, kp),
    },
  };

  const rootDir = await mkdtemp(path.join(tmpdir(), 'wp-media-routes-'));
  const objectStore = createFsObjectStore({ rootDir });

  registerMediaRoutes(app, { tenantDb, objectStore }, authDeps);
  return { app, objectStore };
}

/** Generates a real key, hashes it with the SAME pepper the harness's `verifyApiKeyDeps` uses, and inserts one `api_keys` row directly (no `buildApp`/onboarding stack needed). Returns the raw one-time key string. */
export async function seedApiKey(
  pool: ReturnType<typeof createPool>,
  clientId: string,
  createdByUserId: string,
): Promise<string> {
  const generated = generateApiKey();
  const secretHash = hashApiKeySecret(generated.secret, TEST_API_KEY_PEPPER);
  await pool.query(
    `INSERT INTO api_keys (client_id, id, name, key_prefix, secret_hash, last4, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      clientId,
      randomUUID(),
      'media-route-test-key',
      generated.keyPrefix,
      secretHash,
      generated.last4,
      createdByUserId,
    ],
  );
  return generated.key;
}
