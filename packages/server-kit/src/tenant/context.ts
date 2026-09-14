import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `role` is `string` here rather than a narrower union: `@wp/domain` does not
 * (yet) export a `Role` type, and this package must not add one on its
 * behalf. P04 (auth) is expected to narrow this to a real `Role` union once
 * that type exists.
 */
export type TenantContext = {
  clientId: string;
  actorId: string;
  actorType: 'user' | 'staff' | 'system';
  role: string;
  requestId: string;
  traceId: string;
};

/**
 * Thrown by `currentTenant()` when called outside `runInTenant()`.
 *
 * Core invariant 4 (tenant isolation): there is no default client id, so a
 * missing context is a hard failure rather than a silent "all tenants" fan
 * out. `code` mirrors the shape of the `AppError` hierarchy P01 step 5 builds
 * in `src/errors/**`, but is declared locally here to avoid a cross-step
 * import while both are in flight - a follow-up step may unify the two.
 */
export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING' as const;

  constructor() {
    super('currentTenant() called outside runInTenant() - no tenant context is set');
    this.name = 'TenantContextMissingError';
  }
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with `ctx` bound as the ambient tenant context for the lifetime
 * of `fn`'s async execution (including anything it awaits), via
 * `node:async_hooks` `AsyncLocalStorage`. Concurrent calls with different
 * contexts never bleed into each other, even when interleaved.
 *
 * The `SET LOCAL app.client_id` half (binding this context to a Postgres
 * session) belongs to `withTenant`/`TenantDb` in P02 - not built here.
 *
 * The stored context is a frozen shallow copy of `ctx`, never the caller's
 * own object reference: a caller that mutates its original `ctx` object
 * after starting `runInTenant` must never be able to change what a
 * concurrently-running `currentTenant()` call sees (core invariant 4 -
 * tenant isolation must not depend on a caller never mutating its context
 * object).
 */
export function runInTenant<T>(ctx: TenantContext, fn: () => T | Promise<T>): Promise<T> {
  return storage.run(Object.freeze({ ...ctx }), async () => fn());
}

/**
 * Reads the ambient tenant context set by the nearest enclosing
 * `runInTenant()` call. Throws `TenantContextMissingError` if called outside
 * one - there is no default client id (core invariant 4).
 */
export function currentTenant(): TenantContext {
  const ctx = storage.getStore();
  if (ctx === undefined) {
    throw new TenantContextMissingError();
  }
  return ctx;
}
