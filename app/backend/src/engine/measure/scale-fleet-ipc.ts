import type { ChildProcess } from 'node:child_process';
import {
  parseChildMessage,
  type ChildMessage,
  type ParentMessage,
} from '../../../../../scripts/measure/scale-fleet.js';

/**
 * scale-fleet-ipc.ts (P26 U2a split) - the raw parent<->child IPC primitives
 * (`sendTo`/`waitForMessage`), mechanically extracted out of `scale-fleet.ts`
 * purely for that file's own max-lines cap. Pure code motion: same
 * "real child process, real IPC, never an in-process fake" model documented
 * in `scale-fleet.ts`'s own header - see that file for the full rationale.
 */

export function sendTo(child: ChildProcess, message: ParentMessage): void {
  child.send(message as unknown as Record<string, unknown>);
}

/** Waits for a single matching `ChildMessage` (by predicate) from `child`, up to `timeoutMs`. Rejects (never hangs) on timeout, naming both the worker and the operation (`what`) it was waiting for - a timeout that names neither is ambiguous at fleet scale (see `scale-fleet.ts`'s own header). */
export function waitForMessage<T extends ChildMessage>(
  child: ChildProcess,
  predicate: (msg: ChildMessage) => msg is T,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(
        new Error(`waitForMessage: timed out after ${String(timeoutMs)}ms waiting for ${what}`),
      );
    }, timeoutMs);
    function onMessage(raw: unknown): void {
      const parsed = parseChildMessage(raw);
      if (parsed && predicate(parsed)) {
        clearTimeout(timer);
        child.off('message', onMessage);
        resolvePromise(parsed);
      }
    }
    child.on('message', onMessage);
  });
}

/**
 * Forwards a child's stdout/stderr to the PARENT's stderr, prefixed with the
 * worker id. Without this a child that throws inside `reconcile()`, fails a
 * claim, or crashes on start is completely silent - the parent only ever saw
 * a bare IPC timeout (P26 run log #9). Diagnosability, not a protocol change.
 */
export function forwardChildOutput(
  proc: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null },
  workerId: string,
): void {
  const forward = (chunk: Buffer | string): void => {
    process.stderr.write(`[${workerId}] ${chunk.toString()}`);
  };
  proc.stdout?.on('data', forward);
  proc.stderr?.on('data', forward);
}
