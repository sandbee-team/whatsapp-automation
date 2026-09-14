import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { FastifyInstance } from 'fastify';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { buildApp } from '../../../platform/http/server.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import { createRateLimiter } from '../../../platform/http/rate-limit.js';
import {
  failClosedInstanceOwnership,
  createRealtimeHub,
  type RealtimeCtx,
} from '../../realtime/index.js';
import { createCountingNoOpRepairedSendSink } from '../../queue/index.js';
import { makeStaffHeaders, seedStaffUser } from './internal-routes-test-support.js';
import type { StaffRole } from '@wp/domain';

/**
 * internal-u3c-app-fixture.ts (P28 Unit U3c) - boot/teardown harness for the
 * impersonation integration suite. Unlike U3b's fixture (`/internal/v1`
 * alone), this one boots the FULL app - identity (`/v1/auth/*`), internal
 * (`/internal/v1/*`), instances (`resume`), webhooks, and broadcasts - since
 * the suite exercises staff-minted tokens against ORDINARY tenant routes
 * (the route-layer write-block/redaction surface), not just `/internal/v1`
 * itself. Real Postgres AND real Redis (epoch cache invalidation on revoke
 * is the whole point of one test case). NOT itself a test file.
 */

export const JWT_SECRET = 'u3c-impersonation-test-jwt-secret-32-chars!!';

function stubKeyProvider(): KeyProvider {
  return {
    getActive: () => {
      throw new Error('stubKeyProvider: not exercised by this fixture');
    },
    get: () => {
      throw new Error('stubKeyProvider: not exercised by this fixture');
    },
  };
}

export interface U3cHarness {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  app: FastifyInstance;
  redis: ReturnType<typeof createRedis>;
  probeClientIds: string[];
  probeStaffIds: string[];
  probeUserIds: string[];
  seedStaff: (role: StaffRole) => Promise<string>;
  /** Seeds one client + owner user + membership - the minimum an impersonation grant needs. */
  seedOwnerTenant: () => Promise<{ clientId: string; ownerUserId: string }>;
  sendInternal: (
    method: 'POST' | 'GET',
    path: string,
    staffId: string,
    body?: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  close: () => Promise<void>;
}

export interface StartU3cHarnessOptions {
  secret: string;
  applicationName: string;
}

export async function startU3cHarness(options: StartU3cHarnessOptions): Promise<U3cHarness> {
  const pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: options.applicationName,
  });
  const tenantDb = createTenantDb(pool);
  const redis = createRedis(resolveRedisUrl());
  const probeClientIds: string[] = [];
  const probeStaffIds: string[] = [];
  const probeUserIds: string[] = [];

  const authDeps: AuthDeps = {
    tokenEpochCtx: {
      redis,
      db: pool,
      jwtSecret: options.secret,
      epochCacheTtlSec: 3600,
      env: 'test',
    },
    db: pool,
    hasTotpEnrolled: async () => false,
  };

  const app = await buildApp({
    identity: {
      pool,
      tenantDb,
      redis,
      rateLimiter: createRateLimiter(redis),
      config: {
        TRUST_PROXY: true,
        NODE_ENV: 'test',
        AUTH_JWT_SECRET: options.secret,
        EPOCH_CACHE_TTL_SEC: 3600,
      } as never,
      mailer: {
        sendVerificationEmail: async () => {},
        sendLockoutEmail: async () => {},
        sendReuseDetectedEmail: async () => {},
        sendPasswordResetEmail: async () => {},
      },
    },
    onboarding: { onboardingCtx: { pool } },
    instances: { entitlementCtx: { pool }, tenantDb },
    messages: { entitlementCtx: { pool }, tenantDb, keyProvider: stubKeyProvider() },
    realtime: {
      realtimeCtx: {
        hub: createRealtimeHub({ replayRingSize: 500 }),
        instanceOwnership: failClosedInstanceOwnership,
        maxConnectionsPerUser: 5,
        onSubscriptionRefused: () => {},
      } satisfies RealtimeCtx,
      heartbeatMs: 15000,
      maxBufferedFrames: 100,
    },
    unresolved: { tenantDb, sink: createCountingNoOpRepairedSendSink() },
    webhooks: {
      tenantDb,
      keyProvider: stubKeyProvider(),
      fetchFn: (() => {
        throw new Error('fetchFn: not exercised by this fixture (write-guard blocks first)');
      }) as never,
    },
    broadcasts: {
      tenantDb,
      publishWake: () => {},
    },
    notifications: { tenantDb },
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: options.secret,
      allowedCidrs: '0.0.0.0/0',
      publishWake: () => {},
    },
    authDeps,
  });

  const staffHeaders = makeStaffHeaders(options.secret);

  return {
    pool,
    tenantDb,
    app,
    redis,
    probeClientIds,
    probeStaffIds,
    probeUserIds,
    seedStaff: async (role) => {
      const id = await seedStaffUser(pool, role);
      probeStaffIds.push(id);
      return id;
    },
    seedOwnerTenant: async () => {
      const clientId = randomUUID();
      const ownerUserId = randomUUID();
      await pool.query(
        'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
        [clientId, 'U3c Probe Client', `u3c-probe-${clientId}`, 'active'],
      );
      await pool.query(
        `INSERT INTO users (id, full_name, email, email_verified_at) VALUES ($1, $2, $3, now())`,
        [ownerUserId, 'U3c Owner', `u3c-owner-${clientId}@wp-test.local`],
      );
      await pool.query('INSERT INTO memberships (client_id, user_id, role) VALUES ($1, $2, $3)', [
        clientId,
        ownerUserId,
        'owner',
      ]);
      probeClientIds.push(clientId);
      probeUserIds.push(ownerUserId);
      return { clientId, ownerUserId };
    },
    sendInternal: (method, path, staffId, body = {}) =>
      app.inject({
        method,
        url: path,
        headers: staffHeaders(method, path, staffId),
        payload: method === 'POST' ? body : undefined,
      }),
    close: async () => {
      await app.close();
      if (probeClientIds.length > 0) {
        // `impersonation_grants.staff_id` FKs to `staff_users` - deleted
        // BEFORE `staff_users` below, or the staff delete 23503s.
        await pool.query('DELETE FROM impersonation_grants WHERE client_id = ANY($1)', [
          probeClientIds,
        ]);
        await pool.query('DELETE FROM webhook_endpoints WHERE client_id = ANY($1)', [
          probeClientIds,
        ]);
        await pool.query('DELETE FROM campaign_counters WHERE client_id = ANY($1)', [
          probeClientIds,
        ]);
        await pool.query('DELETE FROM campaign_recipients WHERE client_id = ANY($1)', [
          probeClientIds,
        ]);
        await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [probeClientIds]);
        await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
          probeClientIds,
        ]);
        await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [
          probeClientIds,
        ]);
        await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
        await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
        await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
        await pool.query('DELETE FROM memberships WHERE client_id = ANY($1)', [probeClientIds]);
        await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
      }
      if (probeStaffIds.length > 0) {
        await pool.query('DELETE FROM staff_audit_log WHERE staff_id = ANY($1)', [probeStaffIds]);
        await pool.query('DELETE FROM staff_users WHERE id = ANY($1)', [probeStaffIds]);
      }
      for (const userId of probeUserIds) {
        await redis.del(sysKey('test', 'epoch', 'u', userId));
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      await redis.quit();
      await pool.end();
    },
  };
}
