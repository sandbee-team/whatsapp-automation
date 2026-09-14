import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendError } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { openSseStream, type SseClock } from '../../platform/http/sse.js';
import {
  assertUnderConnectionCap,
  subscribeConnection,
  TooManyConnectionsError,
  type RealtimeCtx,
} from './service.js';

/**
 * modules/realtime/routes.ts (P05 Unit U3a) - `GET /v1/events`, `policy:
 * 'session'`, `scope: 'realtime:subscribe'`, exactly like any other
 * authenticated route (ADR 0010 - the browser opens this with `fetch()` +
 * a real Authorization header, so this is never a public/cookie/ticket
 * route). Query parsing: `instanceId` (string or string[] of uuids, max 20)
 * - anything else is ignored, INCLUDING a `clientId` query parameter (never
 * even read - `req.auth.clientId` is the only source of truth,
 * service.ts's doc comment explains why).
 */

const instanceIdsQuerySchema = z
  .object({
    instanceId: z.union([z.uuid(), z.array(z.uuid())]).optional(),
  })
  .loose();

function parseRequestedInstanceIds(query: unknown): string[] {
  const parsed = instanceIdsQuerySchema.safeParse(query);
  if (!parsed.success || parsed.data.instanceId === undefined) {
    return [];
  }
  const raw = parsed.data.instanceId;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.slice(0, 20);
}

export interface RealtimeRoutesDeps {
  realtimeCtx: RealtimeCtx;
  heartbeatMs: number;
  maxBufferedFrames: number;
  clock?: SseClock;
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  deps: RealtimeRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/events',
    policy: 'session',
    scope: 'realtime:subscribe',
    handler: async (req: FastifyRequest, reply) => {
      const requestId = requestIdFor(req);
      const auth = req.auth!;

      const requestedInstanceIds = parseRequestedInstanceIds(req.query);
      const lastEventIdHeader = req.headers['last-event-id'];
      const lastEventId = typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined;

      const connectionId = randomUUID();

      // The connection-cap check runs BEFORE the stream is hijacked, so a
      // refused 6th connection gets a normal JSON 429 response rather than
      // a half-open event-stream that then has to be torn down.
      try {
        assertUnderConnectionCap(deps.realtimeCtx, auth);
      } catch (err) {
        sendError(reply, requestId, err);
        return;
      }

      const sink = openSseStream(req, reply, {
        heartbeatMs: deps.heartbeatMs,
        maxBufferedFrames: deps.maxBufferedFrames,
        clock: deps.clock,
      });

      let result;
      try {
        result = await subscribeConnection(
          deps.realtimeCtx,
          { auth, requestedInstanceIds, lastEventId },
          sink,
          connectionId,
        );
      } catch (err) {
        // The pre-hijack `assertUnderConnectionCap` check above is only a
        // fast-path optimisation - `hub.connect` (inside `subscribeConnection`)
        // is the atomic authority (MAJ-3) and can still refuse here even
        // though headers were already flushed by `openSseStream`. The stream
        // is already hijacked at this point, so a refusal can no longer
        // become a plain JSON 429 - instead, close the just-opened stream
        // cleanly with the same drop reason a post-connect cap violation
        // would use, rather than leaving the client waiting on a stream that
        // will never receive a frame or an end.
        if (err instanceof TooManyConnectionsError) {
          sink.close('connection_cap');
          return;
        }
        throw err;
      }

      if (lastEventId !== undefined) {
        for (const channel of result.channels) {
          const replay = deps.realtimeCtx.hub.replaySince(channel, lastEventId);
          if (replay.kind === 'resync') {
            sink.write({ id: '0', event: 'resync', data: '{}' });
            continue;
          }
          for (const frame of replay.frames) {
            sink.write(frame);
          }
        }
      }
    },
  });
}
