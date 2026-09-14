import '../__test-support__/stub-wp-server-kit-env.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { Redis } from 'ioredis';
import type { TenantQueryable } from '@wp/db';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { assertRoutePolicyConfig } from '../../../platform/http/route-policy.js';
import { registerRealtimeRoutes } from '../routes.js';
import { createRealtimeHub, type DropReason, type RealtimeHub } from '../hub.js';
import type { InstanceOwnershipPort, RealtimeCtx } from '../service.js';
import type { SseClock } from '../../../platform/http/sse.js';

/**
 * sse-route-test-support.ts (P05 Unit U3a) - shared fixture-building helpers
 * for sse-route.test.ts / sse-route-resilience.test.ts. NOT itself a test
 * file (no `.test.ts` suffix). Wires a minimal Fastify instance +
 * `registerRealtimeRoutes` against a REAL HS256 JWT (`jose`'s SignJWT, same
 * claims shape as modules/identity/session-reuse.ts#signAccessToken) and a
 * stub `TokenEpochCtx.db.query`/redis, so `validateAccessToken` runs for
 * real without touching a database.
 */

export const JWT_SECRET = 'sse-route-test-secret-at-least-32-chars-long!!';

interface TokenSpec {
  userId: string;
  sessionId: string;
  clientId: string;
  role: string;
  epoch: number;
  mfa?: boolean;
}

export async function signAccessToken(spec: TokenSpec): Promise<string> {
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sid: spec.sessionId,
    clientId: spec.clientId,
    role: spec.role,
    epoch: spec.epoch,
    ...(spec.mfa ? { mfa: true } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(spec.userId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(secretKey);
}

/** Stub `TokenEpochCtx.db` - the ONLY query `getEpoch` issues is `SELECT token_epoch FROM users WHERE id = $1`. */
function stubDb(epochByUserId: Map<string, number>): TenantQueryable {
  return {
    query: (async (_sql: string, params?: unknown[]) => {
      const userId = params?.[0] as string;
      const epoch = epochByUserId.get(userId);
      return { rows: epoch === undefined ? [] : [{ token_epoch: epoch }] };
    }) as TenantQueryable['query'],
  } as unknown as TenantQueryable;
}

/** Stub redis - `get` always misses (forces the epoch check through the stub db every time), `set`/`del` resolve. */
function stubRedis(): Redis {
  return {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
  } as unknown as Redis;
}

export interface Harness {
  app: FastifyInstance;
  baseUrl: string;
  hub: RealtimeHub;
  ownedInstanceIds: Set<string>;
  readonly refusalCount: number;
  drops: DropReason[];
  connectionCounts: number[];
  epochByUserId: Map<string, number>;
  clock: SseClock;
  advance: (ms: number) => void;
}

export async function buildHarness(
  options: {
    heartbeatMs?: number;
    maxBufferedFrames?: number;
    maxConnectionsPerUser?: number;
    /**
     * Test-only seam (MAJ-3 TOCTOU test): when provided, every
     * `isOwnedBy` call awaits this promise before resolving - lets a test
     * hold N concurrent requests all past the pre-hijack fast-path check
     * and release them together, deterministically forcing the exact race
     * window `hub.connect`'s atomic check must close.
     */
    ownershipGate?: Promise<void>;
    /**
     * Test-only seam (MAJ-3 post-hijack refusal cleanup test): substitutes
     * the real hub entirely, so a test can force `hub.connect` to throw
     * `TooManyConnectionsError` deterministically AFTER the stream has
     * already been hijacked, without needing to race real concurrency.
     */
    hubOverride?: RealtimeHub;
  } = {},
): Promise<Harness> {
  const app = Fastify();
  app.addHook('onRoute', assertRoutePolicyConfig);

  const hub =
    options.hubOverride ??
    createRealtimeHub({
      replayRingSize: 500,
      maxConnectionsPerUser: options.maxConnectionsPerUser ?? 5,
    });
  const ownedInstanceIds = new Set<string>();
  let refusalCount = 0;
  const drops: DropReason[] = [];
  const connectionCounts: number[] = [];

  hub.onDrop((reason) => drops.push(reason));
  hub.onConnectionCountChange((n) => connectionCounts.push(n));

  const instanceOwnership: InstanceOwnershipPort = {
    isOwnedBy: async (_clientId, instanceId) => {
      if (options.ownershipGate) await options.ownershipGate;
      return ownedInstanceIds.has(instanceId);
    },
  };

  const realtimeCtx: RealtimeCtx = {
    hub,
    instanceOwnership,
    maxConnectionsPerUser: options.maxConnectionsPerUser ?? 5,
    onSubscriptionRefused: () => {
      refusalCount += 1;
    },
  };

  const epochByUserId = new Map<string, number>();
  const authDeps: AuthDeps = {
    tokenEpochCtx: {
      redis: stubRedis(),
      db: stubDb(epochByUserId),
      jwtSecret: JWT_SECRET,
      epochCacheTtlSec: 3600,
      env: 'test',
    },
    db: stubDb(epochByUserId),
    hasTotpEnrolled: async () => false,
  };

  // Fake-timer-driven heartbeat clock: tests advance it manually instead of
  // waiting on wall-clock time (test-discipline: no sleeps).
  const timers = new Map<number, () => void>();
  let nextHandle = 1;
  let virtualNowMs = 0;
  const pending: Array<{ handle: number; intervalMs: number; nextFireMs: number; cb: () => void }> =
    [];
  const clock: SseClock = {
    setInterval: (callback, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.push({ handle, intervalMs: ms, nextFireMs: virtualNowMs + ms, cb: callback });
      timers.set(handle, callback);
      return handle;
    },
    clearInterval: (handle) => {
      const h = handle as number;
      timers.delete(h);
      const idx = pending.findIndex((p) => p.handle === h);
      if (idx !== -1) pending.splice(idx, 1);
    },
  };
  const advance = (ms: number): void => {
    virtualNowMs += ms;
    for (const entry of pending) {
      while (entry.nextFireMs <= virtualNowMs && timers.has(entry.handle)) {
        entry.cb();
        entry.nextFireMs += entry.intervalMs;
      }
    }
  };

  registerRealtimeRoutes(
    app,
    {
      realtimeCtx,
      heartbeatMs: options.heartbeatMs ?? 15000,
      maxBufferedFrames: options.maxBufferedFrames ?? 100,
      clock,
    },
    authDeps,
  );

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    app,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    hub,
    ownedInstanceIds,
    get refusalCount() {
      return refusalCount;
    },
    drops,
    connectionCounts,
    epochByUserId,
    clock,
    advance,
  } as unknown as Harness;
}

/** Reads SSE frames off `response.body` until `count` `data:` lines have arrived or `timeoutMs` elapses. */
export async function readFrames(
  response: Response,
  count: number,
  timeoutMs = 2000,
): Promise<Array<{ event: string | null; id: string | null; data: string }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Array<{ event: string | null; id: string | null; data: string }> = [];
  const deadline = Date.now() + timeoutMs;

  while (frames.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: false }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: false }), 50),
      ),
    ]);
    if (done) break;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event: string | null = null;
        let id: string | null = null;
        const dataLines: string[] = [];
        for (const line of rawFrame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice('event: '.length);
          else if (line.startsWith('id: ')) id = line.slice('id: '.length);
          else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
          // comment lines (`: hb`) are intentionally not collected as frames.
        }
        if (dataLines.length > 0 || event) {
          frames.push({ event, id, data: dataLines.join('\n') });
        }
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return frames;
}
