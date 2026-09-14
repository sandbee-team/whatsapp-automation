/**
 * stub-wp-server-kit-env.ts (P28 Unit U4, step 6) - `@wp/server-kit`'s
 * `config` singleton parses `process.env` exactly once, at first import,
 * anywhere in the process (see packages/server-kit/src/config/index.ts's own
 * doc comment). The ROOT Vitest project (which runs the admin unit-test globs)
 * sets no `WP_*` env at all, so any admin-backend UNIT test whose import
 * chain reaches `@wp/server-kit` fails to LOAD with `ConfigError` without
 * this. Copied from app-backend's own
 * `modules/realtime/__test-support__/stub-wp-server-kit-env.ts` - a
 * cross-project import of that file is forbidden (dependency-cruiser
 * `no-cross-project-admin-to-app`), so this is a deliberate per-project copy,
 * not duplication that could have been shared.
 *
 * This file has NO imports of its own, so ESM's depth-first left-to-right
 * evaluation order guarantees it runs, and sets these vars, before any
 * sibling import that transitively pulls in `@wp/server-kit` begins
 * evaluating - as long as this is the FIRST import in the importing test file.
 * Test-only placeholder values, never read as real secrets.
 */
process.env.WP_ENV ??= 'test';
process.env.WP_LOG_LEVEL ??= 'info';
process.env.WP_KEY_RING_PATH ??= 'test-key-ring-path-not-a-real-secret';
process.env.WP_KEK_PURPOSES ??= 'session';
process.env.WP_ENC_VERSION ??= '1';
