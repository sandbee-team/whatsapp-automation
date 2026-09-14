/**
 * vitest-setup-env.ts - wired as `setupFiles` in `vitest.base.ts`, so it runs
 * BEFORE any test module is imported, in every project that uses `withBase`.
 *
 * Why this exists (P10, 2026-09-01 - cost a full CI gate round):
 * `@wp/server-kit`'s `config` singleton parses `process.env` exactly ONCE, at
 * first import anywhere in the process. The ROOT vitest project claims every
 * app-project unit test under `src` but set no `WP_*` vars, while only
 * `app/backend/vitest.config.ts` (which takes integration tests ONLY) did.
 * So any app-backend UNIT test whose import chain reached `@wp/server-kit`
 * failed the whole SUITE load with:
 *   ConfigError: Invalid or missing config env var(s): WP_ENV, WP_LOG_LEVEL,
 *   WP_KEY_RING_PATH, WP_KEK_PURPOSES, WP_ENC_VERSION
 *
 * The pre-existing workaround was a per-file first-import of
 * `app/backend/src/modules/realtime/__test-support__/stub-wp-server-kit-env.ts`
 * - correct, but ORDER-DEPENDENT and enforced by nothing: no eslint rule, no
 * CI guard, no setup file. A convention no tool can enforce gets broken again
 * (it was, in P10). A setupFile cannot be forgotten, so this retires the whole
 * class rather than the one instance.
 *
 * `??=` throughout: a real value already in the environment always wins, so
 * this never overrides a deliberate per-suite override or a real dev/CI value.
 * These are TEST defaults only - never production values, and the key-ring path
 * is a placeholder string, not a secret.
 *
 * The per-file stub import stays valid and harmless (same `??=` semantics); it
 * simply stops being load-bearing. New tests do not need it.
 */
process.env.WP_ENV ??= 'test';
process.env.WP_LOG_LEVEL ??= 'info';
process.env.WP_KEY_RING_PATH ??= 'test-key-ring-path-not-a-real-secret';
process.env.WP_KEK_PURPOSES ??= 'session';
process.env.WP_ENC_VERSION ??= '1';
