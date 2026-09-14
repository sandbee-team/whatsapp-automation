/**
 * import-runner-failure-wrapping.ts (P20 C1 M1) - the two error-wrapping
 * primitives `import-runner.ts`'s per-client try/catch needs, split out
 * purely for that file's own max-lines cap (same split idiom as
 * `session-worker-discovery-wiring.ts`).
 *
 * `ClaimedBatchError` carries the claimed `importId` out of a failed batch
 * transaction, so the sweep's outer catch can mark THAT import failed
 * without re-claiming (the batch tx itself has already rolled back by the
 * time this is caught).
 *
 * `InjectedTestCrashError`/`callHookOrThrowInjectedCrash` mark an error as
 * originating from a TEST-ONLY crash-injection hook (`hooks.onBeforeCommit`/
 * `onRecord`) rather than real production work. `hooks` exist ONLY to
 * simulate "the process died mid-batch" for crash/idempotency tests
 * (`import-runner.ts`'s own module doc) - a REAL process crash is never
 * caught by any try/catch at all, so M1's per-client failure classification
 * must never treat a hook's synchronous throw as a permanent business
 * failure (`unexpected_error`) the way it would a genuine `objectStore`/
 * parse/DB fault. Rethrown UNCLASSIFIED by the sweep's outer catch,
 * propagating to the caller exactly as it did before M1 - `sweepUntilDone`'s
 * own test-only catch is what "restarts the process" in these tests.
 */

export class ClaimedBatchError extends Error {
  readonly importId: string;
  readonly cause: unknown;
  constructor(importId: string, cause: unknown) {
    super('processOneClientBatch failed after claiming an import');
    this.name = 'ClaimedBatchError';
    this.importId = importId;
    this.cause = cause;
  }
}

export class InjectedTestCrashError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super('a test-only crash-injection hook threw');
    this.name = 'InjectedTestCrashError';
    this.original = original;
  }
}

export async function callHookOrThrowInjectedCrash<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new InjectedTestCrashError(err);
  }
}
