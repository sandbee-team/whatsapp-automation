import { PassThrough } from 'node:stream';
import type { ObjectStore } from '../../../platform/storage/object-store.js';
import type { runOneContactImportSweep } from '../import-runner.js';

/**
 * import-test-support-metrics.ts (P20 Unit U5, step 6) - the metrics-stub
 * and byte-counting-store fixture halves of `import-test-support.ts`, split
 * out purely for that file's own max-lines cap. Same `__tests__/` placement
 * reasoning as its sibling (tenant-scope guard exemption, never picked up
 * as its own vitest suite).
 */

/** A no-op metrics stub for tests that don't assert on metric increments. */
export function noOpMetrics(): Parameters<typeof runOneContactImportSweep>[0]['metrics'] {
  return {
    contactsImportedTotal: { inc: () => undefined } as never,
    contactImportRowsTotal: { inc: () => undefined } as never,
    optoutMirrorDriftTotal: { inc: () => undefined } as never,
  };
}

/** A recording metrics stub - counts `.inc()` calls by their label value. */
export function recordingMetrics(): {
  metrics: Parameters<typeof runOneContactImportSweep>[0]['metrics'];
  countsByResult: Map<string, number>;
} {
  const countsByResult = new Map<string, number>();
  function inc(labels?: Record<string, string>): void {
    const key = labels?.result ?? '(none)';
    countsByResult.set(key, (countsByResult.get(key) ?? 0) + 1);
  }
  return {
    metrics: {
      contactsImportedTotal: { inc } as never,
      contactImportRowsTotal: { inc } as never,
      optoutMirrorDriftTotal: { inc: () => undefined } as never,
    },
    countsByResult,
  };
}

/** Wraps an `ObjectStore` so `getStream` returns a byte-counting pass-through - proves bounded memory without asserting on ambient `process.memoryUsage()` (an INJECTED measurement, never a live-process read). */
export function wrapCountingStore(inner: ObjectStore): {
  store: ObjectStore;
  reset: () => void;
  bytesReadLastSweep: () => number;
  totalBytes: () => number;
} {
  let bytesThisSweep = 0;
  let totalBytes = 0;
  const store: ObjectStore = {
    ...inner,
    async getStream(key: string) {
      const original = await inner.getStream(key);
      const counting = new PassThrough();
      // Counting happens ONLY on `counting`'s own 'data' event (i.e. bytes
      // actually consumed downstream through the pipe), never on
      // `original` directly: attaching a plain listener straight to
      // `original` would put IT into flowing mode independent of
      // backpressure, so it would read the ENTIRE rest of the file to EOF
      // in the background regardless of whether the batch reader destroyed
      // `counting` early - exactly the "file materialised" failure this
      // wrapper exists to detect, silently defeated by the wrapper itself.
      counting.on('data', (chunk: Buffer) => {
        bytesThisSweep += chunk.length;
      });
      // Destroying the returned (wrapped) stream MUST stop `original`
      // synchronously too, or it keeps flowing and its still-buffered
      // chunks land in a LATER sweep's reset counter instead of the sweep
      // that actually requested them.
      counting.once('close', () => {
        original.destroy();
      });
      original.pipe(counting);
      return counting;
    },
    async put(input) {
      const result = await inner.put(input);
      totalBytes = result.bytes;
      return result;
    },
  };
  return {
    store,
    reset: () => {
      bytesThisSweep = 0;
    },
    bytesReadLastSweep: () => bytesThisSweep,
    totalBytes: () => totalBytes,
  };
}
