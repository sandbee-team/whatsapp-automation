import type { DropReason, SseFrameLike } from '../hub.js';
import type { SseSink } from '../../../platform/http/sse.js';

/**
 * hub-test-support.ts (P05 test-engineer hardening pass) - shared fake-sink
 * builder for hub.test.ts / hub-replay.test.ts. NOT itself a test file (no
 * `.test.ts` suffix).
 */

export function fakeSink(): { sink: SseSink; written: SseFrameLike[]; closedWith: DropReason[] } {
  const written: SseFrameLike[] = [];
  const closedWith: DropReason[] = [];
  const closeCallbacks: Array<(reason: DropReason) => void> = [];
  let closed = false;
  const sink: SseSink = {
    write: (frame) => {
      written.push(frame);
    },
    comment: () => {},
    close: (reason) => {
      if (closed) return;
      closed = true;
      closedWith.push(reason);
      for (const cb of closeCallbacks) cb(reason);
    },
    onClose: (cb) => {
      closeCallbacks.push(cb);
    },
  };
  return { sink, written, closedWith };
}
