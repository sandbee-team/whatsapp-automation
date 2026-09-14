import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { createRealtimeHub } from '../hub.js';

/**
 * sse-log-redaction-test-support.ts (P05 Unit U3b) - shared fixture helpers
 * for sse-log-redaction.test.ts. NOT itself a test file (no `.test.ts`
 * suffix - vitest's `include` glob never picks it up). Split out purely to
 * keep the test file itself under the repo's max-lines guard.
 */

export function createCaptureStream(): {
  stream: Writable;
  lines: () => unknown[];
  raw: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    raw: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
}

interface CapturedFrame {
  event: string;
  data: string;
}

export function connectCapturingSink(
  hub: ReturnType<typeof createRealtimeHub>,
  input: { connectionId: string; userId: string; clientId: string; epoch: number },
): { frames: CapturedFrame[]; closeReasons: string[] } {
  const frames: CapturedFrame[] = [];
  const closeReasons: string[] = [];
  const closeCallbacks: Array<(reason: string) => void> = [];
  let closed = false;
  hub.connect({
    connectionId: input.connectionId,
    userId: input.userId,
    sessionId: randomUUID(),
    clientId: input.clientId,
    epoch: input.epoch,
    channels: [`client:${input.clientId}`],
    sink: {
      write: (frame) => {
        frames.push({ event: frame.event, data: frame.data });
      },
      comment: () => {},
      close: (reason) => {
        if (closed) return;
        closed = true;
        closeReasons.push(reason);
        for (const cb of closeCallbacks) cb(reason);
      },
      onClose: (cb) => {
        closeCallbacks.push(cb as (reason: string) => void);
      },
    },
  });
  return { frames, closeReasons };
}

const PHONE_PATTERN = /\+?91\d{10}/;
const WA_USER_JID_PATTERN = /@s\.whatsapp\.net/;
const WA_GROUP_JID_PATTERN = /@g\.us/;
const FORBIDDEN_KEY_PATTERNS = [/"body"/, /"phone"/, /"name"/, /"jid"/];

/** Asserts `haystack` contains no phone number, WhatsApp JID, or forbidden field-name substring. */
export function assertNoLeak(haystack: string): void {
  expect(haystack).not.toMatch(PHONE_PATTERN);
  expect(haystack).not.toMatch(WA_USER_JID_PATTERN);
  expect(haystack).not.toMatch(WA_GROUP_JID_PATTERN);
  for (const pattern of FORBIDDEN_KEY_PATTERNS) {
    expect(haystack).not.toMatch(pattern);
  }
}
