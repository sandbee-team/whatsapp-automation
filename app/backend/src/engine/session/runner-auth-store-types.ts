/**
 * runner-auth-store-types.ts (FIX-A, P26 C1 review split) - the auth-store-
 * facing subset of runner-types.ts's injected-dependency surface
 * (`buildAuthStore`'s identity/ports/result shapes, the runner-facing
 * `AuthStoreLike`/`CredsSaveBufferPort`), split out purely to keep
 * runner-types.ts under the workspace's max-lines cap. Re-exported from
 * runner-types.ts so every existing import path keeps working unchanged.
 */

export interface AuthStoreIdentityLike {
  instanceId: string;
  clientId: string;
  sessionEpoch: number;
  fence: bigint;
  env: string;
  workerId: string;
}

export interface AuthStorePortsLike {
  onFenceConflict(info: {
    instanceId: string;
    cause: 'fence_conflict' | 'epoch_conflict';
  }): Promise<void>;
  onSignalWriteFailure(info: { instanceId: string; error: Error }): Promise<void>;
  releaseLease(): Promise<void>;
  /** FIX-A (P26 C1 review): the creds-save buffer's `onError` port, routed to `runner-creds-update.ts#onCredsFlushError` - see that function's doc. */
  onCredsSaveBufferError(err: unknown): void;
  /** FIX-P26-G - reads the runner's CURRENT `state.credVersion`, wired straight through to `CredsSaveBufferPorts.readExpectedVersion` so a flush (including the retry timer's own) always targets the LIVE version, never one snapshotted at enqueue time. */
  readCredVersion(): bigint;
  /** FIX-P26-G - the creds-save buffer's `onFlushed` port: called with the resolved `credVersion` after ANY successful flush, so the runner can advance `state.credVersion` even when the flush was driven by the buffer's own retry timer rather than a live `save()` call. */
  onCredsSaveBufferFlushed(credVersion: bigint): void;
}

export interface AuthStoreLike {
  loadCreds(): Promise<unknown | null>;
  /** FIX-A (P26 C1 review): resolves the store's new `cred_version` - the caller's NEXT `expectedVersion` source (never `sessionEpoch`). */
  saveCreds(args: {
    creds: unknown;
    expectedVersion: bigint | number;
    fence: bigint | number;
  }): Promise<{ credVersion: bigint }>;
  /** FIX-A: see `EncryptedAuthStore.currentCredVersion` doc. Optional - an omitting fake falls back to the `0n` sentinel. */
  currentCredVersion?(): Promise<bigint>;
  purge(fence: bigint | number): Promise<{ purged: boolean }>;
}

/**
 * The `CredsSaveBuffer` port shape `runner.ts` needs - mirrors
 * `creds-save-buffer.ts#CredsSaveBuffer` minus `size`/`dropped`
 * (observability-only, not needed by the runner itself). `unavailable()`
 * (FIX-A, MAJOR 6) tells `teardown()` whether PG is already known-down, so a
 * bounded drain skips a flush attempt guaranteed to fail rather than
 * spending its budget on it.
 *
 * FIX-P26-G: `save()` resolves `{ credVersion: bigint } | undefined` -
 * `undefined` means this call only buffered the entry (PG unavailable, or
 * already buffering), so nothing was actually persisted and there is no new
 * version for the caller to advance `state.credVersion` to; a real
 * passthrough save resolves the store's freshly-written version. `flush()`'s
 * `FlushResult.credVersion` is set exactly when `applied: true`, for the
 * same reason.
 */
export interface CredsSaveBufferPort {
  save(args: {
    creds: unknown;
    expectedVersion: bigint;
    fence: bigint;
  }): Promise<{ credVersion: bigint } | undefined>;
  flush(): Promise<{ applied: boolean; remaining: number; credVersion?: bigint }>;
  unavailable(): boolean;
  dispose(): void;
}

export interface BuildAuthStoreResult {
  store: AuthStoreLike;
  signalKeyStore: unknown;
  /** Optional (P26 U6a) - one `CredsSaveBuffer` bound to THIS `store`, built by `buildAuthStore` alongside it. When present, `runner.ts` routes the real `'creds.update'` event through `save(...)` and best-effort flushes + disposes it on teardown. Omitted means no listener is registered (fail-safe default). */
  credsSaveBuffer?: CredsSaveBufferPort;
}

export type BuildAuthStoreFn = (
  identity: AuthStoreIdentityLike,
  ports: AuthStorePortsLike,
) => BuildAuthStoreResult;
