import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * platform/http/sse.ts (P05 Unit U3a) - the low-level SSE wire primitive:
 * formats `id:`/`event:`/`data:` frames, keeps a bounded per-connection
 * queue so a slow/backpressured client can never grow an unbounded heap
 * buffer, and drives a heartbeat comment frame (`:hb`) on an injectable
 * timer so buffering proxies never see a dead-looking idle connection.
 *
 * "Buffering proxies silently break SSE" (phase risk, canon): every
 * connection sets `Content-Type: text/event-stream; charset=utf-8`,
 * `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`,
 * `Connection: keep-alive`, disables the socket timeout, and flushes
 * headers immediately via `reply.hijack()` (this module owns the raw
 * `reply.raw` write path from here on - nothing else may write to this
 * reply once `openSseStream` returns).
 */

export interface SseFrame {
  id: string;
  event: string;
  data: string;
}

export type SseCloseReason =
  | 'slow_consumer'
  | 'token_epoch'
  | 'membership_revoked'
  | 'client_suspended'
  | 'client_closed'
  | 'server_shutdown'
  | 'client_disconnect'
  | 'connection_cap'
  // P05 Unit U3b: the periodic authz re-check tick's own failure-budget
  // exhaustion reason (core invariant 2, fail-safe) - see
  // modules/realtime/authz-tick.ts's header comment. Unverifiable
  // authorisation must not persist indefinitely, but a single failed tick
  // must not drop everyone either - only the (SSE_AUTHZ_MAX_CONSECUTIVE_
  // FAILURES + 1)th consecutive failure does.
  | 'authz_unverifiable';

export interface SseClock {
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const DEFAULT_CLOCK: SseClock = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface OpenSseStreamOptions {
  heartbeatMs: number;
  maxBufferedFrames: number;
  clock?: SseClock;
}

export interface SseSink {
  /** Writes one event frame - queues under backpressure, drops the connection past `maxBufferedFrames`. */
  write: (frame: SseFrame) => void;
  /** Writes a `: <text>` comment frame (used for heartbeats and any other keep-alive comment). */
  comment: (text: string) => void;
  /** Closes the connection. Idempotent - a second call is a no-op. */
  close: (reason: SseCloseReason) => void;
  /** Registers a callback invoked exactly once when this connection closes, for any reason. */
  onClose: (cb: (reason: SseCloseReason) => void) => void;
}

function formatFrame(frame: SseFrame): string {
  // Per-line `data:` prefixing keeps a multi-line JSON payload (there is
  // none today - every event.data is a single-line JSON.stringify - but this
  // is the correct SSE framing regardless) from breaking the frame boundary.
  const dataLines = frame.data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `id: ${frame.id}\nevent: ${frame.event}\n${dataLines}\n\n`;
}

function formatComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Hijacks `reply`, writes the SSE response headers, and returns an `SseSink`
 * the caller writes frames to. The heartbeat timer and bounded queue are
 * both owned internally; the caller never touches `reply.raw` directly
 * after this returns.
 */
export function openSseStream(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: OpenSseStreamOptions,
): SseSink {
  const clock = opts.clock ?? DEFAULT_CLOCK;

  reply.hijack();
  const res = reply.raw;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  req.raw.socket.setTimeout(0);
  reply.raw.setTimeout?.(0);

  let closed = false;
  let draining = false;
  const queue: string[] = [];
  const closeCallbacks: Array<(reason: SseCloseReason) => void> = [];

  const heartbeatHandle = clock.setInterval(() => {
    sink.comment('hb');
  }, opts.heartbeatMs);

  function stopHeartbeat(): void {
    clock.clearInterval(heartbeatHandle);
  }

  function runClose(reason: SseCloseReason): void {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    queue.length = 0;
    for (const cb of closeCallbacks) {
      cb(reason);
    }
    try {
      res.end();
    } catch {
      // Socket may already be gone - closing is still successful.
    }
  }

  function flushQueue(): void {
    draining = false;
    while (queue.length > 0) {
      const chunk = queue[0]!;
      const ok = res.write(chunk);
      queue.shift();
      if (!ok) {
        draining = true;
        return;
      }
    }
  }

  res.on('drain', () => {
    if (closed) return;
    flushQueue();
  });

  req.raw.on('close', () => {
    runClose('client_disconnect');
  });

  function enqueue(chunk: string): void {
    if (closed) return;

    if (draining) {
      queue.push(chunk);
      if (queue.length > opts.maxBufferedFrames) {
        // Best-effort final hint frame before dropping - the socket may
        // already be unwritable, so this is not guaranteed to arrive.
        try {
          res.write(formatFrame({ id: '0', event: 'reconnect', data: '{}' }));
        } catch {
          // ignore - closing below regardless.
        }
        runClose('slow_consumer');
      }
      return;
    }

    const ok = res.write(chunk);
    if (!ok) {
      draining = true;
    }
  }

  const sink: SseSink = {
    write(frame) {
      enqueue(formatFrame(frame));
    },
    comment(text) {
      enqueue(formatComment(text));
    },
    close(reason) {
      runClose(reason);
    },
    onClose(cb) {
      closeCallbacks.push(cb);
    },
  };

  return sink;
}
