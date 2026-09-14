import { useEffect, useRef, useState } from 'react';
import type { HealthStateContract } from '@wp/contracts';
import { subscribeRealtimeEvent } from '../../../lib/sse.js';
import { linkStatus } from '../api.js';

/**
 * useLinkStream (P08 U7) - live state for the Connect sheet's challenge
 * panel. Subscribes `instance.qr` (payload/expiresAt/attemptsLeft) and
 * `instance.health_changed` (healthState) for THIS instance only via the
 * typed `subscribeRealtimeEvent` registry. While the sheet is open, this
 * ALSO polls `GET /link-status` every `pollIntervalMs` (default 5000) as a
 * fallback for the case the SSE stream itself is not `'connected'` (a
 * disconnected/reconnecting realtime stream must never leave the panel
 * silently stale) - polling stops the moment the sheet closes or the
 * connection reports `'connected'`.
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
