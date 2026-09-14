/**
 * stub-wp-server-kit-env.ts (P05 Unit U3a) - `@wp/server-kit`'s `config`
 * singleton parses `process.env` exactly once, at first import, anywhere in
 * the process (see packages/server-kit/src/config/index.ts's doc comment).
 * No app-backend code has wired `@wp/server-kit`'s config/logger before this
 * unit, so the root Vitest project has no `WP_ENV`/`WP_LOG_LEVEL`/etc test
 * defaults yet - out of this unit's file scope to add (root vitest.config.ts
 * belongs to a parallel unit). This file has NO imports of its own, so ESM's
 * depth-first left-to-right evaluation order guarantees it runs, and sets
 * these vars, before any sibling import that transitively pulls in
 * `@wp/server-kit` begins evaluating - as long as this is the FIRST import
 * in the importing test file.
 */
process.env.WP_ENV ??= 'test';
process.env.WP_LOG_LEVEL ??= 'info';
process.env.WP_KEY_RING_PATH ??= 'test-key-ring-path-not-a-real-secret';
process.env.WP_KEK_PURPOSES ??= 'session';
process.env.WP_ENC_VERSION ??= '1';
