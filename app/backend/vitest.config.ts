import { defineConfig } from 'vitest/config';
import { withBase } from '../../packages/config/vitest.base.js';

/**
 * `app-backend`'s own Vitest project config (P03 Unit B, step 6) - mirrors
 * `db/vitest.config.ts`. `src/**\/*.integration.test.ts` (and, from P25 U7,
 * `test/**\/*.integration.test.ts` for cross-module security/observability
 * suites that don't belong under any one `src/` module) files hit a real
 * Postgres (see `src/platform/db/db-url.ts`), so they are excluded from the
 * root unit config (`vitest.config.ts`'s `exclude` list) and run only via
 * `pnpm -F app-backend run test:int`, which the root `test:int` chains after
 * `@wp/db`'s suite - so the CI gate's `integration` step covers the claim
 * tests (wired 2026-08-26 during P03 close; they were previously outside
 * the gate). `fileParallelism: false` + a generous timeout follow
 * `@wp/db`'s own precedent for real-Postgres round-trips.
 *
 * `test.env` (P05 Unit U3a): `@wp/server-kit`'s `config`/`logger` singletons
 * parse `process.env` once, at first import, anywhere in the process (see
 * packages/server-kit/src/config/index.ts's doc comment) - `modules/realtime`
 * is the first app-backend code to import `@wp/server-kit`, and `buildApp`
 * now always wires a `realtime` dep, so every integration test that boots
 * the real app (tenancy-routes-test-support.ts's `buildTenancyApp`) needs
 * these set. Test-only placeholder values - never read as real secrets.
 */
export default defineConfig(
  withBase({
    test: {
      include: ['src/**/*.integration.test.ts', 'test/**/*.integration.test.ts'],
      environment: 'node',
      fileParallelism: false,
      testTimeout: 30000,
      env: {
        WP_ENV: 'test',
        WP_LOG_LEVEL: 'info',
        WP_KEY_RING_PATH: 'test-key-ring-path-not-a-real-secret',
        WP_KEK_PURPOSES: 'session',
        WP_ENC_VERSION: '1',
      },
    },
  }),
);
