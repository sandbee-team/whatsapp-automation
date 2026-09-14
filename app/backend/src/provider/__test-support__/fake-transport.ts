import type {
  MessageTransport,
  SendOutcome,
  TransportCapabilities,
  WaMessagePayload,
} from '../provider.types.js';
import { TransportSendError, type SendErrorClass } from '../provider.types.js';

/**
 * fake-transport.ts (P11 Unit U2, step 4) - a controllable `MessageTransport`
 * used by every P11 test. Two latency modes, chosen per call via `mode`:
 *
 *   - `'fake-timer'` (default, and the one almost every test should use):
 *     `send()` schedules its resolution/rejection with `setTimeout`, so the
 *     CALLER drives time with vitest's fake timers (`vi.useFakeTimers()` +
 *     `vi.advanceTimersByTimeAsync`). No real sleeping ever happens in this
 *     mode - it exists so tests asserting the 45s send-timeout boundary (or
 *     any other latency) run in milliseconds of wall clock.
 *   - `'real-latency'`: `send()` uses a real `setTimeout` untouched by fake
 *     timers, for the rare test that must prove behaviour against the ACTUAL
 *     passage of time (e.g. a 90s slow-media soak test) - opt in per queued
 *     outcome, never the suite default.
 *
 * `queueOutcome`/`queueNeverResolves` register ONE outcome each; `send()`
 * consumes them in FIFO order (falls back to a default success if the queue
 * is empty, so simple tests need not queue anything). `onSend` fires
 * SYNCHRONOUSLY at call time, before any timer is scheduled, so a caller can
 * observe DB/attempt-row state at the exact instant the provider was
 * "called" - the hook `an_attempt_row_exists_before_the_provider_is_called`
 * (a later unit) needs.
 */

export type FakeTransportMode = 'fake-timer' | 'real-latency';

export type QueuedOutcome =
  | { kind: 'resolve'; delayMs: number; providerMsgId: string; mode?: FakeTransportMode }
  | {
      kind: 'reject';
      delayMs: number;
      sendErrorClass: SendErrorClass;
      retryAfterMs?: number;
      mode?: FakeTransportMode;
    }
  | { kind: 'never' };

export interface RecordedSendCall {
  readonly instanceId: string;
  readonly msg: WaMessagePayload;
  readonly callIndex: number;
}

const DEFAULT_CAPABILITIES: TransportCapabilities = Object.freeze({
  kinds: ['text', 'image', 'document'] as const,
  groups: true,
  maxMediaBytes: 16 * 1024 * 1024,
  requiresOptIn: false,
});

export interface FakeTransport extends MessageTransport {
  /** Queue one outcome for the NEXT `send()` call (FIFO). */
  queueOutcome(outcome: QueuedOutcome): void;
  /** Convenience: queue a resolve. */
  queueResolve(delayMs: number, providerMsgId: string, mode?: FakeTransportMode): void;
  /** Convenience: queue a reject. */
  queueReject(
    delayMs: number,
    sendErrorClass: SendErrorClass,
    retryAfterMs?: number,
    mode?: FakeTransportMode,
  ): void;
  /** Convenience: queue a call that never resolves or rejects. */
  queueNeverResolves(): void;
  /** Set the value `isReady()` returns for a given instance (default: true). */
  setReady(instanceId: string, ready: boolean): void;
  /** All recorded calls, in order, across the transport's lifetime. */
  readonly calls: readonly RecordedSendCall[];
  /** Fires synchronously at call time, before any timer is scheduled. */
  onSend?: (call: RecordedSendCall) => void;
}

export interface CreateFakeTransportOptions {
  onSend?: (call: RecordedSendCall) => void;
  capabilities?: Partial<TransportCapabilities>;
}

const DEFAULT_OUTCOME: QueuedOutcome = {
  kind: 'resolve',
  delayMs: 0,
  providerMsgId: 'default-msg-id',
};

export function createFakeTransport(options: CreateFakeTransportOptions = {}): FakeTransport {
  const queue: QueuedOutcome[] = [];
  const calls: RecordedSendCall[] = [];
  const readiness = new Map<string, boolean>();
  let callCounter = 0;

  function runOutcome(outcome: QueuedOutcome): Promise<SendOutcome> {
    if (outcome.kind === 'never') {
      return new Promise<SendOutcome>(() => {
        // Deliberately never settles - exercises the caller's own timeout.
      });
    }
    const useRealTimer = outcome.mode === 'real-latency';
    const schedule = useRealTimer ? globalThis.setTimeout : setTimeout;
    return new Promise<SendOutcome>((resolve, reject) => {
      schedule(() => {
        if (outcome.kind === 'resolve') {
          resolve({ providerMsgId: outcome.providerMsgId });
        } else {
          reject(
            new TransportSendError(
              outcome.sendErrorClass,
              'fake transport rejection',
              outcome.retryAfterMs,
            ),
          );
        }
      }, outcome.delayMs);
    });
  }

  const transport: FakeTransport = {
    kind: 'fake',
    capabilities: Object.freeze({ ...DEFAULT_CAPABILITIES, ...options.capabilities }),
    onSend: options.onSend,
    calls,

    async send(instanceId, msg) {
      const call: RecordedSendCall = { instanceId, msg, callIndex: callCounter };
      callCounter += 1;
      calls.push(call);
      transport.onSend?.(call);
      const outcome = queue.shift() ?? DEFAULT_OUTCOME;
      return runOutcome(outcome);
    },

    isReady(instanceId) {
      return readiness.get(instanceId) ?? true;
    },

    queueOutcome(outcome) {
      queue.push(outcome);
    },

    queueResolve(delayMs, providerMsgId, mode) {
      queue.push({ kind: 'resolve', delayMs, providerMsgId, mode });
    },

    queueReject(delayMs, sendErrorClass, retryAfterMs, mode) {
      queue.push({ kind: 'reject', delayMs, sendErrorClass, retryAfterMs, mode });
    },

    queueNeverResolves() {
      queue.push({ kind: 'never' });
    },

    setReady(instanceId, ready) {
      readiness.set(instanceId, ready);
    },
  };

  return transport;
}
