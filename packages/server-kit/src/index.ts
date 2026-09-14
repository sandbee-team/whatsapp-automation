/**
 * @wp/server-kit - Node-only base services both backends reuse: config
 * loader, logger, error types + mapper, tenant context, metrics/tracing,
 * cache, rate limiter, storage, audit writer, queue client, event bus,
 * notifier, feature flags, envelope crypto. Never imported by a frontend.
 *
 * Each module also has its own exports subpath (see package.json `exports`)
 * so consumers can import `@wp/server-kit/tenant` etc. directly without a
 * deep import into `src/`; this barrel re-exports the same surface for
 * consumers that want everything from one specifier.
 */
export const packageName = '@wp/server-kit' as const;

export * from './tenant/index.js';
export * from './config/index.js';
export * from './obs/index.js';
export * from './errors/index.js';
export * from './crypto/index.js';
export * from './auth/index.js';
