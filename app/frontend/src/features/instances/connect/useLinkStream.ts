import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HealthStateContract } from '@wp/contracts';
import { subscribeRealtimeEvent } from '../../../lib/sse.js';
import { acquireInstanceRealtimeConnection } from '../../../lib/sse-instance-stream.js';
import { linkStatus } from '../api.js';

/**
 * useLinkStream (P08 U7; instance-channel fix 2026-09-16) - live state for
 * the Connect sheet's challenge panel. Subscribes `instance.qr`
 * (payload/expiresAt/attemptsLeft) and `instance.health_changed`
 * (healthState) for THIS instance only via the typed `subscribeRealtimeEvent`
 * registry. While the sheet is open, this ALSO polls `GET /link-status`
 * every `pollIntervalMs` (default 5000) as a fallback for the case the SSE
 * stream itself is not `'connected'` (a disconnected/reconnecting realtime
 * stream must never leave the panel silently stale) - polling stops the
 * moment the sheet closes or the connection reports `'connected'`.
 *
 * FIX (discovered 2026-09-15/16, first live AWS deployment - the QR never
 * reached the browser): subscribing via `subscribeRealtimeEvent` alone is
 * necessary but not sufficient - `instance.qr`'s `instanceId` is REQUIRED
 * (`packages/contracts/src/app/realtime.ts`), so the hub (`hub.ts:218-221`)
 * always routes it to the per-instance channel `client:{clientId}:instance:
 * {instanceId}`, never the client-wide channel `sse.ts`'s always-on stream
 * subscribes to. The worker published correctly and the api process's Redis
 * bridge subscriber received every frame with zero drop warnings
 * (`hub.publish` ran every time) - the frame was silently discarded at
 * `hub.ts:227-228` because zero connections were ever subscribed to that
 * instance channel. This hook now ALSO acquires a second, additional,
 * instance-scoped connection (`sse-instance-stream.ts`) for exactly the
 * window `instanceId` is non-null, so the hub has a real subscriber to
 * deliver to. See `sse-instance-stream.ts`'s header comment for the full
 * root-cause chain and why this is a second connection rather than adding a
 * query string to the client-wide singleton in `sse.ts`.
 *
 * `now`/`setInterval`/`clearInterval` are all reachable via injected
 * options so tests can drive this with fake timers deterministically -
 * never a bare `Date.now()`/`setInterval` call inline.
 */
export interface LinkStreamState {
  payload: string | null;
  expiresAt: string | null;
  attemptsLeft: number | null;
  healthState: HealthStateContract | null;
  maskedNumber: string | null;
}

const INITIAL_STATE: LinkStreamState = {
  payload: null,
  expiresAt: null,
  attemptsLeft: null,
  healthState: null,
  maskedNumber: null,
};

export interface UseLinkStreamOptions {
  instanceId: string | null;
  /** Whether the Connect sheet is currently open - polling only runs while true. */
  isOpen: boolean;
  /** Realtime connection state - polling is skipped once this is 'connected'. */
  realtimeState: 'connected' | 'disconnected';
  pollIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;

export function useLinkStream(options: UseLinkStreamOptions): LinkStreamState {
  const {
    instanceId,
    isOpen,
    realtimeState,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  const [state, setState] = useState<LinkStreamState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const queryClient = useQueryClient();

  // FIX (2026-09-16): acquires the additional instance-scoped SSE connection
  // for exactly the lifetime `instanceId` is set - see this file's header
  // comment and `sse-instance-stream.ts` for the full root-cause chain.
  // Ref-counted via `acquireInstanceRealtimeConnection`/`release()` exactly
  // like `app-shell.tsx` acquires the client-wide stream, so mounting the
  // Connect sheet before this connection's first frame has arrived is safe
  // (the fetch simply starts here, same as any fresh `sse.ts` acquire), and
  // closing/reopening the sheet (or a StrictMode double-mount) never leaks a
  // connection - `release()` on unmount always runs, and reacquiring the
  // SAME instanceId while an old generation is mid-teardown is handled by
  // `sse-connection.ts`'s `shared === mine` identity guard, identically to
  // the client-wide singleton.
  useEffect(() => {
    if (!instanceId) return undefined;
    const handle = acquireInstanceRealtimeConnection({ instanceId, queryClient });
    return () => {
      handle.release();
    };
  }, [instanceId, queryClient]);

  useEffect(() => {
    if (!instanceId) return undefined;

    const unsubQr = subscribeRealtimeEvent('instance.qr', (event) => {
      if (event.instanceId !== instanceId) return;
      setState((prev) => ({
        ...prev,
        payload: event.payload,
        expiresAt: event.expiresAt,
        attemptsLeft: event.attemptsLeft,
      }));
    });

    const unsubHealth = subscribeRealtimeEvent('instance.health_changed', (event) => {
      if (event.instanceId !== instanceId) return;
      setState((prev) => ({ ...prev, healthState: event.healthState }));
    });

    return () => {
      unsubQr();
      unsubHealth();
    };
  }, [instanceId]);

  useEffect(() => {
    if (!instanceId || !isOpen || realtimeState === 'connected') return undefined;

    const poll = (): void => {
      void linkStatus(instanceId).then((result) => {
        setState((prev) => ({
          ...prev,
          attemptsLeft: result.attemptsLeft,
          healthState: result.healthState,
          maskedNumber: result.maskedNumber,
        }));
      });
    };

    poll();
    const intervalId = setIntervalFn(poll, pollIntervalMs);
    return () => {
      clearIntervalFn(intervalId);
    };
  }, [instanceId, isOpen, realtimeState, pollIntervalMs, setIntervalFn, clearIntervalFn]);

  return state;
}
