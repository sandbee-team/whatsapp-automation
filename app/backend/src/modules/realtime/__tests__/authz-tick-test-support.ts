import { randomUUID } from 'node:crypto';
import type { createRealtimeHub, DropReason } from '../hub.js';

/**
 * authz-tick-test-support.ts (P05 test-engineer hardening pass) - shared
 * fake-sink connector for authz-tick.test.ts / authz-tick-clock.test.ts /
 * sse-revocation.test.ts. NOT itself a test file (no `.test.ts` suffix).
 */

export interface FakeSink {
  closed: boolean;
  closeReason: DropReason | undefined;
}

export function connectFakeSink(
  hub: ReturnType<typeof createRealtimeHub>,
  input: { connectionId: string; userId: string; clientId: string; epoch: number },
): FakeSink {
  const sink: FakeSink = { closed: false, closeReason: undefined };
  const closeCallbacks: Array<(reason: DropReason) => void> = [];
  hub.connect({
    connectionId: input.connectionId,
    userId: input.userId,
    sessionId: randomUUID(),
    clientId: input.clientId,
    epoch: input.epoch,
    channels: [`client:${input.clientId}`],
    sink: {
      write: () => {},
      comment: () => {},
      close: (reason) => {
        if (sink.closed) return;
        sink.closed = true;
        sink.closeReason = reason;
        for (const cb of closeCallbacks) cb(reason);
      },
      onClose: (cb) => {
        closeCallbacks.push(cb);
      },
    },
  });
  return sink;
}
