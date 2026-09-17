import type { QueryClient } from '@tanstack/react-query';
import { ensureSession as sharedEnsureSession } from './api-client.js';
import {
  notifyState,
  runConnectionLoop,
  type SharedConnection,
} from './sse-connection.js';
import type { RealtimeConnectionState } from './sse-types.js';

/**
 * lib/sse-instance-stream.ts (fix, 2026-09-16 - "QR never reaches the
 * browser" first-live-deployment incident) - opens a SECOND, additional SSE
 * connection scoped to one `instanceId`, for exactly as long as something
 * needs it (the Connect sheet's challenge panel).
 *
 * Root cause this fixes: `session-worker.ts` publishes `instance.qr` (a
 * REQUIRED-`instanceId` event, `packages/contracts/src/app/realtime.ts`)
 * correctly onto the Redis bridge, and the api process's bridge subscriber
 * receives every frame with zero drop warnings and calls `hub.publish(...)`.
 * But `hub.ts`'s `publish` routes any event carrying an `instanceId` to
 * `client:{clientId}:instance:{instanceId}` ONLY (hub.ts:218-221), and the
 * browser's one always-on stream (`sse.ts`) has only ever opened
 * `/v1/events` with NO query string, so it is subscribed to `client:{clientId}`
 * alone (`AcquireRealtimeOptions` had no `instanceId` field, and
 * `app-shell.tsx`'s sole call site is mounted once, instance-agnostic).
 * `hub.ts:227-228` (`if (!subscribers) return;`) then drops the frame
 * SILENTLY - no warning, no metric - which is exactly why this reached
 * production undetected (see `bindRealtimeMetrics`'s new
 * `wp_sse_publish_no_subscribers_total` counter, wired in `hub.ts`, for the
 * fix to that blind spot).
 *
 * Why a SECOND connection rather than reconnecting `sse.ts`'s singleton with
 * an added `?instanceId=` query string: that singleton is shared, ref-counted
 * app-shell-wide infrastructure serving the dashboard, sidebar, notifications
 * etc. for the ENTIRE session lifetime. The Connect sheet's need for an
 * instance channel is short-lived and scoped to one instance at a time -
 * forcing every sheet open/close to tear down and re-establish the ONE
 * client-wide stream would (a) drop and resume frames for every OTHER
 * consumer of that stream during the gap, defeating "must not tear down the
 * shared stream for other consumers", and (b) require plumbing the
 * currently-open instanceId through app-shell state that has no other reason
 * to know about it. The backend already supports both multiple `instanceId`
 * query values on one connection AND multiple concurrent connections per
 * user (`SSE_MAX_CONNECTIONS_PER_USER`, default 5, routes.ts/service.ts) -
 * a short-lived second connection for the sheet's lifetime is well inside
 * that budget and isolates the sheet's lifecycle from the app shell's.
 *
 * Same ref-counted-singleton shape as `sse.ts`, generalized to a `Map` keyed
 * by `instanceId` so two different instance streams (unlikely - only one
 * Connect sheet is ever open - but not impossible with fast navigation)
 * never collide, while two mounts requesting the SAME instanceId (StrictMode
 * double-mount of the sheet) still share one physical connection, exactly
 * like `sse.ts`'s app-wide case.
 */

export interface AcquireInstanceRealtimeOptions {
  instanceId: string;
  queryClient: QueryClient;
  random?: () => number;
  ensureSession?: () => Promise<boolean>;
  onStateChange?: (state: RealtimeConnectionState) => void;
  onReconnectScheduled?: (delayMs: number) => void;
}

export interface RealtimeConnectionHandle {
  release: () => void;
}

const sharedByInstance = new Map<string, SharedConnection>();

/**
 * Acquires (creating if necessary) the shared instance-scoped realtime
 * connection for `instanceId`. Mirrors `sse.ts`'s `acquireRealtimeConnection`
 * exactly (same loop, same identity-guard machinery from
 * `sse-connection.ts`), keyed additionally by `instanceId` so it is a
 * genuinely separate connection from the client-wide singleton and from any
 * other instance's stream.
 */
export function acquireInstanceRealtimeConnection(
  options: AcquireInstanceRealtimeOptions,
): RealtimeConnectionHandle {
  const { instanceId } = options;
  const random = options.random ?? Math.random;
  const ensureSession = options.ensureSession ?? sharedEnsureSession;
  const onStateChange = options.onStateChange ?? (() => undefined);
  const onReconnectScheduled = options.onReconnectScheduled ?? (() => undefined);

  let entry = sharedByInstance.get(instanceId);
  if (!entry) {
    entry = {
      path: `/v1/events?instanceId=${encodeURIComponent(instanceId)}`,
      refCount: 0,
      abortController: new AbortController(),
      lastEventId: undefined,
      stateListeners: new Set(),
    };
    sharedByInstance.set(instanceId, entry);
    const mine = entry;
    void runConnectionLoop(
      {
        queryClient: options.queryClient,
        random,
        ensureSession,
        onReconnectScheduled,
        getShared: () => sharedByInstance.get(instanceId) ?? null,
        onStateChange: (state) => notifyState(mine, state),
      },
      mine,
    );
  }

  entry.refCount += 1;
  entry.stateListeners.add(onStateChange);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const current = sharedByInstance.get(instanceId);
      if (!current) return;
      current.stateListeners.delete(onStateChange);
      current.refCount -= 1;
      if (current.refCount <= 0) {
        current.abortController.abort();
        sharedByInstance.delete(instanceId);
      }
    },
  };
}

/** Test-only reset - never called from production code. */
export function resetInstanceRealtimeConnectionsForTests(): void {
  for (const entry of sharedByInstance.values()) {
    entry.abortController.abort();
  }
  sharedByInstance.clear();
}
